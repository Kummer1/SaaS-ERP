---
phase: 01-infrastructure-connection-foundation
fixed_at: 2026-07-29T23:59:00Z
review_path: .planning/phases/01-infrastructure-connection-foundation/01-REVIEW.md
iteration: 1
findings_in_scope: 4
fixed: 4
skipped: 0
status: all_fixed
---

# Phase 01: Code Review Fix Report

**Fixed at:** 2026-07-29
**Source review:** .planning/phases/01-infrastructure-connection-foundation/01-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 4 (1 Critical, 3 Warning)
- Fixed: 4
- Skipped: 0

## Fixed Issues

### CR-01: CI never executes the Deno test suite that proves this phase's success criteria

**Files modified:** `.github/workflows/ci.yml`
**Commit:** `0939373`
**Applied fix:** Added a `denoland/setup-deno@v2` step plus a `Run Deno test suite (post-deploy, proves SC-1/SC-3/SC-4)` step to the `deploy` job, placed after `Deploy Edge Functions`. It runs `deno test --allow-net --allow-env tests/` with `DATABASE_URL` and `SUPABASE_PROJECT_REF` env vars (the latter feeds `conftest.ts`'s `getHealthUrl()`). Placed post-deploy rather than in `smoke-test` because `tests/health_test.ts` and `tests/sync_pipeline_test.ts` exercise the deployed Edge Function and the queue schema that only exist after migrations are pushed and functions are deployed — running earlier would fail against a not-yet-provisioned target on first-ever deploy and wouldn't reflect what was just shipped.

### WR-01: `DATABASE_URL`/`SUPABASE_DB_URL` lookup has no runtime validation

**Files modified:** `supabase/functions/_shared/db.ts`, `scripts/smoke-test-db.ts`, `tests/conftest.ts`, `scripts/setup-vault-secrets.ts`
**Commit:** `0732a5b`
**Applied fix:** Replaced the non-null assertion (`!`) on `Deno.env.get("DATABASE_URL") ?? Deno.env.get("SUPABASE_DB_URL")` with an explicit `if (!connectionString) throw new Error(...)` runtime guard in all four files, matching the existing validation pattern already used for `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` in `setup-vault-secrets.ts`. All four files now fail fast with an unambiguous message instead of passing `undefined` into `postgres()`.

### WR-02: Check-then-insert race condition in Vault secret idempotency check

**Files modified:** `scripts/setup-vault-secrets.ts`
**Commit:** `7a9e333`
**Applied fix:** Chose the "accept as low-risk one-time manual script, document the constraint" option from the review's fix menu — this script targets Supabase-managed internal tables (`vault.secrets`/`vault.decrypted_secrets`), so adding a unique constraint or `select ... for update` isn't available/appropriate without touching Supabase-owned schema. Added a detailed "NOT SAFE FOR CONCURRENT EXECUTION" block to the file-level doc comment explaining the race, its downstream effect on the cron migration's non-deterministic secret read, and the operational rule (run by hand, one invocation at a time, never wire into a job that could run it in parallel with itself). Also annotated `ensureSecret()` itself with a pointer back to that note.

### WR-03: Unbounded drain loop in the queue round-trip test can hang indefinitely

**Files modified:** `tests/sync_pipeline_test.ts`
**Commit:** `9e15c59`
**Applied fix:** Replaced the unbounded `while ((await queueDepth(sql)) > 0)` loop with a capped `for (let i = 0; i < 100 && (await queueDepth(sql)) > 0; i++)` loop, followed by an explicit post-loop check that throws `"failed to drain sync_work queue before test assertions (100 pop iterations exhausted)"` if the queue still isn't empty — exactly as suggested in the review. The test now fails fast with a clear message instead of hanging if `pop` ever stops actually removing messages.

## Skipped Issues

None — all in-scope findings were fixed.

---

_Fixed: 2026-07-29_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
