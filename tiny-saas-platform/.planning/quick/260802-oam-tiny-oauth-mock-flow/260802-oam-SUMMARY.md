---
phase: quick-260802-oam
plan: 260802-oam
subsystem: tiny-integration
tags: [oauth2, edge-functions, vault, mock, deno, tiny-erp]

# Dependency graph
requires: []
provides:
  - "supabase/functions/tiny-oauth-authorize, tiny-oauth-callback — real OAuth2 connect flow client logic (code exchange, anti-CSRF state, Vault encryption, tiny_credentials storage)"
  - "supabase/functions/tiny-mock-authorize, tiny-mock-token — MOCK Tiny OAuth server, dev/test-only, unblocks Phase 3 prep before a real client_id/secret exists"
  - "supabase/migrations/20260802010000_tiny_oauth_states_and_mock.sql — tiny_oauth_states (pending-connection state) + tiny_oauth_mock_codes (mock-only) tables"
  - "scripts/test-oauth-mock-flow.ts — local-only e2e proof: happy path, state replay rejection, code reuse rejection, Vault round-trip decryption"
affects: [phase-03-tiny-oauth-sync]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Secrets encrypted via Supabase Vault (vault.create_secret / vault.decrypted_secrets) — encrypted_* columns store the Vault secret UUID, not ciphertext; confirmed as the project's already-documented decision (PROJECT.md Key Decisions, docs/01-ARQUITETURA.md, docs/02-MODELO-DE-DADOS.md), not a new choice made this session"
    - "OAuth base URLs (TINY_OAUTH_AUTHORIZE_URL, TINY_OAUTH_TOKEN_URL) are env-driven so mock -> real Tiny is a one-line env change, never a code change"
    - "Anti-CSRF state and authorization codes are both consumed atomically (UPDATE ... WHERE consumed/used = false RETURNING *) so replay/race always loses"

key-files:
  created:
    - supabase/migrations/20260802010000_tiny_oauth_states_and_mock.sql
    - supabase/functions/tiny-mock-authorize/index.ts (+ deno.json)
    - supabase/functions/tiny-mock-token/index.ts (+ deno.json)
    - supabase/functions/tiny-oauth-authorize/index.ts (+ deno.json)
    - supabase/functions/tiny-oauth-callback/index.ts (+ deno.json)
    - scripts/test-oauth-mock-flow.ts
    - supabase/functions/.env (gitignored, local-only — TINY_OAUTH_*_URL + a temporary DATABASE_URL DNS workaround, see below)
  modified:
    - supabase/config.toml (verify_jwt=false overrides for the 4 new functions, each with a rationale comment)

key-decisions:
  - "Encryption backend: Supabase Vault, confirmed explicitly with the user rather than assumed — this was already the project's documented decision (not a new architectural choice), just never implemented until this session."
  - "tenant_id is trusted from a query param in tiny-oauth-authorize, not derived from a Supabase Auth session — documented as a KNOWN SCOPE GAP (comment in the function + config.toml), not silently accepted. No dashboard/\"connect\" button exists yet to originate an authenticated call; wiring this to a real session is required before production use."
  - "tiny-oauth-states table (ephemeral pending-connection rows) kept separate from tiny_credentials — a row in tiny_credentials only ever means a fully-connected account, so the existing status check (connected/expired/revoked) needed no schema change."
  - "Reconnect (tenant already has tiny_credentials) creates fresh Vault secrets rather than rotating existing ones in place — correct behavior, but orphans the old Vault secrets. Documented as deferred cleanup, not silently ignored."
  - "Local-only: edge-runtime's Deno DNS resolver failed to resolve `supabase_db_<project>` (getaddrinfo ENOTFOUND) even though the container's OS-level resolver (getent) worked fine — a Docker Desktop/Deno DNS quirk in this dev environment, unrelated to _shared/db.ts or this session's code (reproduced identically on the pre-existing, untouched `health` function). Worked around locally via a literal-IP DATABASE_URL override in the new, gitignored supabase/functions/.env — commented as temporary, since the IP is not stable across `supabase stop`/`start` cycles."
  - "TINY_OAUTH_TOKEN_URL had to point at edge-runtime's internal port (127.0.0.1:8081, prefix-stripped) rather than the externally-published Kong URL, because tiny-oauth-callback calls it server-side from inside the same container tiny-mock-token runs in. This is a local-mock-only routing quirk — in production TINY_OAUTH_TOKEN_URL is Tiny's real, externally-reachable endpoint, so it doesn't recur."

requirements-completed: []

coverage:
  - id: D1
    description: "Full mocked connect flow (authorize -> mock Tiny authorize -> our callback) succeeds end-to-end and writes a correct tiny_credentials row"
    verification:
      - kind: integration
        ref: "deno run --allow-net --allow-env scripts/test-oauth-mock-flow.ts (manual run, see verbatim output below)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Secrets (client_secret, access_token, refresh_token) are stored as Vault secret UUID references, never plaintext, and round-trip decrypt correctly via vault.decrypted_secrets"
    verification:
      - kind: integration
        ref: "Same test run — UUID-shape assertion on encrypted_* columns + decrypted_secret round-trip assertions"
        status: pass
    human_judgment: false
  - id: D3
    description: "Anti-CSRF state is single-use: a replayed callback (same code+state) is rejected; missing/bogus state is rejected"
    verification:
      - kind: integration
        ref: "Same test run — replay + bogus/missing state negative tests"
        status: pass
    human_judgment: false
  - id: D4
    description: "Authorization code is single-use at the mock-token layer, independent of the state-layer protection"
    verification:
      - kind: integration
        ref: "Same test run — direct re-exchange of the already-used code against tiny-mock-token"
        status: pass
    human_judgment: false
  - id: D5
    description: "Fase 3 'really done' still requires the same flow proven against the real Tiny OAuth server, not just the mock"
    verification:
      - kind: other
        ref: "Not verifiable this session — no real Tiny client_id/client_secret available yet (friend's account plan confirmation pending)"
        status: pending
    human_judgment: true
    rationale: "This is the explicit, user-stated boundary of this session's scope. Nothing here should be read as Phase 3's real-API integration being complete."

# Metrics
duration: ~90min
completed: 2026-08-02
status: complete
---

# Quick Task 260802-oam: Mocked Tiny OAuth2 Connect Flow

**Built and locally proved a mocked Tiny ERP OAuth2 connect flow — real client-side logic (code exchange, anti-CSRF state, Supabase Vault encryption, tiny_credentials storage) validated end-to-end against a mock Tiny OAuth server, entirely decoupled from needing a real Tiny client_id/client_secret.**

## Scope boundary (read this first)

This proves our OAuth **client** logic is correct. It does **not** prove the real
Tiny API contract (exact param names, error response shapes, rate limits,
real-world edge cases) — that remains untested. Per `docs/03-INTEGRACAO-TINY-ERP.md`
§1, Tiny's real OAuth2 flow is the standard we mirrored, but third-party API
details can drift from documentation. **Phase 3's "tenant can really connect
their Tiny ERP account" success criterion is not satisfied by this session** —
it requires re-running this same flow against the real Tiny OAuth server with a
real `client_id`/`client_secret`, which is pending a friend's Tiny account plan
confirmation.

## What's mocked vs. what's real

| Piece | Status |
|---|---|
| `tiny-mock-authorize`, `tiny-mock-token` | **MOCK** — simulate Tiny's OAuth server. Marked with explicit disclaimer comments. Not used in production. |
| `tiny-oauth-authorize`, `tiny-oauth-callback` | **Real** — this is the actual production code, unchanged whether pointed at the mock or the real Tiny (env-var swap only). |
| Anti-CSRF `state` handling, single-use enforcement | **Real logic**, proven against the mock. |
| Supabase Vault encryption of client_secret/access_token/refresh_token | **Real** — same Vault calls that will run in production. |
| `tiny_credentials` storage (status, token_expires_at) | **Real** — same table, same write path. |
| Tenant authentication (deriving `tenant_id` from a real session) | **Not implemented.** `tenant_id` is currently trusted from a query param — documented as a known gap in `tiny-oauth-authorize/index.ts` and `config.toml`. Must be wired to Supabase Auth before this is production-safe. |
| Refresh-token exchange (using `refresh_token` to get a new `access_token`) | **Not implemented/tested this session** — out of scope (sync engine territory). |

## Accomplishments

- New migration `20260802010000_tiny_oauth_states_and_mock.sql`: `tiny_oauth_states` (ephemeral pending-connection rows, RLS enabled+forced, no policies) and `tiny_oauth_mock_codes` (mock-only, clearly commented as such).
- Four new Edge Functions, each following the project's existing conventions (`Deno.serve`, `_shared/db.ts`, env-var-only secrets, no plaintext secrets in logs):
  - `tiny-mock-authorize`, `tiny-mock-token` — mock Tiny OAuth server.
  - `tiny-oauth-authorize`, `tiny-oauth-callback` — real connect-flow logic.
- `supabase/config.toml`: `verify_jwt=false` overrides for all four, each with an inline rationale comment (mock endpoints simulate an external, unauthenticated-to-us server; callback is a public OAuth redirect target by construction; authorize's exception is flagged as a known, temporary gap).
- `scripts/test-oauth-mock-flow.ts`: local-only e2e test (same hardcoded-`127.0.0.1:54322` guard pattern as `verify-rls-local-isolation.ts`) proving the full happy path plus three negative cases.
- Confirmed the encryption approach (Supabase Vault) with the user explicitly rather than deciding unilaterally, per their request — it turned out to already be the project's documented decision (`PROJECT.md` Key Decisions, `docs/01-ARQUITETURA.md`, `docs/02-MODELO-DE-DADOS.md`), just unimplemented until now.
- Ran the test script against a real local Supabase stack (`supabase start` + `db reset`) — all checks passed twice (repeatable, not flaky).

## Local environment quirks hit and worked around

Two Docker/Deno-specific issues surfaced while testing locally — both worked
around in the new, **gitignored** `supabase/functions/.env` (not the project's
main `.env`, which this session never read or touched):

1. **Deno DNS resolver ENOTFOUND for `supabase_db_<project>`** inside the
   edge-runtime container, even though the container's OS-level resolver
   (`getent`) resolved it fine. Reproduced identically on the pre-existing,
   untouched `health` function — confirmed environment-specific, not caused
   by this session's code. Worked around with a literal-IP `DATABASE_URL`
   override; commented as temporary since the IP isn't stable across
   `supabase stop`/`start`.
2. **`TINY_OAUTH_TOKEN_URL` had to use edge-runtime's internal port** (`127.0.0.1:8081`,
   Kong's `/functions/v1/` prefix stripped) instead of the externally-published
   Kong URL, because `tiny-oauth-callback` calls it server-side from inside the
   same container `tiny-mock-token` runs in. This is a **local-mock-only**
   quirk — in production `TINY_OAUTH_TOKEN_URL` is Tiny's real, externally-reachable
   endpoint, so this does not recur.

## Test Output (verbatim, second independent run)

```
Inserted test tenant: 7395f7a8-d0d9-4bcb-9add-6f227f544a96

--- Happy path: full connect flow ---
tiny-oauth-authorize redirected to mock authorize: http://127.0.0.1:54321/functions/v1/tiny-mock-authorize?...
tiny-mock-authorize redirected to our callback: http://127.0.0.1:54321/functions/v1/tiny-oauth-callback?code=...&state=...
tiny-oauth-callback response: 200 { status: "connected", tenant_id: "7395f7a8-d0d9-4bcb-9add-6f227f544a96" }
Happy path PASSED: authorize -> mock -> callback all succeeded.

--- Storage + encryption assertions ---
tiny_credentials row: {
  client_id: "mock-client-c9248985-...",
  encrypted_client_secret: "d47f34f9-22fc-4288-b3ff-3f8ff2bda635",
  encrypted_access_token: "354c87cf-94c9-4e3f-8037-063e760ebef2",
  encrypted_refresh_token: "6cb36f8e-89e2-4a12-8594-fe41103d2232",
  token_expires_at: 2026-08-02T04:11:01.253Z,
  status: "connected"
}
PASSED: encrypted_* columns are opaque Vault secret UUIDs, not plaintext tokens.
PASSED: Vault round-trip decryption matches expected values (access_token, refresh_token, client_secret).

--- Negative test: replayed state must be rejected ---
Replayed callback response: 400 { error: "invalid_state" }
PASSED: replayed state was rejected (state is single-use).

--- Negative test: missing/invalid state must be rejected ---
PASSED: bogus and missing state were both rejected.

--- Negative test: reused authorization code must be rejected ---
Reused-code exchange response: 400 { error: "invalid_grant" }
PASSED: reused authorization code was rejected (code is single-use).

ALL CHECKS PASSED: mocked OAuth connect flow proven end-to-end — code exchange, anti-CSRF state, Vault encryption, tiny_credentials storage, and both state-reuse and code-reuse rejection all behave correctly.

Cleanup: removed test tenant and associated rows.
```

Exit code: 0

## Files Created/Modified

- `supabase/migrations/20260802010000_tiny_oauth_states_and_mock.sql` — new
- `supabase/functions/tiny-mock-authorize/index.ts` + `deno.json` — new (MOCK)
- `supabase/functions/tiny-mock-token/index.ts` + `deno.json` — new (MOCK)
- `supabase/functions/tiny-oauth-authorize/index.ts` + `deno.json` — new (real)
- `supabase/functions/tiny-oauth-callback/index.ts` + `deno.json` — new (real)
- `scripts/test-oauth-mock-flow.ts` — new
- `supabase/functions/.env` — new, gitignored, local-only
- `supabase/config.toml` — modified (4 new `[functions.*]` blocks)

## Deviations from Plan

None from the user's spec. Two local-environment quirks (Deno DNS resolver, internal port routing) required workarounds to actually run the test — both documented above and in code comments, not silently patched over.

## Next Phase Readiness

- This unblocks continued Phase 3 prep work (sync engine, dashboard connect button) without waiting on the real Tiny app registration.
- **Before Phase 3 can be declared done:** (1) re-run this same flow against the real Tiny OAuth server once `client_id`/`client_secret` are available, (2) wire `tiny-oauth-authorize`'s `tenant_id` to a real Supabase Auth session instead of a trusted query param, (3) decide a Vault-secret rotation strategy for reconnects instead of orphaning old secrets.
- `ROADMAP.md` line 95 still says tokens are "stored encrypted at rest via Fernet" — stale, predates the Vault decision recorded in `PROJECT.md`/`docs/`. Noticed, not edited (out of this session's scope) — worth a small doc fix.
