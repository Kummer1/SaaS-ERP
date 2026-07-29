---
phase: 01-infrastructure-connection-foundation
plan: 02
subsystem: infra
tags: [supabase, postgres, pg_cron, pg_net, pgmq, github-actions, ci, migrations]

# Dependency graph
requires:
  - phase: 01-infrastructure-connection-foundation
    provides: "supabase/functions/_shared/db.ts (Transaction Pooler + prepare:false client factory) and scripts/smoke-test-db.ts (plan 01-01)"
provides:
  - "pg_cron, pg_net, pgmq extensions enabled on the production Supabase project"
  - "supabase/migrations/20260729225411_enable_queue_extensions.sql (committed, applied to production)"
  - ".github/workflows/ci.yml: smoke-test job (every push/PR) + main-gated deploy job"
  - "Reconciled Supabase CLI migration history (repaired a pre-existing orphaned remote migration entry)"
affects: [01-03-cron-vault, 01-04-sync-pipeline]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Extension-enabling migrations kept separate from queue/cron-schedule migrations for clean file ownership (this plan only enables extensions; 01-03 owns pgmq.create()/cron.schedule())"
    - "CI smoke-test job reuses the committed scripts/smoke-test-db.ts unchanged rather than an inline YAML heredoc or a generic postgres: service container"

key-files:
  created:
    - supabase/migrations/20260729225411_enable_queue_extensions.sql
    - .github/workflows/ci.yml
  modified: []

key-decisions:
  - "Docker is absent on this machine (confirmed, matches 01-RESEARCH.md's documented Environment Availability gap). Used `supabase db push --dry-run --linked` as the pre-production check instead of local `supabase start`/`migration up` emulation, per the plan's explicit fallback instruction."
  - "Discovered a pre-existing orphaned remote migration history entry (`20260729003512_init_schema`, no matching local file) that blocked `supabase db push`/`db pull` entirely. It corresponds to real, already-existing production tables (`tenants`, `users`, `tiny_credentials`) — not a Rule-1 bug in this plan's own work, but a blocking precondition (Rule 3) for this plan's push to succeed. Fixed by running `supabase migration repair --status reverted 20260729003512`, which only edits the CLI's `supabase_migrations.schema_migrations` tracking metadata — it does not touch or drop the existing tables/data. Chose `reverted` (not `applied`) because the CLI's repair command only accepts those two statuses and there is no local file to associate as 'applied'; this is the CLI's own documented recovery path for this exact error, applied narrowly and only to the pre-existing untracked entry, never to this plan's own migration."
  - "gh CLI is not installed on this machine and no git remote is configured on this repo yet, so the four CI repository secrets (DATABASE_URL, SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_ID, SUPABASE_DB_PASSWORD) could not be auto-provisioned. Documented as a manual follow-up per the plan's explicit fallback."

patterns-established:
  - "supabase migration repair --status reverted/applied is the correct recovery tool when CLI-tracked migration history diverges from local files, without touching actual schema/data - useful precedent for any future migration-history drift in this project."

requirements-completed: []

coverage:
  - id: D1
    description: "pg_cron, pg_net, and pgmq extensions enabled on the production Supabase project via a committed migration"
    verification:
      - kind: other
        ref: "direct pg_extension query against production: pg_cron, pg_net, pgmq all present"
        status: pass
      - kind: other
        ref: "supabase migration list --output-format text: local 20260729225411 == remote 20260729225411"
        status: pass
    human_judgment: false
  - id: D2
    description: "CI smoke-test job wired to run the exact production-shape connection check (scripts/smoke-test-db.ts, unchanged) on every push/PR, with a main-gated deploy job and no generic postgres: service container"
    verification:
      - kind: other
        ref: "deno run --allow-net --allow-env scripts/smoke-test-db.ts (local run against real production project) -> 'SELECT 1 OK via production-shape connection'"
        status: pass
      - kind: other
        ref: "grep -c \"postgres:\" .github/workflows/ci.yml -> 0"
        status: pass
    human_judgment: true
    rationale: "The CI workflow itself has never executed on GitHub Actions (no git remote configured, so no push has triggered it yet) - only the identical local code path has been proven. A human must confirm the workflow actually runs green in GitHub Actions once the repo is pushed and the four secrets are set."

duration: 16min
completed: 2026-07-29
status: complete
---

# Phase 1 Plan 2: Production Migration + CI Smoke-Test Pipeline Summary

**Pushed a real migration enabling `pg_cron`/`pg_net`/`pgmq` to production and wired a GitHub Actions CI pipeline that reuses plan 01-01's exact Transaction-Pooler smoke-test script unchanged, catching a pooler/driver regression automatically instead of it surfacing as a live 500 after deploy.**

## Performance

- **Duration:** ~16 min
- **Started:** 2026-07-29T22:43:47Z
- **Completed:** 2026-07-29T22:59:05Z
- **Tasks:** 2
- **Files modified:** 2 created

## Accomplishments
- `supabase/migrations/20260729225411_enable_queue_extensions.sql` committed and pushed to the real production Supabase project — `pg_cron`, `pg_net`, `pgmq` all confirmed present via a direct `pg_extension` query
- Discovered and safely reconciled a pre-existing orphaned remote migration-history entry (real `tenants`/`users`/`tiny_credentials` tables, untracked locally) that was silently blocking all `supabase db push`/`db pull` operations — fixed via metadata-only `migration repair`, no schema/data touched
- `.github/workflows/ci.yml` committed: `smoke-test` job runs `scripts/smoke-test-db.ts` (plan 01-01's script, unchanged) on every push/PR; `deploy` job gated on `github.ref == 'refs/heads/main'` runs link + `db push` + `functions deploy`
- Locally proved the exact command CI's smoke-test job will run (`deno run --allow-net --allow-env scripts/smoke-test-db.ts`) succeeds against the real production project

## Task Commits

Each task was committed atomically:

1. **Task 1: Enable pg_cron/pg_net/pgmq extensions via a real migration; apply locally (or document the Docker fallback), then push to production** - `8b3b726` (feat)
2. **Task 2: Wire the CI smoke-test + deploy pipeline, reusing plan 01-01's connection script unchanged** - `c1d9a09` (feat)

**Plan metadata:** commit pending (this document + STATE/ROADMAP updates)

## Files Created/Modified
- `supabase/migrations/20260729225411_enable_queue_extensions.sql` - three `create extension if not exists` statements (`pg_cron`, `pg_net`, `pgmq`); queue/cron-schedule creation deliberately deferred to plan 01-03
- `.github/workflows/ci.yml` - `smoke-test` job (checkout, `denoland/setup-deno@v2`, run `scripts/smoke-test-db.ts` with `DATABASE_URL` from repo secrets) + `deploy` job (checkout, `supabase/setup-cli@v1`, link, `db push`, `functions deploy`), main-gated; top comment documents the single-project (no separate staging) decision

## Decisions Made
- Used `supabase db push --dry-run --linked` as the pre-production check since Docker is absent on this machine (documented gap in 01-RESEARCH.md's Environment Availability table) — no local `supabase start`/`migration up` emulation ran.
- Repaired a pre-existing, unrelated migration-history entry (`20260729003512_init_schema`, corresponding to already-existing `tenants`/`users`/`tiny_credentials` tables with no local migration file) via `supabase migration repair --status reverted 20260729003512` — a metadata-only fix to the CLI's tracking table, not a schema change. This was necessary for `db push` to succeed at all; see Deviations below.
- gh CLI unavailable and no git remote configured yet — documented the four required repo secrets as a manual follow-up rather than attempting to auto-provision them.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Repaired orphaned remote migration-history entry blocking `db push`/`db pull`**
- **Found during:** Task 1, immediately after generating the new migration file, while attempting the documented `--dry-run` pre-production check
- **Issue:** `supabase db push --dry-run --linked` failed with `LegacyDbPushMissingLocalError` ("Remote migration versions not found in local migrations directory"). Investigation (`supabase migration list`, then a direct query against `supabase_migrations.schema_migrations` and `information_schema.tables` using the corrected `DATABASE_URL`) showed a remote migration entry `20260729003512_init_schema` with no matching local file, corresponding to three real, already-existing production tables (`tenants`, `users`, `tiny_credentials`) — not created by this plan or by 01-01, and not mentioned in either plan's scope. This is pre-existing infrastructure state, out of this plan's scope to explain, but it directly blocked this plan's required action (pushing the extensions migration).
- **Fix:** Ran `supabase migration repair --status reverted 20260729003512 --linked --yes`, which edits only the CLI's `supabase_migrations.schema_migrations` tracking table — it does not drop or alter `tenants`/`users`/`tiny_credentials` or any other schema object. Chose `reverted` (the CLI's own first-suggested repair, before attempting `db pull`) rather than fabricating a local migration file to claim as `applied`, since the goal was only to unblock this plan's push, not to take ownership of documenting a schema this plan didn't create.
- **Files modified:** None (production database migration-history metadata only, not committed to git since it isn't a file-based change)
- **Verification:** `supabase migration list` post-repair showed only this plan's own migration (`20260729225411`) in the pending list; `db push --dry-run` then correctly reported only that one migration would be applied; the real `db push` succeeded; `tenants`/`users`/`tiny_credentials` tables confirmed still present via `information_schema.tables` before and after (unaffected).
- **Committed in:** N/A (remote DB metadata change, not a git-tracked file)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Necessary to unblock the plan's own required `db push` action. No scope creep — the existing tables were not modified, inspected beyond confirming their presence, or documented further; that ownership belongs to whatever phase/process created them, not this plan.

## Issues Encountered
- The plan's literal verify command for Task 1 (`supabase migration list | grep -c enable_queue_extensions`) returns `0` regardless of success: this CLI version's `migration list` output (both default JSON and `--output-format text`) shows only version timestamps, not filenames, so the filename substring never appears in either format. Verified success instead via `supabase migration list --output-format text` (local `20260729225411` == remote `20260729225411`) and a direct `pg_extension` query confirming all three extensions live — both stronger evidence than the literal grep would have provided.
- No git remote is configured on this repository yet, so `.github/workflows/ci.yml` has never actually run in GitHub Actions — only the identical local code path (`deno run --allow-net --allow-env scripts/smoke-test-db.ts`) has been proven. Flagged as `human_judgment: true` in this SUMMARY's coverage block for that reason.

## User Setup Required
**External services require manual configuration before CI will run successfully:**
- This repository has no git remote configured yet — it must be pushed to a GitHub-hosted repo before `.github/workflows/ci.yml` can execute at all.
- `gh` CLI is not installed on this machine, so the four required repo secrets could not be set automatically. Once the repo exists on GitHub, set these manually via Settings -> Secrets and variables -> Actions:
  - `DATABASE_URL` — the corrected Transaction Pooler connection string (same value plan 01-01 fixed in `.env`)
  - `SUPABASE_ACCESS_TOKEN` — same value as in `.env`
  - `SUPABASE_PROJECT_ID` — the project ref (same value as `.env`'s `SUPABASE_PROJECT_REF`)
  - `SUPABASE_DB_PASSWORD` — same value as in `.env`

## Next Phase Readiness
- `pg_cron`, `pg_net`, `pgmq` extensions are live on production — plan 01-03's Cron/Queue migration (queue creation, `cron.schedule`, Vault secrets) can proceed without re-enabling extensions.
- CI pipeline is committed and its exact connection-check code path is proven locally; it will start running for real once the repo is pushed to GitHub and the four secrets above are set (tracked as manual follow-up, not a blocker for this plan's own completion).
- The `supabase migration repair` recovery pattern used here is available if migration-history drift recurs in later phases.

## Self-Check: PASSED

Both created files confirmed present on disk; both task commit hashes (`8b3b726`, `c1d9a09`) confirmed present in git log.

---
*Phase: 01-infrastructure-connection-foundation*
*Completed: 2026-07-29*
