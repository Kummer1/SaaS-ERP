// ============================================================================
// MOCK — this is NOT the real Tiny ERP OAuth server. It simulates Tiny's
// /token endpoint (authorization_code -> access_token/refresh_token exchange).
// See tiny-mock-authorize/index.ts for the matching authorize-side mock and
// the disclaimer about what this does and doesn't prove
// (.planning/quick/260802-oauth-mock/).
//
// POST grant_type=authorization_code&code=...&client_id=...&client_secret=...&redirect_uri=...
// (application/x-www-form-urlencoded or application/json)
//   -> 200 { access_token, refresh_token, expires_in, token_type } on success
//   -> 400 { error: "invalid_grant" | "invalid_request" | "unsupported_grant_type" }
//
// The single-use check is atomic (UPDATE ... WHERE used = false RETURNING *)
// so a reused code always fails here, proving reuse can't slip through a
// race between two callback attempts.
//
// verify_jwt = false (supabase/config.toml) — same rationale as
// tiny-mock-authorize: this plays an external OAuth provider, which never
// carries our Supabase Auth JWT.
import { sql } from "../_shared/db.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return jsonError("method_not_allowed", 405);
  }

  const params = await parseBody(req);
  if (!params) {
    return jsonError("invalid_request: could not parse request body", 400);
  }

  const grantType = params.get("grant_type");
  const code = params.get("code");
  const clientId = params.get("client_id");
  const clientSecret = params.get("client_secret");
  const redirectUri = params.get("redirect_uri");

  if (grantType !== "authorization_code") {
    return jsonError("unsupported_grant_type", 400);
  }
  if (!code || !clientId || !clientSecret || !redirectUri) {
    return jsonError(
      "invalid_request: code, client_id, client_secret, redirect_uri are all required",
      400,
    );
  }

  let row;
  try {
    // Atomic claim: only a code that is still unused and unexpired flips to
    // used = true. A concurrent or repeated exchange of the same code loses
    // this race and gets zero rows back — that's the "reuse fails" guarantee.
    const rows = await sql`
      update tiny_oauth_mock_codes
      set used = true
      where code = ${code}
        and used = false
        and expires_at > now()
      returning client_id, redirect_uri
    `;
    row = rows[0];
  } catch (err) {
    console.error("tiny-mock-token: code claim query failed", err);
    return jsonError("server_error", 500);
  }

  if (!row) {
    return jsonError("invalid_grant", 400);
  }
  if (row.client_id !== clientId || row.redirect_uri !== redirectUri) {
    return jsonError("invalid_grant", 400);
  }

  return new Response(
    JSON.stringify({
      access_token: `mock_at_${crypto.randomUUID()}`,
      refresh_token: `mock_rt_${crypto.randomUUID()}`,
      expires_in: 3600,
      token_type: "Bearer",
    }),
    { headers: { "Content-Type": "application/json" } },
  );
});

async function parseBody(req: Request): Promise<URLSearchParams | null> {
  const contentType = req.headers.get("content-type") ?? "";
  try {
    if (contentType.includes("application/json")) {
      const body = await req.json();
      return new URLSearchParams(
        Object.entries(body).map(([k, v]) => [k, String(v)]),
      );
    }
    // Default: application/x-www-form-urlencoded, per OAuth2 spec.
    const text = await req.text();
    return new URLSearchParams(text);
  } catch {
    return null;
  }
}

function jsonError(error: string, status: number): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
