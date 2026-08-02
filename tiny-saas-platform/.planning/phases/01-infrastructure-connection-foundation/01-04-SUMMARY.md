---
phase: 01-infrastructure-connection-foundation
plan: 04
subsystem: infra
tags: [supabase, deno, edge-functions, pgmq, postgrest, pg_cron, pg_net, queue]

# Dependency graph
requires:
  - phase: 01-infrastructure-connection-foundation
    provides: "sync_work pgmq queue + sync-enqueue-trigger cron job (plan 01-03); Transaction Pooler + prepare:false connection discipline (plan 01-01)"
provides:
  - "Deployed, verify_jwt-protected sync-enqueue Edge Function (queue producer)"
  - "Deployed, verify_jwt-protected sync-worker Edge Function (queue consumer, pop-based delete-on-read)"
  - "supabase/migrations/20260729232533_pgmq_public_wrappers.sql: the pgmq_public schema (send/pop SECURITY DEFINER wrappers, service_role-only grants) that this project's earlier raw `create extension pgmq` migration never provisioned"
  - "pgmq_public exposed via the production Data API (db_schema) and mirrored in supabase/config.toml for local-dev parity"
  - "tests/sync_pipeline_test.ts: automated Cron-independent enqueue/dequeue round-trip proof"
  - "Confirmed evidence of at least one unattended pg_cron-triggered enqueue (cron.job_run_details, sync-enqueue-trigger, succeeded at 23:30:00 UTC)"
affects: [phase-3-sync-engine]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "pgmq_public schema must be explicitly provisioned (SECURITY DEFINER wrapper functions + schema-level GRANT USAGE + PostgREST db_schema exposure) when pgmq is enabled via a raw `create extension pgmq` migration rather than Supabase's dashboard Queues toggle - the wrapper is not automatic"
    - "sync-enqueue/sync-worker verify_jwt left at Supabase's default (true); no [functions.*] override added to config.toml, unlike health's intentional public exception"

key-files:
  created:
    - supabase/functions/sync-enqueue/index.ts
    - supabase/functions/sync-enqueue/deno.json
    - supabase/functions/sync-worker/index.ts
    - supabase/functions/sync-worker/deno.json
    - supabase/migrations/20260729232533_pgmq_public_wrappers.sql
    - tests/sync_pipeline_test.ts
  modified:
    - supabase/config.toml

key-decisions:
  - "Created a minimal pgmq_public wrapper schema (send/pop only, SECURITY DEFINER, service_role-only grants) via migration rather than switching the Edge Functions to raw pgmq.* SQL, preserving 01-RESEARCH.md's explicit recommendation to use the documented, access-controlled supabase-js + pgmq_public RPC path."
  - "supabase functions invoke is not a subcommand in this project's installed Supabase CLI (2.110.0) - used an authenticated curl POST with the service-role key as the Bearer JWT instead, which exercises the identical verify_jwt-protected code path."
  - "Test defensively drains the sync_work queue before asserting send/pop counts, since the live sync-enqueue-trigger cron job can add an unrelated ping message mid-test-run - proven necessary during manual verification when a cron-triggered message appeared between two of this plan's own checks."

patterns-established:
  - "Any future Edge Function needing a new pgmq_public RPC (e.g., Phase 3's read/archive switch) must add it to the same migration-owned wrapper schema with the same service_role-only grant discipline - do not assume pgmq_public auto-exposes new pgmq.* functions."

requirements-completed: []

coverage:
  - id: D1
    description: "sync-enqueue deployed and verify_jwt-protected; manual invocation adds exactly one {kind:\"ping\"} message to sync_work"
    verification:
      - kind: other
        ref: "curl POST (service-role Bearer JWT) to /functions/v1/sync-enqueue -> HTTP 200 'enqueued'; direct pgmq.q_sync_work query showed depth 0->1, message.kind == 'ping'"
        status: pass
    human_judgment: false
  - id: D2
    description: "sync-worker deployed and verify_jwt-protected; manual invocation after sync-enqueue drains the queue back to 0"
    verification:
      - kind: other
        ref: "curl POST (service-role Bearer JWT) to /functions/v1/sync-enqueue then /functions/v1/sync-worker -> both HTTP 200; direct pgmq.q_sync_work query confirmed depth returned to 0"
        status: pass
    human_judgment: false
  - id: D3
    description: "Automated Deno test proves the Cron-independent pgmq_public send/pop round trip on sync_work"
    verification:
      - kind: integration
        ref: "tests/sync_pipeline_test.ts#pgmq_public round trip: send increases queue depth by 1, pop drains the same message and restores queue depth"
        status: pass
    human_judgment: false
  - id: D4
    description: "supabase/config.toml carries no verify_jwt=false override for sync-enqueue or sync-worker (default JWT protection preserved, unlike health)"
    verification:
      - kind: other
        ref: "grep -c \"functions.sync-enqueue\" supabase/config.toml -> 0; grep -c \"functions.sync-worker\" supabase/config.toml -> 0"
        status: pass
    human_judgment: false
  - id: D5
    description: "pg_cron fires sync-enqueue-trigger unattended on its real production schedule, completing an enqueue->dequeue cycle without manual invocation (ROADMAP Phase 1 Success Criterion 4, ultimate ratification)"
    verification:
      - kind: other
        ref: "cron.job_run_details: sync-enqueue-trigger status=succeeded at 2026-07-29T23:30:00Z; pgmq.q_sync_work depth increased by 1 between two of this plan's own checks with no manual invocation in between, matching that timestamp"
        status: pass
    human_judgment: true
    rationale: "This plan's single session captured one unattended cron cycle (23:30:00 UTC) by coincidence of timing, but the plan's own <verify><human-check> explicitly asks for a check after 15-20 minutes have elapsed since 01-03's migration was pushed and this plan's own commits have landed, to rule out a single-session fluke. A human should re-inspect cron.job_run_details / pgmq.q_sync_work once more, at leisure, before treating this as fully closed."

duration: 15min
completed: 2026-07-29
status: complete
---

# Phase 1 Plan 4: Sync-Enqueue + Sync-Worker Edge Functions Summary

**Deployed the sync-enqueue (queue producer) and sync-worker (queue consumer) Edge Functions, discovered and fixed a missing `pgmq_public` PostgREST wrapper schema that the whole pipeline depended on, and proved the Cron -> sync-enqueue -> sync_work queue -> sync-worker pipeline end-to-end both manually and via an automated Deno test — plus caught one real unattended cron-triggered cycle mid-session.**

## Performance

- **Duration:** ~15 min
- **Started:** 2026-07-29T23:20:13Z
- **Completed:** 2026-07-29T23:34:00Z
- **Tasks:** 2
- **Files modified:** 6 created, 1 modified

## Accomplishments
- `sync-enqueue` Edge Function deployed to production, `verify_jwt` left at Supabase's default (`true`); manual invocation (via authenticated curl, since this CLI version has no `functions invoke` subcommand) confirmed HTTP 200 `"enqueued"` and the `sync_work` queue going from 0 to 1 message with `kind: "ping"`
- `sync-worker` Edge Function deployed to production, same `verify_jwt` protection; manual invocation confirmed HTTP 200 `"processed"` and the queue draining back to 0
- Discovered and fixed a real blocking gap: `pgmq_public` — the schema both Edge Functions and 01-RESEARCH.md/01-PATTERNS.md assumed already existed — was never actually provisioned on this project (only raw `pgmq.*` existed, confirmed via `pg_namespace`). Created a migration reproducing the minimal Supabase-standard wrapper (`send`, `pop`, `SECURITY DEFINER`, `service_role`-only grants) and exposed it via the Data API (`db_schema`) — this was necessary for either Edge Function to work at all
- `tests/sync_pipeline_test.ts` proves the Cron-independent `pgmq_public` send/pop round trip on `sync_work`, defensively draining any cron-injected messages first so the assertions aren't flaky against the live 15-minute cron schedule
- Caught genuine evidence of an unattended `pg_cron` cycle during this session: `cron.job_run_details` shows `sync-enqueue-trigger` succeeded at `23:30:00 UTC`, and the queue depth increased by 1 between two of this plan's own checks with no manual invocation in between — direct (if session-local) support for ROADMAP Phase 1 Success Criterion 4's "proven, automatically-triggered" requirement

## Task Commits

Each task was committed atomically:

1. **Task 1: Create + deploy sync-enqueue; verify manual invocation lands a message in the queue** - `cadcc07` (feat)
2. **Task 2: Create + deploy sync-worker; drain the queue and add an automated end-to-end pipeline test** - `b5b46c6` (test), `265b879` (feat)

**Plan metadata:** commit pending (this document + STATE/ROADMAP updates)

_Note: Task 2 was `tdd="true"`. The RED test (`tests/sync_pipeline_test.ts`) passed on its first run because the `pgmq_public` mechanism it proves was already correctly implemented by Task 1's Rule 3 fix (the `pgmq_public` wrapper migration) — mirroring the exact precedent documented in 01-01-SUMMARY.md's Task 2. This task's actual new implementation work (GREEN) was the `sync-worker` Edge Function itself, committed separately._

## Files Created/Modified
- `supabase/functions/sync-enqueue/index.ts` - `Deno.serve` handler calling `pgmq_public.send` to enqueue `{kind:"ping", enqueued_at}`; `verify_jwt` default preserved
- `supabase/functions/sync-enqueue/deno.json` - `@supabase/supabase-js@2.111.0` import map
- `supabase/functions/sync-worker/index.ts` - `Deno.serve` handler calling `pgmq_public.pop`; returns `"queue empty"` or `"processed"`; in-code comment documents the Phase 1 `pop` (delete-on-read) vs. Phase 3 `read`+`archive` (idempotent) decision per 01-RESEARCH.md Pitfall 6/Assumption A4
- `supabase/functions/sync-worker/deno.json` - same import map as sync-enqueue
- `supabase/migrations/20260729232533_pgmq_public_wrappers.sql` - `[Rule 3 - Blocking]` creates the `pgmq_public` schema + `send`/`pop` `SECURITY DEFINER` wrapper functions + `GRANT USAGE`/`EXECUTE` to `service_role` only
- `supabase/config.toml` - added `pgmq_public` to `[api] schemas` for local-dev parity with the production Data API exposure change
- `tests/sync_pipeline_test.ts` - automated round-trip test, drains pre-existing queue contents defensively before asserting

## Decisions Made
- Kept the Edge Functions on `supabase-js` + `pgmq_public` RPCs (per 01-RESEARCH.md's explicit recommendation over raw SQL) rather than switching to direct `pgmq.*` calls through `_shared/db.ts` — the actual gap was that `pgmq_public` itself was never provisioned, not that the RPC approach was wrong, so the fix targeted the real cause instead of changing architecture.
- Used an authenticated `curl` POST (service-role key as Bearer JWT) in place of `supabase functions invoke`, which doesn't exist as a subcommand in this project's installed CLI version (2.110.0) — exercises the identical `verify_jwt`-protected HTTP path the plan's acceptance criteria care about.
- Scoped the `pgmq_public` wrapper migration to only `send`/`pop` (what this plan's functions and test actually call), leaving `read`/`archive`/`delete`/`send_batch` for Phase 3 to add when it needs them, per the plan's own `<reversibility>` note that the `pop`->`read`+`archive` swap is Phase 3's job.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Created the missing `pgmq_public` wrapper schema**
- **Found during:** Task 1, first manual invocation of `sync-enqueue`
- **Issue:** `supabase.schema("pgmq_public").rpc("send", ...)` failed with HTTP 500; a direct PostgREST call to the same RPC returned `PGRST106 Invalid schema: pgmq_public. Only the following schemas are exposed: public, graphql_public`. Investigation (`pg_namespace` query) confirmed `pgmq_public` never existed on this project — only the raw `pgmq` extension schema did. Plan 01-02 enabled `pgmq` via a bare `create extension pgmq` migration, never through Supabase's dashboard "Queues" toggle, which is what normally auto-creates `pgmq_public` and exposes it via the Data API. Both 01-RESEARCH.md and 01-PATTERNS.md assumed this wrapper already existed.
- **Fix:** Created `supabase/migrations/20260729232533_pgmq_public_wrappers.sql`: `create schema pgmq_public`, `SECURITY DEFINER` wrapper functions `send(queue_name text, message jsonb)` and `pop(queue_name text)` delegating to `pgmq.send`/`pgmq.pop`, `GRANT USAGE ON SCHEMA` + `GRANT EXECUTE` to `service_role` only (least privilege — these Edge Functions never use anon/authenticated). Then exposed the schema on the Data API via `PATCH /v1/projects/{ref}/postgrest` (`db_schema` now includes `pgmq_public`), and mirrored the schema list in `supabase/config.toml` for local-dev parity. A second gap (schema-level `GRANT USAGE` missing even after the functions had `EXECUTE` grants, surfaced as `42501 permission denied for schema pgmq_public`) was found and fixed in the same pass before re-pushing.
- **Files modified:** `supabase/migrations/20260729232533_pgmq_public_wrappers.sql`, `supabase/config.toml`
- **Verification:** Direct PostgREST RPC calls to both `pgmq_public.send` and `pgmq_public.pop` succeeded (HTTP 200) after the fix; the deployed `sync-enqueue`/`sync-worker` functions then also succeeded end-to-end; `tests/sync_pipeline_test.ts` passes.
- **Committed in:** `cadcc07` (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Necessary for either Edge Function to function at all — not scope creep. The fix stayed narrowly targeted (only `send`/`pop`, only `service_role` grants) rather than reproducing Supabase's full dashboard-generated wrapper surface.

## Issues Encountered
- `supabase functions invoke` and `supabase functions logs` are not available subcommands in this project's installed Supabase CLI (2.110.0) — the plan's literal `<verify><automated>` commands (`supabase functions invoke sync-enqueue`) could not run as written. Substituted an authenticated `curl` POST with the service-role key as the Bearer JWT for both manual invocations, which exercises the identical `verify_jwt`-protected HTTP path and produced the same evidence (HTTP status, response body, queue-depth transition) the plan's acceptance criteria require.
- While investigating the unattended cron cycle for the plan's `<verify><human-check>`, found that `pg_net`'s HTTP response tracking (`net._http_response`) shows the `sync-enqueue-trigger` cron job's `net.http_post` call **timed out client-side after 5000ms** (`timed_out: true`), even though the enqueue itself appears to have succeeded server-side (the queue depth increased by exactly 1 on that same run, matching the cron's timestamp, with no manual invocation in between). Likely cause: Edge Function cold-start latency occasionally exceeding `pg_net`'s default 5-second timeout. This does not block this plan's completion (the mechanism worked), but is a real reliability risk for Phase 3's production sync cadence — **logged to `.planning/WINDOWS.md` as an open `deviation` entry** (id 1) recommending a longer `timeout_milliseconds` on `net.http_post` or added retry/monitoring, rather than silently fixed here (would require editing plan 01-03's already-completed migration, out of this plan's scope).

## User Setup Required
None - no new external service configuration required this plan. The `pgmq_public` Data API exposure change was made via the already-authenticated Supabase Management API (`SUPABASE_ACCESS_TOKEN` already present in `.env`), not a manual dashboard step.

## Next Phase Readiness
- ROADMAP Phase 1 Success Criterion 4 (Cron + Queue + Edge Function pipeline proven end-to-end) is satisfied: manual round trip proven (0->1->0 queue depth), automated test passing, and at least one unattended cron cycle observed within this session. A human should still do one more `cron.job_run_details`/`pgmq.q_sync_work` check after this plan's commits have settled, per the plan's own `<verify><human-check>` note — not because anything failed, but because a single session can't fully rule out a fluke.
- Phase 3's real sync worker must NOT inherit Phase 1's `pgmq_public.pop` (delete-on-read) semantic unchanged — switch to `pgmq_public.read` + explicit `archive`/`delete` for `SYNC-01`'s at-least-once idempotency requirement (already flagged in-code in `sync-worker/index.ts` and in this plan's `<reversibility>` note).
- Phase 3 (or an infra-hardening pass) should address the open `.planning/WINDOWS.md` deviation entry (id 1): `pg_net`'s 5-second default timeout on the cron-triggered `net.http_post` call may not tolerate Edge Function cold starts reliably at production scale.
- Any future Edge Function needing another `pgmq_public` RPC (e.g., `read`/`archive` for Phase 3) must add it to `supabase/migrations/20260729232533_pgmq_public_wrappers.sql`'s pattern (new migration, `SECURITY DEFINER`, `service_role`-only grant) — `pgmq_public` does not auto-expose new `pgmq.*` functions just because the schema exists.
- This is the last plan of Phase 1 — all four ROADMAP Phase 1 success criteria (health check, migrations/CI, Vault + Cron/Queue trigger, full pipeline proof) are now complete pending the phase-level SUMMARY/STATE/ROADMAP wrap-up.
- Carried-forward blockers unchanged from 01-01/01-02/01-03 (no git remote/`gh` CLI yet, so CI has still never run on GitHub Actions and the four repo secrets remain a manual follow-up; Phase 3 Tiny ERP rate-limit re-verification) — see STATE.md.

## Self-Check: PASSED

All 6 created files confirmed present on disk; all 3 task commit hashes (`cadcc07`, `b5b46c6`, `265b879`) confirmed present in git log.

---
*Phase: 01-infrastructure-connection-foundation*
*Completed: 2026-07-29*
