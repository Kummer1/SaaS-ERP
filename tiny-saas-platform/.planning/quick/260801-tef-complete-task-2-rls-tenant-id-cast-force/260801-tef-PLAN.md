---
quick_id: 260801-tef
type: quick
autonomous: true
files_modified:
  - scripts/verify-rls-local-isolation.ts

must_haves:
  truths:
    - "A local Postgres instance freshly reset via `supabase db reset` has the corrective migration (20260801234106_fix_rls_tenant_id_cast_and_grants.sql) applied, proven by re-running it end to end rather than only inspecting the SQL text."
    - "A two-fake-tenant isolation test run as the `authenticated` role (not the bypassing `postgres` superuser) shows tenant A's session sees only tenant A's row and tenant B's session sees only tenant B's row, with zero cross-tenant leakage."
    - "A RESET/empty-string fail-closed test run as `authenticated` returns zero rows and does NOT throw `invalid input syntax for type uuid` — the exact regression this whole fix targets — proven against a live-running local Postgres instance, not just read as SQL text."
    - "Only after all local checks above pass does `supabase db push` (live, no --dry-run) apply the migration to the linked production project, and `scripts/verify-rls-tenant-fix.ts` confirms it live."
  artifacts:
    - scripts/verify-rls-local-isolation.ts
  key_links:
    - "supabase db reset -> reapplies every supabase/migrations/*.sql in order, including 20260801234106_fix_rls_tenant_id_cast_and_grants.sql -> local DB state matches exactly what Task 2 pushes live"
    - "Task 1 full pass (reset + isolation + fail-closed, captured verbatim) -> hard precondition gating Task 2's live push, not just prose"
---

<objective>
Close out the deferred half of quick task 260801-sg0 (see `.planning/STATE.md` Pending Todos and `.planning/quick/260801-sg0-fix-rls-tenant-id-cast-replace-current-s/260801-sg0-SUMMARY.md`'s "Deferred: Live Push" section), but insert a manual local safety gate before touching the live/production Supabase project.

The RLS `tenant_id` cast fix, `FORCE ROW LEVEL SECURITY`, and `authenticated` grants were authored and dry-run-verified in 260801-sg0 but never actually exercised against a running Postgres instance — only inspected as SQL text and dry-run-checked. Docker is now running locally (confirmed: `docker ps` shows a healthy `supabase_db_tiny-saas-platform` container on port 54322), so this plan first proves the fix works for real against a freshly-reset LOCAL database, then — only if that proof passes — pushes to production and runs the existing live-verification script.

Purpose: never push a schema change to a live, shared multi-tenant database without having actually run the regression test it claims to fix, at least once, against a real Postgres instance.

Output: a new `scripts/verify-rls-local-isolation.ts` local-only diagnostic (permanently useful for any future RLS-touching migration), the corrective migration applied live, and a SUMMARY.md containing the verbatim output of every command run — not paraphrased pass/fail.
</objective>

<execution_context>
@$HOME/.claude/gsd-core/workflows/execute-plan.md
@$HOME/.claude/gsd-core/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@.claude/CLAUDE.md
@supabase/migrations/20260801234106_fix_rls_tenant_id_cast_and_grants.sql
@supabase/migrations/20260729003512_init_schema.sql
@scripts/verify-rls-tenant-fix.ts
@scripts/smoke-test-db.ts
@.planning/quick/260801-sg0-fix-rls-tenant-id-cast-replace-current-s/260801-sg0-SUMMARY.md

Local environment facts confirmed during planning (do not re-derive, just use):
- `supabase status` reports the local `DB_URL` as `postgresql://postgres:postgres@127.0.0.1:54322/postgres`.
- `supabase/config.toml` has `[db.pooler] enabled = false` — the local stack has no Transaction Pooler, so this is a direct, unpooled connection (unlike production, which is always accessed via port 6543).
- `.env`'s `DATABASE_URL` already holds the LIVE project's Transaction Pooler connection string (per STATE.md's decision log: "Corrected DATABASE_URL in .env to the Transaction Pooler connection string"), and Deno 2.9.4 auto-loads `.env` from the repo root on every `deno run` — confirmed by running a harmless `Deno.env.get("DATABASE_URL")` probe during planning, which resolved without any explicit `--env-file` flag or manual export. This means any script that reads `DATABASE_URL`/`SUPABASE_DB_URL` from the environment talks to PRODUCTION by default in this repo, right now.
- A read-only planning-time query against the local DB confirmed: `postgres` and `service_role` both have `rolbypassrls = true` (they bypass RLS entirely, FORCE or not); `authenticated` has `rolbypassrls = false`, `rolcanlogin = false`, and already has `USAGE` on the `public` schema. A superuser can freely `SET ROLE authenticated` without being a member of that role.
- That same read-only query also showed the local DB's current policy/grant state is stale/partial relative to the migration files on disk (e.g. `tenant_self_read` and `tenant_isolation_tiny_credentials` still showed the pre-fix cast, while `authenticated` had inconsistent grants) — this is exactly why Task 1 must start with `supabase db reset`, not test against whatever is currently sitting in the local DB.
</context>

<tasks>

<task type="auto">
  <name>Task 1: Reset local DB, then prove the RLS fix works against a real running instance</name>
  <files>scripts/verify-rls-local-isolation.ts</files>
  <read_first>scripts/verify-rls-tenant-fix.ts, supabase/migrations/20260801234106_fix_rls_tenant_id_cast_and_grants.sql</read_first>
  <precondition>Docker Desktop and the local Supabase stack must already be running (confirmed at planning time via `docker ps` showing `supabase_db_tiny-saas-platform` bound to 0.0.0.0:54322). Assert this with `docker ps` before running `supabase db reset` — if the local stack is not up, halt and report rather than attempting to start Docker yourself.</precondition>
  <action>
Step A — reset the local database. Run `supabase db reset` from the repo root (no `--linked` flag — that would target the remote project, which is not the intent here). This drops and recreates the local Postgres database and reapplies every file in `supabase/migrations/` in filename order, including `20260801234106_fix_rls_tenant_id_cast_and_grants.sql` (the corrective migration under test), followed by `supabase/seed.sql` if one exists. Capture the full command output verbatim — this is the first block that must be pasted verbatim into the SUMMARY. If the command exits non-zero or reports any migration failure, STOP immediately: do not proceed to Step B, Step C, or Task 2, and report the exact failure output instead.

Step B — write `scripts/verify-rls-local-isolation.ts`. Model its header comment and `postgres` import on `scripts/verify-rls-tenant-fix.ts` (`import postgres from "npm:postgres@3.4.9"`), but deliberately do NOT read `DATABASE_URL`/`SUPABASE_DB_URL` from the environment the way the other scripts in `scripts/` do — that variable holds the LIVE project's connection string in this repo's `.env` (see `<context>` above), and this script must be structurally incapable of touching production. Instead hardcode the literal local connection string `postgresql://postgres:postgres@127.0.0.1:54322/postgres`, and add a guard at the very top of the script that throws immediately if that literal string does not contain the substring `127.0.0.1:54322` — a belt-and-suspenders check that survives even a careless future edit of this file. Construct the client with `{ prepare: false }` for consistency with the project's one enforced connection convention, even though this direct, unpooled local connection does not strictly require it.

Using the default `sql` template-tag connection (which authenticates as the local `postgres` superuser — confirmed `rolbypassrls = true`, so it can write freely regardless of the new RLS policies), insert two disposable fake tenant rows into `tenants` (only the `name` column needs a value; `id`/`plan`/`created_at` all have defaults) — name them distinctly and traceably, e.g. `'Fake Tenant A - quick-260801-tef'` and `'Fake Tenant B - quick-260801-tef'` — using `RETURNING id`, and capture both generated UUIDs in variables. Then insert one row into `users` per tenant (`tenant_id` = that tenant's captured UUID, `email` distinct per tenant e.g. `'fake-a@quick-260801-tef.test'` / `'fake-b@quick-260801-tef.test'`, `hashed_password` any non-null placeholder string since this is structural test data only, not real auth) using `RETURNING id, tenant_id, email`. Log every insert's returned row to the console immediately, verbatim.

Two-fake-tenant isolation test (exercises `tenant_isolation_users`, which carries the identical `nullif(current_setting('app.tenant_id', true), '')::uuid` expression as `tenant_self_read` and `tenant_isolation_tiny_credentials` — testing this one policy is representative of all three, since the migration applied the identical cast fix to all three): open a database transaction, and inside it run, in order: `SET LOCAL ROLE authenticated` (this is the single most important line in the script — the connecting `postgres` role has `rolbypassrls = true` and would silently ignore every RLS policy if this line were skipped, making the whole test a false pass), then `select set_config('app.tenant_id', <tenant-A-uuid>, true)` (the parameterizable, injection-safe equivalent of `SET LOCAL app.tenant_id = '<uuid>'`), then `SELECT id, tenant_id, email FROM users ORDER BY email`. Log the exact rows returned to the console. Repeat in a second, separate transaction using tenant B's UUID instead. Assert programmatically, throwing a descriptive `Error` naming exactly which assertion failed and what was found instead if any of these do not hold: the tenant-A transaction returns exactly one row and its `tenant_id` equals tenant A's captured UUID; the tenant-B transaction returns exactly one row and its `tenant_id` equals tenant B's captured UUID; neither result set contains a row belonging to the other tenant.

RESET / empty-string fail-closed test — two scenarios, each in its own fresh transaction, each starting with `SET LOCAL ROLE authenticated` for the same reason as above:
  (1) literal RESET scenario — run `SET LOCAL app.tenant_id = '<tenant-A-uuid>'` (any valid tenant UUID) followed by the literal SQL statement `RESET app.tenant_id`, then `SELECT id, tenant_id, email FROM users`.
  (2) explicit empty-string scenario — this is the direct reproduction of the exact value that crashed the pre-fix `::uuid` cast in production pooled-connection paths: run `select set_config('app.tenant_id', '', true)`, then the same `SELECT`.
For both scenarios, log the exact query and result verbatim, and wrap each in a try/catch: if it throws, inspect the error message — if it contains the substring `invalid input syntax for type uuid`, throw a new `Error` explicitly stating the original regression reproduced (the fix did not work) and quoting that message; any other unexpected error should be rethrown as-is. If no error is thrown, assert the returned row count is exactly zero, throwing a descriptive `Error` with the actual rows found if not.

If every assertion above passes, `console.log` one final line stating all local checks passed (two-tenant isolation with zero cross-tenant leakage, plus both RESET and empty-string fail-closed scenarios returning zero rows with no cast error), then `await sql.end()`.

Step C — run it and capture output. Execute `deno run --allow-net --allow-env scripts/verify-rls-local-isolation.ts` from the repo root. Capture its full stdout verbatim — every inserted row, every logged query result, the final confirmation line. This is the second block that must be pasted verbatim into the SUMMARY (isolation test + RESET/empty-string fail-closed test together, since they come from one script run). If the script throws or exits non-zero for any reason, STOP immediately: report the exact error text, and do NOT proceed to Task 2 under any circumstances — this local gate exists specifically to prevent an unproven fix from reaching the live, shared production database. Local test data (the two fake tenants/users) does not need cleanup — it is disposable and wiped by the next `supabase db reset`.
  </action>
  <verify>
    <automated>deno run --allow-net --allow-env scripts/verify-rls-local-isolation.ts</automated>
  </verify>
  <done>`supabase db reset` completed successfully against the local stack (all migrations including 20260801234106_fix_rls_tenant_id_cast_and_grants.sql applied). `scripts/verify-rls-local-isolation.ts` exists, runs to completion with exit code 0, and its output — captured verbatim — proves: (a) tenant A's session sees only its own row and tenant B's session sees only its own row, with zero cross-tenant leakage, and (b) both the literal-RESET and explicit-empty-string scenarios return zero rows without throwing `invalid input syntax for type uuid`. All three raw outputs (reset, isolation test, fail-closed test) are pasted verbatim into the SUMMARY, not paraphrased.</done>
</task>

<task type="auto">
  <name>Task 2: Push the corrective migration live and verify with the existing script — gated on Task 1</name>
  <files>(none created or modified — this task only runs `supabase db push` and the pre-existing `scripts/verify-rls-tenant-fix.ts` against the live project)</files>
  <read_first>scripts/verify-rls-tenant-fix.ts</read_first>
  <precondition>Task 1 must have completed with every local check passing: `supabase db reset` succeeded, and `deno run --allow-net --allow-env scripts/verify-rls-local-isolation.ts` exited 0 showing correct two-tenant isolation and both RESET/empty-string fail-closed scenarios returning zero rows with no cast error. Do not run this task speculatively, in parallel with Task 1, or "just to see" — if Task 1 failed, was skipped, or behaved unexpectedly in any way, halt and report instead of proceeding. This precondition is the entire point of this quick task.</precondition>
  <action>
Run `supabase db push` (no `--dry-run`) from the repo root against the linked live project. This applies `supabase/migrations/20260801234106_fix_rls_tenant_id_cast_and_grants.sql` — per 260801-sg0's own dry-run check, it is the only migration currently pending against the live project. Capture the full command output verbatim — this is the third block that must be pasted verbatim into the SUMMARY. If the command errors, STOP immediately and report the exact failure; do not attempt any workaround, retry with different flags, or force anything.

Then run `deno run --allow-net --allow-env scripts/verify-rls-tenant-fix.ts` from the repo root — the pre-existing, already-authored diagnostic from quick task 260801-sg0 (do not modify it). It reads `DATABASE_URL` from the environment, which resolves to the live project's connection string in this repo (see `<context>`), and it is safe to run directly against production: it performs only read-only `SELECT` queries against the system catalogs `pg_policies`, `pg_class`/`pg_namespace`, and `information_schema.role_table_grants` — no writes, no test data inserted anywhere, live or local. Capture its full output verbatim — this is the fourth block that must be pasted verbatim into the SUMMARY. Confirm it exits 0 and prints its single confirmation line stating the cast fix, FORCE ROW LEVEL SECURITY, and authenticated SELECT grants are all verified present on `tenants`, `users`, and `tiny_credentials`.
  </action>
  <verify>
    <automated>deno run --allow-net --allow-env scripts/verify-rls-tenant-fix.ts</automated>
  </verify>
  <done>`supabase db push` applied `20260801234106_fix_rls_tenant_id_cast_and_grants.sql` to the live project with no errors, and `deno run --allow-net --allow-env scripts/verify-rls-tenant-fix.ts` exits 0 against production, printing its confirmation line — completing the live push and verification that quick task 260801-sg0's Task 2 deferred. Both raw command outputs are pasted verbatim into the SUMMARY.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|--------------|
| Local test script -> local Postgres (127.0.0.1:54322) | Disposable, superuser-authenticated connection to the Docker-hosted local stack only; never leaves the machine |
| Executor commands -> live Supabase project (via `supabase` CLI / `DATABASE_URL`) | `supabase db push` and `scripts/verify-rls-tenant-fix.ts` touch the shared production database — the highest-consequence boundary in this plan |

## STRIDE Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation Plan |
|-----------|----------|-----------|----------|-------------|------------------|
| T-tef-01 | Tampering | scripts/verify-rls-local-isolation.ts connection string | high | mitigate | Hardcode the local-only connection string and add a startup guard asserting it contains `127.0.0.1:54322`; the script never reads `DATABASE_URL`/`SUPABASE_DB_URL` (which resolves to the live connection string in this repo), making it structurally incapable of writing test data to production. |
| T-tef-02 | Elevation of Privilege | isolation/fail-closed test role handling | medium | mitigate | Every test transaction runs `SET LOCAL ROLE authenticated` before setting `app.tenant_id`, since the connecting `postgres` role has `rolbypassrls = true` (confirmed via planning-time `pg_roles` query) and would silently bypass RLS — producing a false pass — if role-switching were omitted. |
| T-tef-03 | Denial of Service | RLS fail-closed regression under an empty-string `app.tenant_id` | critical | mitigate | The explicit `set_config('app.tenant_id', '', true)` scenario directly reproduces the literal value that crashed the pre-fix `::uuid` cast (`invalid input syntax for type uuid`) and asserts it now denies access (zero rows) instead of throwing — the exact regression this quick task exists to prove, tested against a real running instance rather than only read as SQL text. |
| T-tef-04 | Tampering | Live migration push executed without a proven local pass | critical | mitigate | Task 2 carries an explicit `<precondition>` requiring Task 1's full local pass (reset + isolation + fail-closed, captured verbatim) before touching the live project; the executor is instructed to halt and report on any local failure rather than proceed. |
| T-tef-SC | Tampering | npm/pip/cargo installs | n/a | accept | No new package installs in this plan — `scripts/verify-rls-local-isolation.ts` reuses the already-audited `npm:postgres@3.4.9` import already in use by `scripts/verify-rls-tenant-fix.ts` and `scripts/smoke-test-db.ts`. |
</threat_model>

<verification>
- [ ] `supabase db reset` output captured verbatim, migrations (including 20260801234106_fix_rls_tenant_id_cast_and_grants.sql) applied cleanly
- [ ] `scripts/verify-rls-local-isolation.ts` created, hardcodes the local connection string with a `127.0.0.1:54322` guard, never reads `DATABASE_URL`/`SUPABASE_DB_URL`
- [ ] Local two-fake-tenant isolation test output captured verbatim — tenant A sees only its row, tenant B sees only its row, no cross-tenant leakage
- [ ] Local RESET + empty-string fail-closed test output captured verbatim — both scenarios return zero rows, neither throws `invalid input syntax for type uuid`
- [ ] `supabase db push` (live, no `--dry-run`) output captured verbatim, applied with no errors — only after all local checks above passed
- [ ] `deno run --allow-net --allow-env scripts/verify-rls-tenant-fix.ts` output captured verbatim, exits 0 against production
- [ ] SUMMARY.md contains all four verbatim output blocks, not paraphrased pass/fail summaries
</verification>

<success_criteria>
- The RLS tenant_id cast fix, FORCE ROW LEVEL SECURITY, and authenticated SELECT grants are proven to work against a real, freshly-reset local Postgres instance — not merely inspected as SQL text or dry-run-checked
- The two-fake-tenant isolation test and the RESET/empty-string fail-closed test both pass locally, with their raw command output captured and reported verbatim
- The live push to production only happens after — and strictly gated on — the local proof succeeding; any local failure halts the plan before touching production
- `supabase/migrations/20260801234106_fix_rls_tenant_id_cast_and_grants.sql` is applied to the live project and confirmed live via `scripts/verify-rls-tenant-fix.ts`, closing out quick task 260801-sg0's Task 2 deferral (see `.planning/STATE.md` Pending Todos)
- No fake tenant/user data is ever inserted into the live/production database — all fake-tenant and RESET testing happens strictly against the local instance
</success_criteria>

<output>
Create `.planning/quick/260801-tef-complete-task-2-rls-tenant-id-cast-force/260801-tef-SUMMARY.md` when done.

The SUMMARY MUST include four clearly-labeled sections with the VERBATIM (not summarized, not paraphrased) command output for: (1) `supabase db reset`, (2) `deno run --allow-net --allow-env scripts/verify-rls-local-isolation.ts` (isolation + fail-closed test), (3) `supabase db push`, (4) `deno run --allow-net --allow-env scripts/verify-rls-tenant-fix.ts`. If Task 1 fails and Task 2 never runs, the SUMMARY must still contain the verbatim output of whatever local commands were run, plus a clear statement that the live push was correctly skipped due to the local gate failing.
</output>
