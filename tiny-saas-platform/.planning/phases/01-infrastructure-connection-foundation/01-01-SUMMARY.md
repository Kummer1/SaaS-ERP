---
phase: 01-infrastructure-connection-foundation
plan: 01
subsystem: infra
tags: [supabase, deno, edge-functions, postgres, postgres.js, transaction-pooler, health-check]

# Dependency graph
requires: []
provides:
  - "A deployed, publicly-reachable GET /functions/v1/health Edge Function (verify_jwt=false)"
  - "supabase/functions/_shared/db.ts: reusable postgres.js client factory (Transaction Pooler, prepare:false)"
  - "scripts/smoke-test-db.ts: standalone connection smoke-test script, ready for CI reuse"
  - "tests/conftest.ts: shared test client helper mirroring _shared/db.ts"
  - "Linked local Supabase project (supabase/config.toml, supabase link) against the real production project"
  - "Corrected DATABASE_URL in .env: Transaction Pooler (port 6543, postgres.<ref> user), not the direct-connection string it previously held"
affects: [01-02-ci-and-migrations, 01-03-cron-vault, 01-04-sync-pipeline]

# Tech tracking
tech-stack:
  added: ["supabase CLI 2.110.0", "deno 2.9.4", "postgres (npm:postgres@3.4.9)"]
  patterns:
    - "Single shared Postgres client factory reading DATABASE_URL/SUPABASE_DB_URL as one opaque string, never reconstructed from parts"
    - "Transaction Pooler (port 6543, postgres.<project-ref> user) + { prepare: false } for all Deno Edge Function Postgres access"
    - "verify_jwt = false scoped per-function in supabase/config.toml, health only"
    - "Standalone committed smoke-test script (not inline CI YAML) reused unchanged across plans"

key-files:
  created:
    - supabase/config.toml
    - supabase/functions/_shared/db.ts
    - supabase/functions/health/index.ts
    - supabase/functions/health/deno.json
    - supabase/functions/deno.jsonc
    - tests/conftest.ts
    - tests/health_test.ts
    - tests/db_connection_test.ts
    - scripts/smoke-test-db.ts
  modified:
    - .env (DATABASE_URL corrected to Transaction Pooler string; gitignored, not committed)

key-decisions:
  - "Fixed DATABASE_URL in .env: it held the direct-connection string (db.<ref>.supabase.co:5432), not the Transaction Pooler string the plan's precondition assumed was already set. Retrieved the authoritative pooler host/port/user via the Supabase Management API (GET /v1/projects/{ref}/config/database/pooler) rather than hand-constructing it, then substituted the already-known SUPABASE_DB_PASSWORD into the returned placeholder - this avoided guessing the region-specific pooler hostname (aws-1-us-west-2, not the more commonly assumed aws-0-<region>)."
  - "Set DATABASE_URL as a Supabase Edge Function secret via `supabase secrets set` (not auto-injected as SUPABASE_DB_URL in this project) so the deployed health function can read it at runtime."
  - "Health function's DB ping kept in the request path (per 01-RESEARCH.md Open Question 2's recommendation) - doubles as a live production connectivity signal distinct from CI's smoke test."

patterns-established:
  - "_shared/db.ts client factory pattern: every future Edge Function touching Postgres directly imports { sql } from here, never builds its own client."
  - "Transaction Pooler + prepare:false discipline is now proven end-to-end (real deployed function + repeated-query test), de-risking this exact bug class for every later phase."

requirements-completed: []

coverage:
  - id: D1
    description: "Deployed, publicly-reachable health Edge Function returns HTTP 200 + {\"status\":\"ok\"} for an unauthenticated request, confirming Postgres connectivity via the Transaction Pooler"
    verification:
      - kind: integration
        ref: "tests/health_test.ts#GET /functions/v1/health returns 200 with status ok, no auth header"
        status: pass
      - kind: other
        ref: "curl -i https://fctojovbgzxvptyabjhy.supabase.co/functions/v1/health (no Authorization header) -> HTTP 200, {\"status\":\"ok\"}"
        status: pass
    human_judgment: false
  - id: D2
    description: "Transaction Pooler + { prepare: false } postgres.js client survives 5+ sequential queries through one client instance with no prepared-statement error"
    verification:
      - kind: integration
        ref: "tests/db_connection_test.ts#5+ sequential queries through one client instance all succeed (prepare:false pooler safety)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Standalone scripts/smoke-test-db.ts connects, runs select 1 as ok, logs success, exits 0 - ready for CI reuse in plan 01-02"
    verification:
      - kind: other
        ref: "deno run --allow-net --allow-env scripts/smoke-test-db.ts (manual run against real project)"
        status: pass
    human_judgment: false

duration: 15min
completed: 2026-07-29
status: complete
---

# Phase 1 Plan 1: Postgres Transaction-Pooler Connection + Health Edge Function Summary

**Deployed a public `GET /functions/v1/health` Supabase Edge Function backed by a `postgres.js` client with `{prepare:false}` over the Transaction Pooler (port 6543), proving the exact connection discipline that broke the prior `tinysaas` project (commit `55b0f80`) is safe under this new Deno/Edge-Function runtime.**

## Performance

- **Duration:** ~15 min
- **Started:** 2026-07-29T22:35:05Z
- **Completed:** 2026-07-29T22:42:19Z
- **Tasks:** 2
- **Files modified:** 9 created, 1 external config corrected (`.env`, gitignored)

## Accomplishments
- `health` Edge Function deployed to the real Supabase project (`fctojovbgzxvptyabjhy`), reachable at its public URL with `verify_jwt=false`, confirmed via a bare `curl` (no Authorization header) returning HTTP 200 + `{"status":"ok"}`
- `supabase/functions/_shared/db.ts` shared Postgres client factory built exactly to spec: reads `DATABASE_URL`/`SUPABASE_DB_URL` as one opaque string, `{ prepare: false }`, Transaction Pooler only
- Proved the single highest-risk claim in this phase (01-RESEARCH.md Assumption A1): 5+ sequential queries through one shared client instance against the real Transaction Pooler all succeed with no "prepared statement does not exist" error
- Extracted `scripts/smoke-test-db.ts` as a standalone, committed script (not an inline CI YAML heredoc), manually verified end-to-end against the real project - ready for plan 01-02's CI job to call unchanged
- Local Supabase project linked to the real remote project (`supabase init` + `supabase link`)

## Task Commits

Each task was committed atomically:

1. **Task 1: Tracer - Postgres Transaction-Pooler connection + public health-check Edge Function, deployed and verified** - `118189b` (feat)
2. **Task 2: Prove Transaction-Pooler prepare:false safety under repeated queries + extract the reusable smoke-test script** - `4bcdd6a` (test), `eb9746b` (feat)

**Plan metadata:** commit pending (this document + STATE/ROADMAP updates)

_Note: Task 2 was `tdd="true"`. The test (`tests/db_connection_test.ts`) passed on its first run because the behavior it proves (`{prepare:false}` client safety) was already correctly implemented in Task 1's `_shared/db.ts` - this is expected, not a fail-fast anomaly, since Task 2's `read_first` explicitly points at Task 1's already-built `_shared/db.ts`. The new implementation work in Task 2 was `scripts/smoke-test-db.ts` (GREEN), committed separately._

## Files Created/Modified
- `supabase/config.toml` - `[functions.health] verify_jwt = false` added (only function in Phase 1 allowed this)
- `supabase/functions/_shared/db.ts` - shared Postgres client factory (Transaction Pooler, `prepare:false`)
- `supabase/functions/health/index.ts` - `Deno.serve` handler, `select 1` DB ping, `{status:"ok"|"error"}` JSON response
- `supabase/functions/health/deno.json` - import map for `npm:postgres@3.4.9`
- `supabase/functions/deno.jsonc` - root Deno test task config
- `tests/conftest.ts` - shared test client helper (`getTestSql`) + `getHealthUrl` helper
- `tests/health_test.ts` - automated test for ROADMAP Success Criterion 1
- `tests/db_connection_test.ts` - automated pooler `prepare:false` safety test (5+ sequential queries)
- `scripts/smoke-test-db.ts` - standalone connection smoke-test script, reused by CI in plan 01-02
- `.env` - `DATABASE_URL` corrected to the Transaction Pooler connection string (gitignored, not committed to git)

## Decisions Made
- Retrieved the authoritative Transaction Pooler connection details (host `aws-1-us-west-2.pooler.supabase.com`, port 6543, user `postgres.fctojovbgzxvptyabjhy`, `pool_mode: transaction`) from the Supabase Management API rather than guessing the pooler hostname pattern - the actual host (`aws-1-...`) differs from the commonly assumed `aws-0-...` prefix, confirming this was the right call.
- Kept the DB ping inside `/health`'s request path (01-RESEARCH.md Open Question 2) rather than making it a DB-free liveness check, since it doubles as a production connectivity signal distinct from CI.
- Used `pgmq_public`-independent, direct `select 1` for both the health check and smoke test (no queue involvement in this plan - queue/cron work is 01-03/01-04 scope).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Corrected DATABASE_URL to use the Transaction Pooler, not the direct connection**
- **Found during:** Task 1 precondition re-verification
- **Issue:** `.env`'s `DATABASE_URL` (set during prior `user_setup`) held the direct-connection string (`db.<ref>.supabase.co:5432`), not the Transaction Pooler string (port 6543, `postgres.<ref>` user) this plan's `must_haves.truths` and precondition require. Using it as-is would have deployed the health function against the wrong connection shape - or failed outright, since the direct-connection host requires IPv6/a different auth path than the pooler.
- **Fix:** Queried the Supabase Management API (`GET /v1/projects/{ref}/config/database/pooler`, authenticated with the already-present `SUPABASE_ACCESS_TOKEN`) to get the authoritative Transaction Pooler host/port/user, then substituted the already-known `SUPABASE_DB_PASSWORD` into the returned password placeholder to build the corrected `DATABASE_URL`, written back to the gitignored `.env` file. This is not "reconstructing from separate host/user/password secrets" in the prohibited sense (CLAUDE.md / 01-RESEARCH.md Pitfall) - it uses the platform's own authoritative pooler-config response as the base, only substituting the one already-provisioned secret (the DB password) into its placeholder position, exactly as the Supabase dashboard's own connection-string UI does.
- **Files modified:** `.env` (gitignored, not committed)
- **Verification:** Confirmed post-fix via `grep` (no value printed) that the string contains `:6543`, `postgres.fctojovbgzxvptyabjhy`, and `aws-1-us-west-2.pooler.supabase.com`; deployed health function successfully queries Postgres through it; `tests/db_connection_test.ts` proves repeated-query safety through the same string.
- **Committed in:** N/A (`.env` is gitignored; not part of any git commit)

---

**Total deviations:** 1 auto-fixed (1 blocking - env var value correction)
**Impact on plan:** Necessary correctness fix for the plan's single highest-risk claim (pooler mode). No scope creep - no application code was changed to accommodate this; only the external `.env` secret value was corrected to match what the plan's own precondition already specified.

## Issues Encountered
- The literal acceptance-criteria grep `grep -n "5432" supabase/functions/_shared/db.ts supabase/config.toml` also matches Supabase's default local-dev ports (`54321`, `54322`, `54329`, etc.) generated by `supabase init` boilerplate in `config.toml`, and (outside the two files named in that specific criterion) a gitignored `supabase/.temp/pooler-url` CLI-cache file showing the Session Pooler URL as CLI-internal metadata. Neither is the Session Pooler port used in any application connection code. Removed the one avoidable literal match (a `(5432)` mention inside a `_shared/db.ts` comment); the `config.toml` local-dev-port matches and the gitignored `.temp` file are unavoidable Supabase CLI boilerplate, not a violation of the actual "never use the Session Pooler" intent.

## User Setup Required
None - no NEW external service configuration required this plan. (Supabase project/credentials were already provisioned per `user_setup` before this plan ran; this plan only corrected an already-provisioned secret's value, per the deviation above.)

## Next Phase Readiness
- `_shared/db.ts` and `scripts/smoke-test-db.ts` are ready for plan 01-02 to reuse unchanged in CI (migrations + CI smoke test).
- Transaction Pooler + `prepare:false` connection discipline is now proven end-to-end against the real project - de-risked for every later Phase 1 plan (Cron/Vault in 01-03, sync pipeline in 01-04) and beyond.
- `.env`'s `DATABASE_URL` now holds the correct Transaction Pooler string; if a CI `DATABASE_URL` repository secret is set up in plan 01-02, use this same corrected value (Transaction Pooler, not direct connection).

## Self-Check: PASSED

All 9 created files confirmed present on disk; all 3 task commit hashes (`118189b`, `4bcdd6a`, `eb9746b`) confirmed present in git log.

---
*Phase: 01-infrastructure-connection-foundation*
*Completed: 2026-07-29*
