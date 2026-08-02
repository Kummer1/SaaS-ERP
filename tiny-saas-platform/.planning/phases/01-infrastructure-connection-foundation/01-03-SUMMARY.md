---
phase: 01-infrastructure-connection-foundation
plan: 03
subsystem: infra
tags: [supabase, vault, pg_cron, pg_net, pgmq, postgres, secrets-management]

# Dependency graph
requires:
  - phase: 01-infrastructure-connection-foundation
    provides: "pg_cron/pg_net/pgmq extensions enabled on production (plan 01-02); Transaction Pooler + prepare:false connection discipline (plan 01-01)"
provides:
  - "Two populated Supabase Vault secrets (project_url, edge_function_key) on the production project, created entirely by a committed, secret-free script"
  - "scripts/setup-vault-secrets.ts: idempotent Vault populator, safe to re-run"
  - "supabase/migrations/20260729231615_cron_sync_trigger.sql: pgmq.create('sync_work') + cron.schedule('sync-enqueue-trigger', '*/15 * * * *', ...) with Vault-sourced net.http_post credentials"
  - "sync-enqueue-trigger cron job active on production, calling /functions/v1/sync-enqueue every 15 minutes"
  - "sync_work pgmq queue live on production, empty, ready for producer/consumer functions"
affects: [01-04-sync-pipeline]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Vault-secret idempotency check: select 1 from vault.decrypted_secrets where name = $1 before vault.create_secret($2, $1)"
    - "cron.schedule net.http_post body sources URL/Authorization exclusively from vault.decrypted_secrets lookups, never literal values"

key-files:
  created:
    - scripts/setup-vault-secrets.ts
    - supabase/migrations/20260729231615_cron_sync_trigger.sql
  modified: []

key-decisions:
  - "Used the same postgres.js Transaction-Pooler + {prepare:false} client construction in setup-vault-secrets.ts as _shared/db.ts and smoke-test-db.ts, keeping one connection discipline across every script in the project."
  - "vault.create_secret(value, name) argument order followed the plan's own SQL example exactly ($2=value first, $1=name second) - matches Supabase's documented function signature."

patterns-established:
  - "Any future script/migration that needs pg_net to call an Edge Function must source its URL/key from vault.decrypted_secrets by name, never inline - this plan is the first and reference implementation of that discipline in this repo."

requirements-completed: []

coverage:
  - id: D1
    description: "scripts/setup-vault-secrets.ts creates project_url and edge_function_key Vault secrets on production, reading only from Deno.env.get(), with zero literal secret values committed"
    verification:
      - kind: other
        ref: "grep -Ei \"https://|service_role|eyJ\" scripts/setup-vault-secrets.ts -> no literal URL or JWT-shaped string (see Issues Encountered for the one expected env-var-name substring match)"
        status: pass
      - kind: other
        ref: "deno run --allow-net --allow-env scripts/setup-vault-secrets.ts, run twice against production: first run created both secrets, second run confirmed both already exist, both exits 0"
        status: pass
    human_judgment: false
  - id: D2
    description: "cron_sync_trigger migration creates the sync_work pgmq queue and schedules sync-enqueue-trigger via cron.schedule, sourcing net.http_post credentials exclusively from vault.decrypted_secrets"
    verification:
      - kind: other
        ref: "grep -Ei \"https://[a-z0-9-]+\\.supabase\\.co|Bearer [A-Za-z0-9._-]{20,}\" supabase/migrations/20260729231615_cron_sync_trigger.sql -> no matches (no literal URL/key)"
        status: pass
      - kind: other
        ref: "grep -c vault.decrypted_secrets supabase/migrations/20260729231615_cron_sync_trigger.sql -> 3 (>= 2 required)"
        status: pass
      - kind: other
        ref: "supabase db push --linked (production) -> exit 0; direct query: cron.job shows jobname=sync-enqueue-trigger, schedule=*/15 * * * *, active=true; pgmq.list_queues() shows queue_name=sync_work; pgmq.q_sync_work row count = 0"
        status: pass
    human_judgment: false

duration: 10min
completed: 2026-07-29
status: complete
---

# Phase 1 Plan 3: Vault Secrets + Cron/Queue Trigger Summary

**Populated Supabase Vault with `project_url`/`edge_function_key` via a secret-free idempotent script, then pushed a migration creating the `sync_work` pgmq queue and scheduling `pg_cron` to call the future `sync-enqueue` Edge Function every 15 minutes using only Vault-sourced credentials — no literal secret ever committed to git.**

## Performance

- **Duration:** ~10 min
- **Started:** 2026-07-29T23:08:31Z
- **Completed:** 2026-07-29T23:18:57Z
- **Tasks:** 2
- **Files modified:** 2 created

## Accomplishments
- `scripts/setup-vault-secrets.ts` created and run twice against the real production project: first run created both `project_url` and `edge_function_key` Vault secrets, second run confirmed idempotency (both already existed, no duplicates, exit 0 both times)
- `supabase/migrations/20260729231615_cron_sync_trigger.sql` committed and pushed to production: `pgmq.create('sync_work')` + `cron.schedule('sync-enqueue-trigger', '*/15 * * * *', ...)` whose `net.http_post` body reads URL and Authorization header exclusively from `vault.decrypted_secrets` lookups
- Confirmed on production via direct query: `cron.job` shows `sync-enqueue-trigger` active with schedule `*/15 * * * *`; `pgmq.list_queues()` shows the `sync_work` queue exists; `pgmq.q_sync_work` has 0 rows (empty, ready for plan 01-04's producer/consumer functions)
- Satisfied the trigger + queue halves of ROADMAP Phase 1 Success Criterion 4 (D-03/D-04) without ever committing a literal URL or key to git

## Task Commits

Each task was committed atomically:

1. **Task 1: Create the secret-free Vault setup script and populate project_url/edge_function_key on the production project** - `21a0bb3` (feat)
2. **Task 2: [BLOCKING] Create the cron_sync_trigger migration (pgmq queue + cron.schedule via Vault lookups only) and push it** - `cf5d05e` (feat)

**Plan metadata:** commit pending (this document + STATE/ROADMAP updates)

## Files Created/Modified
- `scripts/setup-vault-secrets.ts` - idempotent, secret-free Deno script; reads `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` from `Deno.env.get()` only, checks `vault.decrypted_secrets` by name before calling `vault.create_secret()`
- `supabase/migrations/20260729231615_cron_sync_trigger.sql` - `pgmq.create('sync_work')` + `cron.schedule('sync-enqueue-trigger', '*/15 * * * *', ...)` with Vault-sourced `net.http_post` credentials only

## Decisions Made
- Reused the exact `postgres.js` Transaction-Pooler + `{prepare:false}` client construction from `_shared/db.ts`/`smoke-test-db.ts` in the new Vault setup script, keeping a single connection discipline across every script in the repo.
- Followed the plan's own SQL example argument order for `vault.create_secret(value, name)` exactly, matching Supabase's documented function signature.

## Deviations from Plan

None - plan executed exactly as written. Both tasks completed without needing Rule 1-4 auto-fixes.

## Issues Encountered
- The Task 1 acceptance-criteria grep (`grep -Ei "https://|service_role|eyJ" scripts/setup-vault-secrets.ts`) is case-insensitive and matches the substring "SERVICE_ROLE" inside the necessarily-referenced environment variable name `SUPABASE_SERVICE_ROLE_KEY` (3 matches, all on lines referencing the env var name itself, never a literal secret value). Confirmed via targeted greps that neither `https://` nor a JWT-shaped `eyJ...` string appears anywhere in the file - the only match category is the required env-var-name reference, not a literal secret. This is the same class of literal-grep false-positive documented in plan 01-01's SUMMARY (the `5432` boilerplate-port match) and plan 01-02's SUMMARY (the `migration list` filename-substring match) - the underlying intent (no literal secret values committed) is satisfied; the literal grep pattern is simply broader than its intent.
- The Task 2 `<verify>` command (`supabase migration list | grep -c cron_sync_trigger`) also returns `0` for the same reason plan 01-02 documented: this CLI version's `migration list` output shows only version timestamps, not filenames, in both JSON and `--output-format text` modes, so the filename substring never appears. Verified success instead via `supabase migration list` showing local `20260729231615` == remote `20260729231615`, plus the direct `cron.job`/`pgmq.list_queues()` production queries documented above - all confirming the migration applied successfully.
- Docker absence (documented in 01-02) produced the same harmless `supabase db push` warning ("failed to cache migrations catalog: error exporting pg-delta catalog: failed to run docker") - the push itself completed successfully (`"upToDate":false,"dryRun":false,...,"message":"Finished supabase db push."`), consistent with the established fallback pattern.

## User Setup Required
None - `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` were already present in `.env` from prior setup; no new external service configuration was required this plan.

## Next Phase Readiness
- The `sync_work` pgmq queue and the `sync-enqueue-trigger` cron job are live on production, ready for plan 01-04 to build the `sync-enqueue` (producer) and `sync-worker` (consumer) Edge Functions against them.
- Vault holds `project_url`/`edge_function_key`, so plan 01-04's functions (and any future Vault-authenticated pg_net call) can reuse the same two secrets without re-provisioning.
- `scripts/setup-vault-secrets.ts` is idempotent and safe to re-run if secret rotation is ever needed.
- No blockers carried forward from this plan. Existing carried-forward blockers (no git remote/gh CLI, Tiny ERP rate-limit re-verification for Phase 3) remain unchanged - see STATE.md.

## Self-Check: PASSED

Both created files confirmed present on disk; both task commit hashes (`21a0bb3`, `cf5d05e`) confirmed present in git log; production `cron.job`/`pgmq.list_queues()` queries confirmed the live state described above.

---
*Phase: 01-infrastructure-connection-foundation*
*Completed: 2026-07-29*
