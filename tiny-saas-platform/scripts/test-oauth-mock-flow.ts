// Local-only end-to-end proof of the Tiny OAuth2 connect flow's LOGIC:
// code-for-token exchange, anti-CSRF state handling, encryption via Supabase
// Vault, and storage into tiny_credentials — running entirely against
// tiny-mock-authorize/tiny-mock-token instead of the real Tiny OAuth server
// (quick-260802-oauth-mock; see .planning/quick/260802-oauth-mock/).
//
// This proves our CLIENT-side logic is correct. It does NOT prove the real
// Tiny API contract (exact param names, error shapes, rate limits) — that
// remains untested until a real client_id/client_secret is available. See
// docs/03-INTEGRACAO-TINY-ERP.md §1 for what the mock approximates.
//
// Run: deno run --allow-net --allow-env scripts/test-oauth-mock-flow.ts
// Precondition: `supabase start` running locally (Edge Functions served at
// 127.0.0.1:54321, DB at 127.0.0.1:54322), migrations applied
// (`supabase db reset` or `supabase migration up`).
//
// Connection discipline matches scripts/verify-rls-local-isolation.ts:
// DELIBERATELY hardcoded to the local stack only, never reads
// DATABASE_URL/SUPABASE_DB_URL from the environment (that var holds the LIVE
// project's connection string in this repo's .env) — guarded so this script
// is structurally incapable of touching production.
import postgres from "npm:postgres@3.4.9";

const LOCAL_CONNECTION_STRING =
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
if (!LOCAL_CONNECTION_STRING.includes("127.0.0.1:54322")) {
  throw new Error(
    "Refusing to connect: LOCAL_CONNECTION_STRING does not contain '127.0.0.1:54322'. " +
      "This script must never connect to anything other than the local Supabase stack.",
  );
}

const FUNCTIONS_BASE = "http://127.0.0.1:54321/functions/v1";
if (!FUNCTIONS_BASE.startsWith("http://127.0.0.1:54321")) {
  throw new Error(
    "Refusing to run: FUNCTIONS_BASE does not point at the local stack.",
  );
}

const sql = postgres(LOCAL_CONNECTION_STRING, { prepare: false });

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// --- Step: create a disposable test tenant ---

const [tenant] = await sql`
  insert into tenants (name)
  values ('OAuth Mock Flow Test Tenant - quick-260802-oauth-mock')
  returning id
`;
const tenantId = tenant.id;
console.log("Inserted test tenant:", tenantId);

const testClientId = `mock-client-${crypto.randomUUID()}`;
const testClientSecret = `mock-secret-${crypto.randomUUID()}`;
const redirectUri = `${FUNCTIONS_BASE}/tiny-oauth-callback`;

try {
  // --- Step: happy path — authorize -> mock-authorize -> callback ---
  console.log("\n--- Happy path: full connect flow ---");

  const authorizeUrl =
    `${FUNCTIONS_BASE}/tiny-oauth-authorize?tenant_id=${tenantId}` +
    `&client_id=${encodeURIComponent(testClientId)}` +
    `&client_secret=${encodeURIComponent(testClientSecret)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}`;

  const authorizeRes = await fetch(authorizeUrl, { redirect: "manual" });
  assertRedirect(authorizeRes, "tiny-oauth-authorize");
  const mockAuthorizeUrl = authorizeRes.headers.get("location")!;
  console.log("tiny-oauth-authorize redirected to mock authorize:", mockAuthorizeUrl);

  const mockAuthorizeRes = await fetch(mockAuthorizeUrl, { redirect: "manual" });
  assertRedirect(mockAuthorizeRes, "tiny-mock-authorize");
  const callbackUrl = mockAuthorizeRes.headers.get("location")!;
  console.log("tiny-mock-authorize redirected to our callback:", callbackUrl);

  const callbackParsed = new URL(callbackUrl);
  const usedCode = callbackParsed.searchParams.get("code")!;
  const usedState = callbackParsed.searchParams.get("state")!;
  if (!usedCode || !usedState) {
    throw new Error(
      `Expected code and state in callback URL, got code=${usedCode} state=${usedState}`,
    );
  }

  const callbackRes = await fetch(callbackUrl);
  const callbackBody = await callbackRes.json();
  console.log("tiny-oauth-callback response:", callbackRes.status, callbackBody);
  if (callbackRes.status !== 200) {
    throw new Error(
      `Expected callback to succeed with 200, got ${callbackRes.status}: ${JSON.stringify(callbackBody)}`,
    );
  }
  if (callbackBody.status !== "connected" || callbackBody.tenant_id !== tenantId) {
    throw new Error(
      `Unexpected callback success body: ${JSON.stringify(callbackBody)}`,
    );
  }
  console.log("Happy path PASSED: authorize -> mock -> callback all succeeded.");

  // --- Step: assert tiny_credentials row is correct and secrets are NOT plaintext ---
  console.log("\n--- Storage + encryption assertions ---");

  const [cred] = await sql`
    select client_id, encrypted_client_secret, encrypted_access_token,
           encrypted_refresh_token, token_expires_at, status
    from tiny_credentials
    where tenant_id = ${tenantId}
  `;
  if (!cred) {
    throw new Error("Expected a tiny_credentials row for the test tenant, found none.");
  }
  console.log("tiny_credentials row:", cred);

  if (cred.status !== "connected") {
    throw new Error(`Expected status='connected', got '${cred.status}'`);
  }
  if (cred.client_id !== testClientId) {
    throw new Error(
      `Expected client_id='${testClientId}', got '${cred.client_id}'`,
    );
  }
  const expiresAt = new Date(cred.token_expires_at).getTime();
  const expectedExpiry = Date.now() + 3600 * 1000;
  if (Math.abs(expiresAt - expectedExpiry) > 5 * 60 * 1000) {
    throw new Error(
      `token_expires_at (${cred.token_expires_at}) is not within 5 minutes of the expected ~1h expiry`,
    );
  }

  for (
    const [col, val] of [
      ["encrypted_client_secret", cred.encrypted_client_secret],
      ["encrypted_access_token", cred.encrypted_access_token],
      ["encrypted_refresh_token", cred.encrypted_refresh_token],
    ] as const
  ) {
    if (!UUID_RE.test(val)) {
      throw new Error(
        `${col} does not look like a Vault secret UUID reference: '${val}'`,
      );
    }
    if (val === testClientSecret || String(val).startsWith("mock_at_") || String(val).startsWith("mock_rt_")) {
      throw new Error(`${col} appears to hold a plaintext secret value, not a Vault reference`);
    }
  }
  console.log(
    "PASSED: encrypted_* columns are opaque Vault secret UUIDs, not plaintext tokens.",
  );

  const decryptedAccessToken = await sql`
    select decrypted_secret from vault.decrypted_secrets where id = ${cred.encrypted_access_token}::uuid
  `;
  const decryptedRefreshToken = await sql`
    select decrypted_secret from vault.decrypted_secrets where id = ${cred.encrypted_refresh_token}::uuid
  `;
  const decryptedClientSecret = await sql`
    select decrypted_secret from vault.decrypted_secrets where id = ${cred.encrypted_client_secret}::uuid
  `;
  if (!decryptedAccessToken[0]?.decrypted_secret.startsWith("mock_at_")) {
    throw new Error(
      `Decrypted access_token does not look like our mock token: ${decryptedAccessToken[0]?.decrypted_secret}`,
    );
  }
  if (!decryptedRefreshToken[0]?.decrypted_secret.startsWith("mock_rt_")) {
    throw new Error(
      `Decrypted refresh_token does not look like our mock token: ${decryptedRefreshToken[0]?.decrypted_secret}`,
    );
  }
  if (decryptedClientSecret[0]?.decrypted_secret !== testClientSecret) {
    throw new Error("Decrypted client_secret does not round-trip to the original value.");
  }
  console.log(
    "PASSED: Vault round-trip decryption matches expected values (access_token, refresh_token, client_secret).",
  );

  // --- Step: replayed callback (same code+state) must be rejected — state single-use ---
  console.log("\n--- Negative test: replayed state must be rejected ---");
  const replayRes = await fetch(callbackUrl);
  const replayBody = await replayRes.json();
  console.log("Replayed callback response:", replayRes.status, replayBody);
  if (replayRes.status !== 400 || replayBody.error !== "invalid_state") {
    throw new Error(
      `Expected replayed callback to fail with 400 invalid_state, got ${replayRes.status}: ${JSON.stringify(replayBody)}`,
    );
  }
  console.log("PASSED: replayed state was rejected (state is single-use).");

  // --- Step: missing/bogus state must be rejected ---
  console.log("\n--- Negative test: missing/invalid state must be rejected ---");
  const bogusStateRes = await fetch(
    `${FUNCTIONS_BASE}/tiny-oauth-callback?code=${crypto.randomUUID()}&state=${crypto.randomUUID()}`,
  );
  const bogusStateBody = await bogusStateRes.json();
  if (bogusStateRes.status !== 400 || bogusStateBody.error !== "invalid_state") {
    throw new Error(
      `Expected bogus state to fail with 400 invalid_state, got ${bogusStateRes.status}: ${JSON.stringify(bogusStateBody)}`,
    );
  }
  const missingStateRes = await fetch(`${FUNCTIONS_BASE}/tiny-oauth-callback?code=${crypto.randomUUID()}`);
  const missingStateBody = await missingStateRes.json();
  if (missingStateRes.status !== 400 || missingStateBody.error !== "invalid_state") {
    throw new Error(
      `Expected missing state to fail with 400 invalid_state, got ${missingStateRes.status}: ${JSON.stringify(missingStateBody)}`,
    );
  }
  console.log("PASSED: bogus and missing state were both rejected.");

  // --- Step: reused authorization code must be rejected at the mock-token layer ---
  // The happy-path callback above already exchanged `usedCode` once (marking it
  // used=true in tiny_oauth_mock_codes). Exchanging it again — bypassing our own
  // callback and hitting tiny-mock-token directly, exactly as a replayed/duplicated
  // callback attempt would — proves single-use is enforced at the code layer too,
  // independent of our state-layer protection above.
  console.log("\n--- Negative test: reused authorization code must be rejected ---");
  const reusedCodeRes = await fetch(`${FUNCTIONS_BASE}/tiny-mock-token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: usedCode,
      client_id: testClientId,
      client_secret: testClientSecret,
      redirect_uri: redirectUri,
    }),
  });
  const reusedCodeBody = await reusedCodeRes.json();
  console.log("Reused-code exchange response:", reusedCodeRes.status, reusedCodeBody);
  if (reusedCodeRes.status !== 400 || reusedCodeBody.error !== "invalid_grant") {
    throw new Error(
      `Expected reused code to fail with 400 invalid_grant, got ${reusedCodeRes.status}: ${JSON.stringify(reusedCodeBody)}`,
    );
  }
  console.log("PASSED: reused authorization code was rejected (code is single-use).");

  console.log(
    "\nALL CHECKS PASSED: mocked OAuth connect flow proven end-to-end — " +
      "code exchange, anti-CSRF state, Vault encryption, tiny_credentials storage, " +
      "and both state-reuse and code-reuse rejection all behave correctly.",
  );
} finally {
  // --- Cleanup: remove everything this run created, mock and real alike ---
  await sql`delete from tiny_oauth_mock_codes where client_id = ${testClientId}`;
  await sql`delete from tenants where id = ${tenantId}`; // cascades tiny_credentials, tiny_oauth_states
  console.log("\nCleanup: removed test tenant and associated rows.");
  await sql.end();
}

function assertRedirect(res: Response, step: string): void {
  if (res.status < 300 || res.status >= 400 || !res.headers.get("location")) {
    throw new Error(
      `Expected ${step} to respond with a redirect (3xx + Location header), got status ${res.status}`,
    );
  }
}
