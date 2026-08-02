// Real Tiny ERP OAuth2 connect flow — step 2 (callback).
//
// GET ?code=...&state=...
//   -> 200 { status: "connected", tenant_id } on success
//   -> 400 { error: "invalid_state" | "invalid_request" | "token_exchange_failed" }
//
// This is a public OAuth redirect target by construction: the browser lands
// here straight from Tiny's server with only `code` and `state` in the query
// string — there is no Supabase Auth JWT to check (same reasoning as any
// OAuth2 callback endpoint; verify_jwt = false in supabase/config.toml).
// Security here is entirely: (1) `state` must match a still-pending,
// unexpired, unconsumed row we created in tiny-oauth-authorize (anti-CSRF —
// proves this callback corresponds to a connection attempt we actually
// started), and (2) the state row is consumed atomically so a repeated/raced
// callback for the same state can't be processed twice.
//
// Token exchange target is TINY_OAUTH_TOKEN_URL (env, never hardcoded — see
// tiny-oauth-authorize/index.ts for the matching TINY_OAUTH_AUTHORIZE_URL
// rationale). access_token/refresh_token are encrypted via Supabase Vault
// before ever reaching tiny_credentials, same as client_secret
// (.planning/PROJECT.md Key Decisions: Vault, not Fernet).
//
// quick-260802-oauth-mock scope note: on reconnect (tenant already has a
// tiny_credentials row), this creates fresh Vault secrets and overwrites the
// old references rather than rotating the existing secret IDs in place —
// acceptable for validating the mock flow, but it orphans the previous
// secrets in vault.secrets. Rotate-in-place cleanup is deferred, not
// silently assumed solved — see .planning/quick/260802-oauth-mock/.
import { sql } from "../_shared/db.ts";

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!state) {
    return jsonError("invalid_state", 400);
  }
  if (!code) {
    return jsonError("invalid_request: code is required", 400);
  }

  const tokenUrl = Deno.env.get("TINY_OAUTH_TOKEN_URL");
  if (!tokenUrl) {
    console.error("tiny-oauth-callback: TINY_OAUTH_TOKEN_URL is unset");
    return jsonError("server_error", 500);
  }

  try {
    // Atomic claim of the state row: only an unconsumed, unexpired state
    // flips to consumed = true here. A second callback for the same state
    // (retry, race, or replay) gets zero rows back and is rejected below —
    // this is the "reuse/invalid state fails" guarantee.
    const stateRows = await sql`
      update tiny_oauth_states
      set consumed = true
      where state = ${state}
        and consumed = false
        and expires_at > now()
      returning tenant_id, client_id, encrypted_client_secret, redirect_uri
    `;
    const pending = stateRows[0];
    if (!pending) {
      return jsonError("invalid_state", 400);
    }

    const [{ decrypted_secret: clientSecret }] = await sql`
      select decrypted_secret
      from vault.decrypted_secrets
      where id = ${pending.encrypted_client_secret}::uuid
    `;

    const tokenResponse = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: pending.client_id,
        client_secret: clientSecret,
        redirect_uri: pending.redirect_uri,
      }),
    });

    if (!tokenResponse.ok) {
      // Never log the response body — it may echo back client_secret/code.
      console.error(
        "tiny-oauth-callback: token exchange failed",
        tokenResponse.status,
      );
      return jsonError("token_exchange_failed", 400);
    }

    const tokenBody = await tokenResponse.json() as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!tokenBody.access_token || !tokenBody.expires_in) {
      console.error("tiny-oauth-callback: token response missing required fields");
      return jsonError("token_exchange_failed", 400);
    }

    const tokenExpiresAt = new Date(
      Date.now() + tokenBody.expires_in * 1000,
    ).toISOString();

    const [{ id: newClientSecretId }] = await sql`
      select vault.create_secret(
        ${clientSecret},
        null,
        ${"tiny_credentials client_secret, tenant_id=" + pending.tenant_id}
      ) as id
    `;
    const [{ id: newAccessTokenId }] = await sql`
      select vault.create_secret(
        ${tokenBody.access_token},
        null,
        ${"tiny_credentials access_token, tenant_id=" + pending.tenant_id}
      ) as id
    `;
    const refreshTokenId = tokenBody.refresh_token
      ? (await sql`
          select vault.create_secret(
            ${tokenBody.refresh_token},
            null,
            ${"tiny_credentials refresh_token, tenant_id=" + pending.tenant_id}
          ) as id
        `)[0].id
      : null;

    await sql`
      insert into tiny_credentials
        (tenant_id, client_id, encrypted_client_secret, encrypted_access_token,
         encrypted_refresh_token, token_expires_at, status)
      values
        (${pending.tenant_id}, ${pending.client_id}, ${newClientSecretId},
         ${newAccessTokenId}, ${refreshTokenId}, ${tokenExpiresAt}, 'connected')
      on conflict (tenant_id) do update set
        client_id = excluded.client_id,
        encrypted_client_secret = excluded.encrypted_client_secret,
        encrypted_access_token = excluded.encrypted_access_token,
        encrypted_refresh_token = excluded.encrypted_refresh_token,
        token_expires_at = excluded.token_expires_at,
        status = 'connected'
    `;

    return new Response(
      JSON.stringify({ status: "connected", tenant_id: pending.tenant_id }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    // Never log clientSecret, access_token, refresh_token, or vault secret values.
    console.error("tiny-oauth-callback failed", err);
    return jsonError("server_error", 500);
  }
});

function jsonError(error: string, status: number): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
