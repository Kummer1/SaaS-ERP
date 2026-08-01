# Codebase Concerns

**Analysis Date:** 2026-08-01

## Tech Debt

**pgmq → Simple Table Queue Migration:**
- Issue: Phase 1 implementation uses `pgmq` (PostgreSQL message queue extension) with `pgmq_public` wrapper schema for the webhook/sync work queue. Architecture decision (confirmed 2026-08-01) mandates migration to a simple Postgres table with polling before Phase 3 (Sync Engine) depends on it.
- Files: 
  - `supabase/functions/sync-enqueue/index.ts` (lines 23-26: uses `pgmq_public.send`)
  - `supabase/functions/sync-worker/index.ts` (lines 23-25: uses `pgmq_public.pop`)
  - `supabase/migrations/20260729232533_pgmq_public_wrappers.sql` (entire file: creates RLS-protected schema wrapper)
  - `supabase/migrations/20260729231615_cron_sync_trigger.sql` (queue creation via `pgmq.create`)
  - `tests/sync_pipeline_test.ts` (lines 16, 31: directly queries `pgmq.q_sync_work` queue table)
- Impact: 
  - Current queue mechanism is functional end-to-end (verified live in Phase 1 verification)
  - However, architecture redesign requires simpler model (webhook_queue table with simple polling)
  - Blocks Phase 3 start if not resolved first — Phase 3's real sync engine depends on queue shape decision
  - Technical debt: code will diverge from intended architecture if not fixed before Phase 3
- Fix approach: 
  1. Create `webhook_queue` table per `docs/02-MODELO-DE-DADOS.md` §5 specification
  2. Rewrite `sync-enqueue/index.ts` to insert into table instead of calling `pgmq_public.send`
  3. Rewrite `sync-worker/index.ts` to use `SELECT ... FOR UPDATE SKIP LOCKED` pattern instead of `pgmq_public.pop`
  4. Update `tests/sync_pipeline_test.ts` to test new queue table directly
  5. Remove `pgmq_public` wrapper schema migration and `pgmq` extension from enabled extensions
  6. Coordinate with Phase 3 planning to schedule this as pre-work before sync engine implementation

## Known Issues

**pg_net Client-Side Timeout on Cron-Triggered Edge Function:**
- Issue: The `sync-enqueue-trigger` cron job's `net.http_post` call to the Edge Function times out client-side after pg_net's default 5000ms, even though the enqueue itself succeeds server-side.
- Files: `supabase/migrations/20260729231615_cron_sync_trigger.sql` (lines defining `net.http_post` call)
- Trigger: Occurs intermittently during automatic cron runs; likely caused by Edge Function cold-start latency exceeding 5000ms window
- Current behavior: `net._http_response` table shows `timed_out: true` entries even though corresponding queue depth changes confirm message was processed
- Workaround: Not blocking current operations — two independent unattended cron runs verified in 01-VERIFICATION.md; one timed out client-side at 23:30Z (but queue depth increased), one completed cleanly at 23:45Z
- Impact: Monitoring and alerting via `net._http_response` will show false-positive timeouts; log analysis required to confirm actual success
- Fix approach (Phase 3): Pass `timeout_milliseconds: 15000` (or higher) to `net.http_post` call to accommodate cold-start variability; consider adding explicit retry logic for timeouts that include server-side success check (queue depth query)
- Reference: `.planning/WINDOWS.md` id 1 (open deviation)

## Security Considerations

**Multi-Tenancy RLS Fail-Closed Implementation:**
- Risk: Tenant data leakage is the highest-consequence bug in a multi-tenant SaaS platform
- Files: 
  - All schema migrations apply RLS policies: `supabase/migrations/20260729225411_enable_queue_extensions.sql` (foundational)
  - RLS pattern documented in `docs/01-ARQUITETURA.md` §4
  - Pattern: `USING (tenant_id = current_setting('app.tenant_id', true)::uuid)` on every table row
- Current mitigation:
  - RLS fail-closed: `current_setting('app.tenant_id', true)` returns `NULL` if not set, causing `tenant_id = NULL` to always be false, denying access by default
  - Every Edge Function expected to set `SET LOCAL app.tenant_id = '<uuid>'` in transaction before querying
- Recommendations:
  1. Add explicit automated test suite for cross-tenant access attempts (Phase 2 prerequisite before any multi-tenant data)
  2. Document the exact point in each Edge Function where tenant_id MUST be set (currently implicit in architecture docs)
  3. Add compile-time/runtime assertion checks ensuring `current_setting('app.tenant_id')` is not null before querying tenant-scoped data
  4. Periodically audit RLS policies via `SELECT * FROM pg_policies WHERE schemaname NOT IN ('pg_catalog', 'information_schema')` in production
  5. Never allow ANY table without a `tenant_id` column + RLS policy in production (currently enforced by convention, not tooling)

**Database Connection Secrets Management:**
- Risk: `DATABASE_URL` contains plaintext Postgres password; if logged or exposed in error messages, enables direct database access
- Files: 
  - `supabase/functions/_shared/db.ts` (lines 19-25: reads and uses DATABASE_URL)
  - `.env` file (contains DATABASE_URL — not readable per this audit, but referenced)
  - GitHub Actions secrets (DATABASE_URL stored as repo secret)
- Current mitigation:
  - Connection string read once as single opaque environment variable, never reconstructed from parts
  - Explicit guard against logging: `supabase/functions/health/index.ts` (lines 18-19) logs only error object, never connection string
  - Supabase Vault used for additional secrets (project URL, Edge Function API key in `setup-vault-secrets.ts`)
- Recommendations:
  1. Audit all error handling paths to ensure DATABASE_URL never appears in error logs (run grep `console.error` + manual review of all catch blocks)
  2. Add JSDoc comment to `_shared/db.ts` reminding all callers "never log(sql connection)" before every Edge Function
  3. Rotate DATABASE_URL periodically (Supabase allows regenerating from dashboard); document procedure

**Supabase Vault Secret Creation & Management:**
- Risk: Vault secrets (project URL, Edge Function API key for cron calls) must be manually created; if missed, cron pipeline fails silently
- Files:
  - `scripts/setup-vault-secrets.ts` (creates `project_url` and `edge_function_key`)
  - `supabase/migrations/20260729231615_cron_sync_trigger.sql` (references vault secrets by name)
- Current mitigation:
  - `setup-vault-secrets.ts` is idempotent (can be run multiple times safely)
  - No hardcoded secrets in migration files (Pattern 3 in 01-RESEARCH.md)
  - But: no automated verification that secrets exist before cron job runs
- Recommendations:
  1. Add startup check in cron trigger migration: `SELECT COUNT(*) FROM vault.decrypted_secrets WHERE name IN ('project_url', 'edge_function_key')` with a readable error if count != 2
  2. Document in onboarding: "Always run `scripts/setup-vault-secrets.ts` after `supabase db push`"
  3. Add monitoring alert if cron job fails due to missing secrets (Phase 2/3)

**Edge Function JWT Verification Defaults:**
- Risk: Wrong `verify_jwt` setting on sensitive endpoints could expose internal functions to unauthorized invocation
- Files:
  - `supabase/config.toml`: `[functions.health] verify_jwt = false` (intentional — health check is public)
  - `supabase/functions/sync-enqueue/index.ts`: verify_jwt NOT set (defaults to `true`) — correct, as only cron should invoke
  - `supabase/functions/sync-worker/index.ts`: verify_jwt NOT set (defaults to `true`) — correct, only worker should invoke
- Current mitigation: Correct defaults applied; documented in function headers
- Recommendations:
  1. Add explicit `# SECURITY: verify_jwt stays at default (true)` comment in sync-enqueue/sync-worker headers
  2. Never set `verify_jwt = false` on any function handling real tenant data (future Phases 2-4)

## Performance Bottlenecks

**Edge Function 2-Second CPU Limit for Large Data Syncs:**
- Problem: Tiny ERP sync (customers, products, orders) may exceed 2s CPU when backfilling thousands of records in a single invocation
- Files: `docs/01-ARQUITETURA.md` §5 documents this constraint
- Cause: Edge Functions have hard 2s CPU / 150s wall-clock limits; cannot perform unbounded operations
- Improvement path:
  1. Implement cursor-based pagination in sync worker (Phase 3): read `sync_watermarks.cursor` → fetch one page from Tiny API → process → update cursor → return
  2. Each cron trigger (every 15-30 min) picks up where previous run left off
  3. Ensures stable latency and resource usage per invocation
  4. Requires careful idempotency handling: same page may be fetched twice on overlap; document how conflict resolution works (last-write-wins vs. merge logic)

**Polling-Based Reconciliation (15-30 Minute Intervals):**
- Problem: Not a bug, but by design — reconciliation sync runs at fixed 15-30 min intervals via cron, not real-time
- Impact: Up to 30 min delay before new/updated data from Tiny appears in dashboard
- Mitigation: Webhook inbound (future Phase 3) provides faster path for urgent updates; polling is the reliability fallback
- Recommendation: Document this latency SLA clearly in dashboard UI ("Last sync: <timestamp>") so users understand eventual-consistency window

## Fragile Areas

**Postgres Connection Pooler Configuration:**
- Files: `supabase/functions/_shared/db.ts`, `tests/conftest.ts`, `scripts/smoke-test-db.ts`
- Why fragile:
  1. Transaction Pooler (port 6543) REQUIRES `{ prepare: false }` on postgres.js client — omitting this breaks intermittently under concurrency
  2. Connection string MUST use `postgres.<project-ref>` username for pooler, not bare `postgres` — wrong username fails auth
  3. If connection string is ever reconstructed from separate host/user/password parts instead of read as single env var, pooler routing breaks (incident history from `tinysaas` project commit 55b0f80)
- Safe modification:
  1. Never change `_shared/db.ts` without running full `tests/` suite against real Supabase project
  2. Before any pooler-related changes, review this code path: `_shared/db.ts` → `functions/health/index.ts` → live cron trigger (verify both work)
  3. If updating postgres.js version: cross-check changelog for prepared-statement behavior changes
- Test coverage: `tests/db_connection_test.ts` covers the exact failure mode (5+ sequential queries; prepared-statement safety)

**RLS Policy Consistency Across Schema:**
- Files: All `supabase/migrations/` that define tenant-scoped tables
- Why fragile: If a new table is added without RLS policy, it silently leaks data to all tenants
- Safe modification: Before adding any new table in future phases, add this checklist item to the plan: "Table X includes (1) tenant_id column, (2) RLS policy with fail-closed `current_setting('app.tenant_id')` check"
- Test coverage: Gap — no explicit automated test suite for cross-tenant access attempts yet (Phase 2 prerequisite)

**Vault Secret References in SQL Migrations:**
- Files: `supabase/migrations/20260729231615_cron_sync_trigger.sql` (references `vault.decrypted_secrets`)
- Why fragile: If vault secret is deleted or misconfigured, `net.http_post` call fails silently (cron still runs, but HTTP call has no auth)
- Safe modification: Before deploying any migration that adds new vault secret references, run `SELECT COUNT(*) FROM vault.decrypted_secrets WHERE name = 'expected_secret_name'` in dashboard to verify secret exists

## Test Coverage Gaps

**GitHub Actions CI Has Never Executed:**
- Issue: `.github/workflows/ci.yml` exists and is well-formed, but no remote is configured (`git remote -v` returns empty)
- Files: `.github/workflows/ci.yml`
- Risk: CI smoke test (SC-3 in ROADMAP) cannot be verified as actually running on GitHub Actions; local `deno run` equivalent was tested, but CI-specific environment variables and timing may differ
- Impact: ROADMAP Success Criterion 3 remains unverified in its target environment
- Fix approach: 
  1. Configure GitHub remote (push to GitHub)
  2. Set four required repository secrets: `DATABASE_URL`, `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_ID`, `SUPABASE_DB_PASSWORD`
  3. Trigger a test run and verify `smoke-test` and `deploy` jobs succeed
  4. Document the secret values and rotation procedure (Supabase dashboard "Manage Access Tokens", database password regeneration)

**Local Docker-Based Migration Validation Not Performed:**
- Issue: ROADMAP SC-2 states "Database schema migrations run successfully... both locally and in production." Local half never verified because Docker is absent on development machine.
- Files: `supabase/` migrations directory
- Risk: Migrations work against real Supabase project, but local `supabase start` emulation environment may have subtle differences (version mismatch, extension behavior)
- Impact: ROADMAP Success Criterion 2 partially unverified; only production half proven
- Fix approach (optional): Install Docker and run `supabase start && supabase migration up` once before Phase 2, or explicitly accept that `supabase db push --dry-run --linked` (fallback used) is sufficient

**Cross-Tenant Access Test Suite Missing:**
- Issue: RLS policies are implemented fail-closed, but no automated test suite verifies that a user from tenant B cannot read/write tenant A's data
- Files: None — this is a gap
- Risk: RLS policy misconfiguration could silently leak data; only caught by accident or during security audit
- Impact: Multi-tenancy security assumption is documented but not verified by tests
- Priority: HIGH — must be added before Phase 2 moves any real user/tenant data into production
- Fix approach (Phase 2 prerequisite):
  1. Create `tests/rls_isolation_test.ts` with fake tenants A and B
  2. Insert test data under tenant A
  3. Attempt to read as tenant B (should get 0 rows)
  4. Attempt to update/delete as tenant B (should fail)
  5. Run in CI before every deployment

**Real OAuth2 Flow Not Yet Implemented:**
- Issue: No Edge Function handles Tiny OAuth callback (redirects from Tiny's auth flow) or token refresh yet
- Files: `supabase/functions/` directory — only health/sync-enqueue/sync-worker exist
- Risk: When Phase 3 adds real OAuth, if token refresh logic is buggy, users' integrations break silently (token expires, goes unnoticed)
- Impact: Blocks Phase 3 scope; Phase 1 is intentionally minimal
- Recommendation: Phase 3 must include: (1) automated tests for token refresh, (2) tenant-visible alerts for revoked/expired tokens

**Rate Limiter Not Implemented:**
- Issue: Tiny ERP API has strict rate limits per tenant account (exact numbers in Phase 3 research); no rate limiter exists yet
- Files: None — this is future work
- Risk: If sync worker calls Tiny API faster than rate limit allows, Tiny returns 429; if we retry > 5 times, token is locked for 1h
- Impact: Blocks Phase 3 real sync implementation
- Recommendation: Phase 3 plan must include: (1) rate limiter state table, (2) tests for 429 retry logic, (3) monitoring alert if 5+ consecutive 429s occur

## Scaling Limits

**pgmq Queue Capacity Under Free Tier:**
- Limit: Supabase free tier has 500MB database size limit; pgmq messages count against this
- Current usage: Phase 1 queues only placeholder `{kind:"ping"}` messages (~50 bytes each)
- Impact: With 500MB DB and ~50 byte messages, queue could hold ~10M messages before hitting size limit (if nothing else uses DB)
- Scaling path: Move to Supabase Pro tier (removes auto-pause, increases size to 8GB) as soon as real data arrives (Phase 3 onward)
- Recommendation: Phase 3 must include: (1) monitoring of `pg_database_size()`, (2) alert if database exceeds 400MB (80% of free tier), (3) documented runbook for upgrading to Pro tier

**Edge Function Concurrent Invocation Limits:**
- Limit: Supabase free tier: 500k invocations/month; Pro tier: 1M/month base + pay-as-you-go beyond
- Current usage: Phase 1 has ~2 invocations/15min (cron trigger + worker) = ~4 invocations/30min = ~5,760/day = ~172k/month (well within free tier)
- Scaling path: Phase 3 real sync (multiple tenants, faster reconciliation cadence) may approach 500k; monitor and upgrade to Pro if exceeded
- Recommendation: Phase 2/3 must include: (1) dashboard metric for monthly invocation count, (2) alert at 400k threshold

**Transaction Pooler Connection Limit:**
- Limit: Supabase free tier: 30 concurrent connections via Transaction Pooler
- Current usage: Phase 1 has ~0.5 concurrent Edge Function invocations on average (cron every 15 min, each Edge Function <2s)
- Scaling path: Phase 3 with higher concurrency may breach 30; fallback to Session Pooler (5432, persistent connections only) for long-running queries if needed
- Recommendation: Phase 3 must include: (1) monitoring of active connections via `pg_stat_activity`, (2) alert if >20 concurrent connections, (3) documented decision: do we split functions by pooler mode or upgrade project?

## Dependencies at Risk

**postgres.js (`npm:postgres@3.4.9`) Package Maintenance:**
- Risk: Package is actively maintained (12.9M weekly downloads), but is external dependency
- Impact: Major version bump could change prepared-statement behavior; minor bumps are generally safe
- Mitigation: Phase 3 should test any postgres.js version bump against the full test suite before committing
- Recommendation: Pin exact version in each function's `deno.json` (currently already done); document upgrade testing procedure

**Supabase CLI Version Lock:**
- Risk: `.planning/phases/01-infrastructure-connection-foundation/01-RESEARCH.md` verifies version `2.110.0` at time of research (2026-07-28); new versions may have CLI breaking changes
- Impact: If CI job uses `latest` Supabase CLI, a major update could break `supabase db push` or `supabase functions deploy` in `.github/workflows/ci.yml`
- Mitigation: CI workflow currently uses `supabase/setup-cli@v1 with version: latest` — this is actually OK for free tier, as Supabase maintains backward compatibility for GH Actions
- Recommendation: Document the tested version in CI workflow comments; if future phases use advanced CLI features (e.g., branching, regional deployments), pin specific version

**Deno Runtime Version Stability:**
- Risk: `.github/workflows/ci.yml` uses `denoland/setup-deno@v2 with deno-version: v2.x` — `v2.x` is a wildcard, will auto-update
- Impact: Deno v2 breaking changes (unlikely, but possible) could break `deno test` commands
- Mitigation: Deno team maintains compatibility within major version; v2.x is safe to auto-update
- Recommendation: Monitor Deno release notes; if future phases use advanced Deno features (e.g., permissions, workspaces), consider pinning to specific minor version

## Missing Critical Features

**Rate Limiter for Tiny API (Phase 3 Blocker):**
- Problem: Tiny ERP API has per-account rate limits (exact numbers: MEDIUM confidence per 01-RESEARCH.md, must re-verify in Phase 3); no rate limiter in place yet
- Impact: Cannot safely call Tiny API in Phase 3 without risk of hitting limits and locking token
- Blocks: Real sync engine implementation (Phase 3)
- Recommended implementation: State table in Postgres tracking request counts per tenant per 1-minute window; check before each Tiny API call; implement exponential backoff on 429

**Webhook Ingestion Endpoint (Phase 3):**
- Problem: Tiny ERP can push updates via webhook, but no Edge Function receives/processes them yet
- Impact: Sync only happens via polling (15-30 min delay); no real-time data updates
- Blocks: Faster sync path for urgent updates (Phase 3 scope)
- Recommended implementation: New Edge Function `POST /functions/v1/webhook` that validates Tiny's request signature, enqueues work items, returns 202 Accepted immediately

**Real Sync Engine (Phase 3):**
- Problem: Current `sync-worker` is a placeholder that logs and discards work items
- Impact: No actual Tiny ERP data in database yet; MVP cannot be validated
- Blocks: Phase 4 dashboard work depends on real data
- Recommended implementation: Replace placeholder with actual fetch-from-Tiny-API → validate → upsert-into-DB logic for products/customers/orders

**Authentication UI (Phase 2):**
- Problem: No signup/login flow implemented; only Supabase Auth backend is configured
- Impact: Cannot add users; MVP is backend-only
- Blocks: Dashboard work (Phase 4) requires authenticated users first
- Recommended implementation: React components for signup/login/logout; integrate with Supabase Auth via `@supabase/auth-ui` or custom form

**Dashboard (Phase 4):**
- Problem: Only API/backend exists; no frontend visualization of synced data
- Impact: MVP cannot be demonstrated to users
- Blocks: User validation of sync correctness; core value proposition ("tenant sees synchronized data in dashboard")
- Recommended implementation: React/Vite frontend on Vercel; KPIs for sales (orders, revenue), inventory (stock levels), customers (count, retention)

---

*Concerns audit: 2026-08-01*
