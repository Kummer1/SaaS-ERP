---
phase: 1
slug: infrastructure-connection-foundation
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-07-28
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
>
> **Regenerated 2026-07-28** — the prior version of this file assumed the superseded Python/FastAPI/Alembic/Render architecture. Rewritten for the Supabase Edge Functions (Deno/TypeScript) + Cron + Queue architecture locked in `01-CONTEXT.md`.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Deno's built-in test runner (`deno test`) — native to the Edge Functions runtime, no extra dependency (not yet installed — greenfield project) |
| **Config file** | none yet — create `supabase/functions/deno.jsonc` test config in Wave 0 |
| **Quick run command** | `deno test --allow-net --allow-env -x` (fail-fast on first test file) |
| **Full suite command** | `deno test --allow-net --allow-env` |
| **Estimated runtime** | ~10 seconds (2-3 tests at Wave 0) |

---

## Sampling Rate

- **After every task commit:** Run `deno test --allow-net --allow-env -x`
- **After every plan wave:** Run `deno test --allow-net --allow-env`
- **Before `/gsd-verify-work`:** Full suite must be green, plus manual confirmation that the Edge Functions deploy successfully via `supabase functions deploy` and `/health` responds at the public URL
- **Max feedback latency:** ~10 seconds

---

## Per-Task Verification Map

Phase 1 has no formal `REQ-XX` IDs (per `REQUIREMENTS.md` traceability table — Phase 1 carries zero direct requirement mappings by design; it de-risks the Postgres pooler/driver-connection bug class for every later phase). Mapped to this phase's four success criteria (`ROADMAP.md`) instead:

| Success Criterion | Behavior | Test Type | Automated Command | File Exists | Status |
|--------------------|-----------|-----------|----------------------|---------------|--------|
| SC-1: Health-check Edge Function responds at public URL | `GET /functions/v1/health` returns 200 with DB connectivity confirmed | integration | `deno test tests/health_test.ts -x` | ❌ W0 | ⬜ pending |
| SC-2: Schema migrations run against Supabase (local + prod) | Project's chosen migration tool (e.g. `supabase migration up`) succeeds via the Transaction Pooler connection | manual (run once locally, once via CI/deploy step) | `supabase migration up` (or chosen tool) | N/A — CLI command | ⬜ pending |
| SC-3: CI smoke test runs `SELECT 1` via prod-shape connection | `SELECT 1` succeeds through the same `postgres.js` client + Transaction Pooler (`{ prepare: false }`) config used in production | integration, automated in CI | `deno test tests/db_connection_test.ts` | ❌ W0 | ⬜ pending |
| SC-4: Cron → enqueue → Queue → worker pipeline proven end-to-end | `pg_cron` triggers the enqueue Edge Function, a message lands in the `pgmq` queue, and the worker Edge Function successfully dequeues and processes it | integration (exercised manually + logged), with an automated assertion on queue drain | `deno test tests/sync_pipeline_test.ts` + manual check of `pgmq` queue depth before/after | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `supabase/functions/deno.jsonc` — Deno test/lint configuration
- [ ] `tests/conftest.ts` (or equivalent shared test setup) — shared fixtures (e.g. test Postgres client)
- [ ] `tests/health_test.ts` — stub covering SC-1
- [ ] `tests/db_connection_test.ts` — stub covering SC-3, must use the `DATABASE_URL`/connection secret from CI env, not a hardcoded local string
- [ ] `tests/sync_pipeline_test.ts` — stub covering SC-4 (Cron/Queue/worker pipeline)
- [ ] Framework install: none required beyond Deno itself (bundled test runner) — Supabase CLI install for local dev/deploy

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|--------------------|
| Migrations succeed against Supabase (SC-2) | ROADMAP Phase 1 SC-2 | Migration execution is a CLI/operational step, not a unit-testable behavior; must be confirmed once locally and once in the deploy pipeline | Run the chosen migration command locally against the Transaction Pooler connection string, then confirm the same command succeeds as part of the CI/deploy step |
| Cron actually fires on schedule in production (SC-4) | ROADMAP Phase 1 SC-4 | Depends on real elapsed time and Supabase's own `pg_cron` scheduler running in production — not fully reproducible in a single CI run | After deploy, inspect `pg_cron`'s job run history (or Supabase dashboard) to confirm the enqueue function was invoked on schedule, and check `pgmq` queue metrics for successful consumption |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 10s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
