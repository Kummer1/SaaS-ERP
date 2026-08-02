// ============================================================================
// MOCK — this is NOT the real Tiny ERP OAuth server. It simulates Tiny's
// /auth endpoint (the "user logs in and approves" step) with zero UI, so the
// real tiny-oauth-authorize/tiny-oauth-callback functions can be proven
// end-to-end without a real Tiny client_id/client_secret.
//
// quick-260802-oauth-mock: this function (and tiny-mock-token) exist purely
// to unblock development while a real Tiny app registration is pending (see
// .planning/quick/260802-oauth-mock/). Reaching "Fase 3 really done" still
// requires re-running this same flow against the real Tiny OAuth server —
// see docs/03-INTEGRACAO-TINY-ERP.md §1 for the real endpoint contract this
// mock approximates.
//
// GET ?response_type=code&client_id=...&redirect_uri=...&state=...
//   -> 302 redirect to `${redirect_uri}?code=<fake-code>&state=<state>`
//   Missing/invalid params -> 400 JSON error (no redirect attempted, since
//   redirect_uri itself may not be trustworthy at that point).
//
// verify_jwt = false (supabase/config.toml): this endpoint plays the role of
// an external OAuth provider — a real Tiny server obviously never carries our
// Supabase Auth JWT, so requiring one here would make the mock diverge from
// the thing it's simulating.
import { sql } from "../_shared/db.ts";

const CODE_TTL_MS = 2 * 60 * 1000; // short-lived, mirrors real auth-code TTLs

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const responseType = url.searchParams.get("response_type");
  const clientId = url.searchParams.get("client_id");
  const redirectUri = url.searchParams.get("redirect_uri");
  const state = url.searchParams.get("state");

  if (responseType !== "code") {
    return jsonError("unsupported_response_type", 400);
  }
  if (!clientId) {
    return jsonError("invalid_request: client_id is required", 400);
  }
  if (!state) {
    return jsonError("invalid_request: state is required", 400);
  }
  if (!redirectUri || !isValidRedirectUri(redirectUri)) {
    return jsonError("invalid_request: redirect_uri is missing or malformed", 400);
  }

  const code = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString();

  try {
    await sql`
      insert into tiny_oauth_mock_codes (code, client_id, redirect_uri, state, expires_at)
      values (${code}, ${clientId}, ${redirectUri}, ${state}, ${expiresAt})
    `;
  } catch (err) {
    console.error("tiny-mock-authorize: failed to persist mock code", err);
    return jsonError("server_error", 500);
  }

  const location = new URL(redirectUri);
  location.searchParams.set("code", code);
  location.searchParams.set("state", state);

  return new Response(null, {
    status: 302,
    headers: { Location: location.toString() },
  });
});

function isValidRedirectUri(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function jsonError(error: string, status: number): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
