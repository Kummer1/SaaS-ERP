# Pitfalls Research

**Domain:** Multi-tenant SaaS syncing a third-party ERP (Tiny/Olist) into Supabase Postgres, exposed via dashboard, on free-tier PaaS, with no dedicated task queue (no Celery/Redis) for the MVP
**Researched:** 2026-07-27
**Confidence:** MEDIUM-HIGH (Supabase/Render/Vercel platform facts are HIGH — corroborated by official docs + multiple independent reports; Tiny ERP API specifics are MEDIUM — carried from `docs/03-INTEGRACAO-TINY-ERP.md`, which the project's own docs flag as needing re-validation before coding, and this research pass could not independently re-fetch the JS-rendered Tiny help center to confirm the exact "5x 429 → 1h block" figure this session)

## Critical Pitfalls

### Pitfall 1: `DATABASE_URL` prefix + pooler-mode mismatch breaks the connection silently or with cryptic errors

**What goes wrong:**
This is the exact bug class the user already hit in the previous project (`tinysaas`, fixed in commit `55b0f80`): the app built its own `DATABASE_URL` from `DB_HOST`/`DB_PASSWORD` env vars, but Render injects a full `DATABASE_URL` starting with `postgres://` (not `postgresql://`, and definitely not `postgresql+asyncpg://`). SQLAlchemy 2.0 async raises `sqlalchemy.exc.NoSuchModuleError` or a driver-resolution error if the URL scheme isn't rewritten. This is a *different, additional* trap on the new stack because the new project uses SQLAlchemy 2.0 **async** (asyncpg), not sync psycopg2 like the old one — the old fix (`postgres://` → `postgresql+psycopg2://`) does not carry over; the correct rewrite target is `postgresql+asyncpg://`.

Layered on top of that, Supabase in 2025/2026 gives you **three different connection strings** for the same database, and picking the wrong one for the deployment target causes a second failure mode even after the prefix is fixed:
- **Direct connection** (port 5432, `db.<ref>.supabase.co`) — resolves to an **IPv6-only** address by default. Render does not support outbound IPv6 on its network, so connecting from Render to the direct-connection host fails with `Network is unreachable`, not an auth error — easy to misdiagnose as a credentials problem.
- **Supavisor session pooler** (port 5432, `<ref>.pooler.supabase.com`) — IPv4-compatible, behaves like a real Postgres connection (supports prepared statements), but each held connection consumes one of the pooler's session slots — bad fit for many short-lived requests.
- **Supavisor transaction pooler** (port 6543, `<ref>.pooler.supabase.com`) — IPv4-compatible, designed for many concurrent short connections (matches an async FastAPI app well), but **breaks asyncpg's default prepared-statement behavior** (see Pitfall 2). As of Feb 28 2025, Supabase deprecated session-mode-on-6543, so port 6543 is transaction-mode-only and port 5432 is session-mode-only going forward — mixing these up produces confusing intermittent errors that only show up under concurrent load, not on first connection.

**Why it happens:**
Env-var-driven URL construction (`DB_HOST` + `DB_PASSWORD` string formatting) assumes one canonical Postgres URL shape. Supabase + Render break that assumption in two independent ways at once (prefix rewrite + pooler mode selection + IPv4/IPv6), and the failure surfaces as three unrelated-looking errors depending on which piece is wrong, so it's easy to fix one and still be broken.

**How to avoid:**
- Never construct `DATABASE_URL` from parts. Read it as one string from the environment (Render sets it directly if you link a Render-managed Postgres, or you paste Supabase's pooler connection string as an env var) and only ever *rewrite the scheme*, never rebuild host/port/db from separate vars.
- Centralize the rewrite in one place (e.g. `app/core/db.py`), applied once at import time:
  ```python
  DATABASE_URL = os.environ["DATABASE_URL"]
  if DATABASE_URL.startswith("postgres://"):
      DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql+asyncpg://", 1)
  elif DATABASE_URL.startswith("postgresql://"):
      DATABASE_URL = DATABASE_URL.replace("postgresql://", "postgresql+asyncpg://", 1)
  ```
- Use the **Supavisor transaction pooler** (port 6543) as the app's runtime `DATABASE_URL` on Render (IPv4-safe, fits many short async connections from a small pool), and explicitly disable asyncpg's prepared-statement cache for it (Pitfall 2).
- For Alembic migrations, use the **session pooler** (port 5432 pooler host, not the direct-connection host) so DDL runs over a real session — transaction-mode pooling and some DDL/session-level operations don't mix well. Never use `NullPool` + direct-connection host by default; only fall back to the direct host if IPv4 add-on is explicitly enabled.
- Write exactly one integration smoke test that opens a real connection against the configured `DATABASE_URL` and runs `SELECT 1` — run it in CI against a Supabase project (or local Postgres) so a scheme/pooler regression fails CI, not production.

**Warning signs:**
- `NoSuchModuleError` or `ModuleNotFoundError` mentioning a driver on boot → scheme not rewritten.
- `OSError: [Errno 101] Network is unreachable` or connection hangs on boot with no auth error at all → hit the IPv6-only direct-connection host from a network without IPv6 egress.
- Works locally, fails only on Render → almost always this class of bug (local `.env` has a different URL shape than the platform-injected one).
- Intermittent `DuplicatePreparedStatementError` / `prepared statement "__asyncpg_stmt_x__" does not exist` only under concurrent requests → transaction-mode pooler + prepared statements not disabled (Pitfall 2).

**Phase to address:**
Infrastructure/setup phase (before any sync logic is built) — this must be nailed down and covered by a CI smoke test before Phase 1 (auth) or Phase 2 (Tiny OAuth) work begins, since every later phase depends on the DB connection working identically in dev and on Render.

---

### Pitfall 2: asyncpg + Supabase's transaction-mode pooler silently breaks prepared statements under load

**What goes wrong:**
asyncpg (used by SQLAlchemy 2.0 async) prepares and caches statements by default for performance. Supabase's transaction-mode pooler (port 6543, PgBouncer/Supavisor under the hood) hands out a *different* underlying Postgres connection for every transaction, so a statement prepared on connection A may not exist when asyncpg tries to reuse it on connection B. This does not fail on the first query — it fails under concurrency or after the pool cycles connections, which means it can pass local testing and manual QA and only appear in production once real traffic (multiple tenants syncing concurrently, or webhook + polling overlapping) hits the pooler.

**Why it happens:**
asyncpg was designed for direct Postgres connections; transaction-mode connection pooling is fundamentally incompatible with connection-scoped prepared statement caching unless explicitly disabled. This is a well-documented, currently-open class of issue against Supabase (multiple open GitHub issues in 2025/2026, e.g. supabase/supabase#35684 and #39227) — not something the project can "configure around" once; it needs to be baked into the engine setup from day one.

**How to avoid:**
When using the transaction pooler (port 6543) as `DATABASE_URL`, disable asyncpg's statement cache in the SQLAlchemy async engine:
```python
engine = create_async_engine(
    DATABASE_URL,
    connect_args={
        "statement_cache_size": 0,
        "prepared_statement_cache_size": 0,
    },
    pool_pre_ping=True,
)
```
This costs a small amount of per-query performance (no client-side prepared statement reuse) but is the documented, stable fix. If prepared-statement performance ever matters (unlikely at MVP scale — one tenant, one resource), the alternative is switching that specific workload to the session pooler (port 5432) instead of fighting the transaction pooler.

**Warning signs:**
- `asyncpg.exceptions.DuplicatePreparedStatementError` or `InvalidSQLStatementNameError` appearing only intermittently, worse under load or with more than one worker/tenant syncing at once.
- Passes all tests against local Postgres (no pooler) but fails against the deployed Supabase project.

**Phase to address:**
Infrastructure/setup phase, same commit as Pitfall 1's engine configuration — this is a single `connect_args` change but must exist before the sync engine (Phase with polling/webhooks) starts issuing concurrent queries, since that's exactly when it manifests.

---

### Pitfall 3: No Celery/Redis + Render free tier's "no free Background Worker" + spin-down means the in-process scheduler can silently stop running

**What goes wrong:**
The plan (per `docs/02-MODELO-DE-DADOS.md` and `PROJECT.md`) is an in-process scheduler (e.g. APScheduler) running polling every 15–30 min, inside the same FastAPI process that also serves HTTP (webhook endpoint + dashboard API). This has a hard platform constraint that is easy to miss: **Render's free tier does not offer the "Background Worker" service type at all — it is paid-only ($7/mo+).** The only free service type that can run your Python process is a **Web Service**, and Render's free-tier Web Services **spin down after ~15 minutes with no incoming HTTP request**, then take 30–60s to cold-start on the next request. An in-process scheduler living inside that same web process stops firing the moment the dyno sleeps — so "poll every 15–30 min" silently degrades to "poll only when someone happens to hit the site," which is the opposite of the reconciliation guarantee the design depends on to catch webhooks that were missed.

A second, independent failure mode from restarts: Render free tier also restarts the process periodically and on every deploy. If the scheduler's watermark/state lives only in memory (not persisted per tenant in Postgres), a restart either replays a wide catch-up window (duplicate work — acceptable if upserts are truly idempotent) or, worse, loses track of "have I already caught up since the last restart" and either over-polls (risking Tiny's rate limit / 429 block) or leaves a gap.

**Why it happens:**
"No Celery/Redis" was chosen specifically to avoid the cost of a managed Redis instance, which is reasonable — but it implicitly assumes the process hosting the scheduler stays alive continuously, which free-tier PaaS web services do not guarantee. This is a mismatch between a reliability assumption baked into the sync design (docs describe Celery beat firing every 15–30 min unconditionally) and the actual free-tier hosting reality (APScheduler substituted 1:1 for Celery beat, but the hosting guarantee was not re-derived).

**How to avoid:**
- Persist the sync watermark **per tenant per resource** in Postgres (not in memory), so any restart — cold start, deploy, crash — resumes from "last successfully synced timestamp," never from scratch and never silently skipping.
- Design polling as **catch-up-safe by construction**: on every scheduler tick (whenever it manages to run), fetch "updated since `watermark - N minutes`" and upsert idempotently. This makes the exact tick cadence not matter for correctness — only for freshness. A tick that fires every 2 hours instead of every 15 min because the dyno was asleep is a *staleness* problem, not a *correctness* problem, as long as the watermark approach is used consistently (this is already the documented plan in `docs/03-INTEGRACAO-TINY-ERP.md §3` — the gap is making sure hosting doesn't defeat it).
- Actively keep the free Web Service warm: an external cron ping (e.g. a free UptimeRobot/cron-job.org hit to `/health` every 10 min, or Render's own paid Cron Job hitting the app) is the standard community workaround for Render free-tier spin-down, and is worth adopting explicitly rather than discovering the gap in production. Document this as an operational dependency, not an incidental nice-to-have.
- Treat "Render Background Worker" as a concrete future upgrade trigger, not a maybe: once there's a paying tenant, move the scheduler off the free web dyno and onto a real Background Worker (or reconsider Celery/Redis) — call this out explicitly as a post-MVP infra decision so it isn't rediscovered under pressure.
- Guard against duplicate/overlapping scheduler runs from process restarts: use `max_instances=1` and `coalesce=True` on the APScheduler job, and treat "job already running" as a no-op, not an error.

**Warning signs:**
- Dashboard data is stale by hours, not minutes, with no errors logged — the scheduler simply didn't fire because nothing hit the site.
- Sync watermark reset to a much older timestamp after a deploy → in-memory state loss confirmed.
- Duplicate rows or duplicate webhook processing after every deploy, if upserts aren't actually idempotent (should be a no-op if `ON CONFLICT` is correctly implemented — treat any duplicate as a bug in the upsert, not "expected behavior of the polling design").

**Phase to address:**
The sync engine phase (products polling + webhook, per `PROJECT.md` Active requirements) — the watermark-in-Postgres design and idempotent upsert must ship together with the first working poll, not be retrofitted. The external keep-warm ping and the "move off free tier" trigger should be called out in the infrastructure/deploy phase as an explicit operational note, not left implicit.

---

### Pitfall 4: Tiny ERP rate limits are per-tenant-account, shared with the tenant's other integrations, and 5 consecutive 429s risk an hour-long lockout

**What goes wrong:**
`docs/03-INTEGRACAO-TINY-ERP.md` already documents this correctly and it remains the single most consequential Tiny-specific pitfall, worth restating with emphasis because it's easy to under-design for: the rate limit (60–240 req/min, 30–100 writes/min depending on the tenant's own Tiny plan) belongs to the **tenant's Tiny account**, not to your application. If that tenant also runs Tiny automations elsewhere (their own n8n flow, a spreadsheet sync, another marketplace integrator), your sync engine is silently sharing that budget and can get starved or, worse, be the one that trips the lockout for the tenant's *other* tools too. A naive per-application (not per-tenant) rate limiter, or a full backfill that doesn't throttle to the tenant's specific plan tier, will burn through the budget fast — especially during first-connection backfill (paginated full sync), which is exactly the moment you want to move fast.

The stated consequence — 5 consecutive 429s risking a 1-hour token block — means a naive "retry immediately in a loop" pattern (the most common first implementation of "handle 429") is actively dangerous here: it doesn't just slow things down, it can escalate into an hour of total sync outage for that tenant. This detail could not be independently re-confirmed against Tiny's live help center this session (the page required JS rendering and returned no extractable rate-limit text); treat it as MEDIUM confidence carried from the project's own prior documentation, and explicitly re-verify the exact numbers (limits per plan tier, exact consecutive-429 threshold, exact lockout duration) against `ajuda.tiny.com.br` / the Tiny developer portal immediately before implementing the rate limiter, since third-party API limits change without notice.

**Why it happens:**
It's intuitive to model rate limiting as "protect my app from Tiny," when the actual risk is "protect the tenant's whole Tiny account (including tools I don't control) from my app," which requires a per-tenant token bucket and genuinely conservative backoff, not just a generic retry decorator.

**How to avoid:**
- Implement a token-bucket rate limiter keyed by `tenant_id` (not global, not per-process), sized to the *tenant's actual plan tier* (store the tier on the tenant record; default to the most conservative tier — Básico/Crescer, 60 req/min — if unknown).
- On `429`, always respect `Retry-After` verbatim; never retry immediately. Track consecutive 429 count per tenant and hard-stop that tenant's sync (mark a cooldown state) well before reaching the documented failure threshold — build in a safety margin (e.g. back off after 2–3 consecutive 429s, not wait until 5).
- Use the documented batch endpoints (up to 50 products per call) for price/stock updates instead of one call per SKU — this is a concrete, already-identified way to reduce call volume for the highest-frequency resource.
- Surface rate-limit cooldown state in the tenant's `tiny_credentials.status` (or equivalent) so it's visible operationally, not just logged.
- Before implementing the limiter, re-confirm current numbers directly against Tiny's official docs/help center (`ajuda.tiny.com.br`, `tiny.com.br/api-docs`) — do not code against numbers carried in project docs without a fresh check, per the project's own stated caveat.

**Warning signs:**
- A single tenant's first full backfill consumes most of a testing session's rate budget almost immediately.
- 429s cluster right after deploy (scheduler catch-up window too wide, or backfill not throttled).
- A tenant reports their *own* other Tiny integration is failing right after connecting your app — sign the shared quota is being exhausted by your sync.

**Phase to address:**
The Tiny OAuth2 connection + first-sync (backfill) phase — the per-tenant rate limiter and 429/backoff handling must exist before the first full backfill is ever run against a real tenant account, since backfill is the highest-risk moment for burning the budget.

---

### Pitfall 5: Supabase Auth (`auth.uid()`) and custom `tenant_id` RLS are two different trust models that must be deliberately bridged, not assumed compatible

**What goes wrong:**
Supabase Auth's built-in RLS patterns are built around `auth.uid()` (the authenticated user's ID) and Supabase's own JWT claims, accessible automatically inside Postgres when queries go through Supabase's PostgREST/Supabase client libraries. This project instead talks to Postgres directly from a FastAPI backend via SQLAlchemy (through the connection pooler), which means `auth.uid()` and Supabase's JWT-claim helpers are **not automatically available** inside that connection — the backend is a plain Postgres client, not going through Supabase's API layer. If RLS policies are written assuming `auth.uid()` / `auth.jwt()` are populated, they silently pass or fail depending on how the connection was opened, which is exactly the kind of bug that looks fine in testing (if you always test through Supabase's client) and leaks data or blocks all access in production (once traffic goes through the FastAPI/SQLAlchemy path instead).

The project's actual multi-tenancy mechanism is a custom `tenant_id` column + RLS policy comparing it to a session variable (typically set via `SET LOCAL app.tenant_id = '...'` or similar per-request). The dangerous mistake here is a pooled-connection version of a classic bug: if the backend acquires a connection from SQLAlchemy's pool, sets `app.tenant_id` for request A, returns the connection to the pool without resetting it, and a later request B reuses that same physical connection without re-setting `app.tenant_id`, request B can silently run with request A's tenant context (or with a stale one) — direct cross-tenant data exposure, and it will not show up in single-request manual testing, only under concurrent/pooled reuse.

**Why it happens:**
Supabase markets RLS + Auth as a cohesive unit, but that cohesion is delivered through Supabase's own client libraries and PostgREST, not automatically through a raw SQLAlchemy connection. This project deliberately uses Supabase for managed Postgres + Auth (users/sessions) while keeping the actual tenant isolation logic custom — a fully legitimate design, but it means every RLS policy must be written and tested against *this app's* connection lifecycle, not against Supabase's documented default RLS examples (which assume `auth.uid()` is live).

**How to avoid:**
- Do not rely on `auth.uid()`/`auth.jwt()` inside RLS policies for tenant isolation on tables the FastAPI backend writes to directly — those helpers are populated by Supabase's own request path, not by a raw SQLAlchemy connection. Use the custom `tenant_id` + session-variable approach consistently, end to end.
- Set `app.tenant_id` **per transaction, not per connection**, using `SET LOCAL` (not plain `SET`) inside the same transaction as the query, so it is automatically discarded at transaction end regardless of what the pool does with the physical connection afterward. Never set it once "at connection checkout" and assume it persists correctly — verify this explicitly with a test that deliberately reuses a pooled connection across two different tenant contexts in sequence and asserts no leakage.
- Enforce `tenant_id` filtering at **two layers**, not one: the RLS policy (defense in depth, catches bugs in application code) AND an explicit `WHERE tenant_id = :tenant_id` in every application-level query (the actual primary mechanism, since RLS session-variable reliability through a connection pool is exactly the fragile part described above). Do not treat RLS alone as sufficient given the pooled-connection risk.
- Write an automated test early (not deferred to a "security phase") that creates two tenants, authenticates as one, and asserts the API/DB layer cannot read or write the other tenant's rows — run this test on every CI run, not just once manually.
- Confirm RLS is actually **enabled** on every tenant-scoped table (`ALTER TABLE ... ENABLE ROW LEVEL SECURITY`) — a table with policies defined but RLS not enabled enforces nothing, and this is a commonly cited default-off trap independent of the pooling issue above.

**Warning signs:**
- Any RLS policy definition that references `auth.uid()` or `auth.jwt()` on a table the FastAPI backend (not the Supabase client SDK) writes to.
- `app.tenant_id` set via a plain `SET` (not `SET LOCAL`) anywhere in the codebase.
- No automated cross-tenant leakage test exists by the time the second resource/tenant is added.
- A table appears in `pg_policies` but `relrowsecurity` is false in `pg_class` for it.

**Phase to address:**
The multi-tenant isolation requirement is listed as an MVP "Active" requirement from day one in `PROJECT.md` ("Isolamento entre tenants garantido via `tenant_id` + RLS... desde o primeiro tenant") — so this must be addressed in the same phase that introduces the first tenant-scoped table (likely the auth/tenant-provisioning phase, before Tiny sync data lands), with the cross-tenant leakage test as an explicit verification gate before that phase is considered done.

---

### Pitfall 6: Free-tier reliability traps compound each other around demo/investor moments specifically

**What goes wrong:**
Three independent free-tier behaviors combine into a specific worst-case: a demo or investor walkthrough happens after a quiet week (no dev activity, no tenant traffic).
- **Supabase free project pausing**: a Free-plan project is paused after **1 week of inactivity** (insufficient database requests), with a warning email roughly a week before, and a confirmation email once paused. A paused project returns connection errors, not a graceful "waking up" state — the demo simply fails to load data until someone manually un-pauses it from the Supabase dashboard.
- **Render free-tier cold start**: after 15 minutes with no HTTP traffic, the web service spins down; the next request pays a 30–60s cold-start penalty — bad enough for a live demo, and actively harmful for webhook latency expectations (Tiny's webhook delivery has its own timeout/retry behavior; a sleeping receiver risks the webhook being treated as failed/lost on Tiny's side, forcing reliance on the next poll instead).
- **Vercel Hobby plan**: 100GB bandwidth/month and function limits are generous enough that they are unlikely to be the binding constraint at MVP scale (one tenant), but the Hobby plan's terms restrict it to **personal/non-commercial use** — worth flagging explicitly since this project has commercial SaaS intent even if pre-revenue, and upgrading to a paid Vercel plan before any real customer-facing usage is a compliance point, not just a scaling one.

**Why it happens:**
Each of these is individually documented and each is individually "fine for a hobby project," but the project's actual use case (occasional demos to prospective tenants/investors, with real gaps in day-to-day activity during a no-fixed-timeline build) is close to the worst-case activity pattern for triggering all three at once.

**How to avoid:**
- Add a lightweight scheduled keep-alive (external cron hitting `/health` every 10 min, and a low-volume query against Supabase on some cadence within the 1-week window) — this single mechanism addresses both the Render spin-down and the Supabase pause risk simultaneously, since it generates both HTTP and DB activity.
- Before any scheduled demo, do a manual pre-flight: open the Supabase dashboard (resets the inactivity clock and un-pauses if needed) and hit the Render app once to force the cold start out of the critical path.
- Treat the Vercel Hobby "non-commercial" restriction as a checklist item for whenever the project moves from "speculative" to "first real customer" (per `PROJECT.md`'s own stated commercial stage) — upgrade before that transition, not reactively.
- Do not rely on webhook delivery alone for demo-critical freshness given the Render cold-start risk to webhook latency — this reinforces Pitfall 3's point that the polling/watermark path, not the webhook path, is the actual reliability backbone; the webhook is a latency optimization on top of it, never depended on alone.

**Warning signs:**
- A demo that "worked yesterday" fails to load with a connection error → check Supabase project status first (paused is the most likely free-tier-specific cause).
- First request of a demo takes 30–60s and looks broken/hung before this delay is understood and accounted for.

**Phase to address:**
Infrastructure/deploy phase — the keep-alive mechanism should ship alongside initial deployment setup, not be added reactively after the first failed demo.

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|-----------------|------------------|
| In-process APScheduler instead of Celery/Redis | Zero infra cost, simpler local dev | Reliability tied to a free web dyno's uptime; needs watermark/idempotency discipline to be safe | MVP with 1 tenant, low sync-freshness stakes; revisit once paying tenants exist or Background Worker becomes affordable |
| RLS-only tenant isolation (skip app-level `WHERE tenant_id`) | Less boilerplate per query | One missed/misconfigured policy or one pooled-connection session-variable bug = cross-tenant leak | Never — always pair RLS with explicit app-level filtering in this stack given the connection-pooling risk described in Pitfall 5 |
| Direct-connection (port 5432, non-pooled) `DATABASE_URL` for simplicity | Avoids pooler-specific prepared-statement config | IPv6-only host breaks on Render without the IPv4 add-on; doesn't scale past a handful of concurrent connections | Local dev only, or a platform confirmed to have IPv6 egress |
| Skipping the per-tenant rate limiter and using a generic global one at MVP (single tenant) | Faster to build | Breaks the moment a second tenant connects, or the one tenant shares Tiny with another integrator sooner than expected | Never — build it per-tenant from the start since it's the same amount of code either way, just keyed differently |
| Storing sync watermark in memory instead of Postgres | Simpler first implementation | Every restart/deploy loses state, defeating the catch-up guarantee that's the entire point of not using Celery | Never — this is core to the reliability story, not an optimization to defer |

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|-----------------|-------------------|
| Supabase Postgres (Render → Supabase) | Building `DATABASE_URL` from separate host/password env vars; using the direct-connection host from an IPv6-incapable platform | Use the platform-provided full `DATABASE_URL` string as-is, only rewrite the scheme; use the Supavisor **transaction pooler** (6543) at runtime, **session pooler** (5432 pooler host, not direct host) for Alembic migrations |
| asyncpg via SQLAlchemy async + Supabase transaction pooler | Leaving asyncpg's default statement cache enabled against a transaction-mode pooler | `connect_args={"statement_cache_size": 0, "prepared_statement_cache_size": 0}` on the async engine |
| Tiny ERP API v3 rate limiting | Global/per-app rate limiter instead of per-tenant; immediate retry on 429 | Per-`tenant_id` token bucket sized to the tenant's actual plan; always honor `Retry-After`; hard-stop well before the consecutive-429 lockout threshold |
| Tiny ERP webhooks | Treating webhook delivery as guaranteed / as the sole source of truth | Webhook = latency optimization only; polling with a persisted watermark is the correctness guarantee, always upsert idempotently (`ON CONFLICT (tenant_id, tiny_id) DO UPDATE`) |
| Supabase Auth + custom tenant RLS | Assuming `auth.uid()`/`auth.jwt()` are populated inside a raw SQLAlchemy connection like they are inside Supabase's own client/PostgREST path | Use `SET LOCAL app.tenant_id` per transaction + explicit app-level `WHERE tenant_id = ...` on every query; never rely on RLS alone through a pooled connection |
| Render free-tier hosting | Assuming a "Background Worker" or always-on process is available on the free plan | Free tier only has Web Services (which spin down) and Static Sites; run the scheduler inside the (kept-warm) web process for MVP, and treat moving to a paid Background Worker as an explicit post-MVP trigger |

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|-----------------|
| One Tiny API call per SKU for price/stock sync | Rate limit exhausted fast even with a single tenant during backfill | Use the documented batch endpoint (up to 50 products/call) | Any full backfill or catalog with more than a few dozen SKUs |
| Global (not per-tenant) rate limiter | Works fine with 1 tenant, then a second tenant's sync starves or gets throttled unfairly, or one tenant's burst blocks another's | Per-`tenant_id` token bucket from day one | The moment a second tenant connects |
| Unindexed `tenant_id` filtering in RLS policies / app queries | Query latency creeps up as row counts grow, not visible with 1 tenant's small dataset | Index `tenant_id` (and composite `tenant_id, tiny_id` for upsert conflict targets) from the first migration | A few thousand rows per tenant, or a handful of tenants |
| Wide polling catch-up windows after long dyno-sleep gaps | A poll after hours of sleep pulls a huge "updated since" range in one call, risking pagination/timeout/rate-limit issues | Cap the catch-up window and paginate; if the gap is very large, fall back to a bounded incremental catch-up rather than one giant fetch | After any extended Render sleep period (demo gaps, low-traffic days) |

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| RLS policies referencing `auth.uid()`/`auth.jwt()` on tables written by the raw SQLAlchemy backend | Policy silently no-ops or blocks everything depending on connection path — potential cross-tenant leak | Use custom `tenant_id` + `SET LOCAL` session variable consistently; never mix Supabase-native RLS assumptions with a non-Supabase-client connection |
| `SET` instead of `SET LOCAL` for `app.tenant_id` on a pooled connection | Tenant context leaks across requests sharing a physical pooled connection | Always `SET LOCAL` inside the same transaction as the query; verify with a concurrency test |
| RLS policy defined but `ENABLE ROW LEVEL SECURITY` not run on the table | Policy has zero effect; table is fully open | Checklist/migration review step: every tenant-scoped table must have RLS explicitly enabled, verified via `pg_class.relrowsecurity` |
| Tiny OAuth tokens (`access_token`, `refresh_token`, `client_secret`) stored unencrypted | DB dump/leak exposes every connected tenant's Tiny account | Fernet encryption at rest (already the documented plan) — verify it covers refresh tokens too, not just access tokens |
| Trusting Tiny webhook payloads without verification | Spoofed webhook could trigger unauthorized data fetch/processing for a tenant_id not actually owned by the caller | Validate the webhook against the tenant context it claims (e.g. match against a known `tiny_credentials` record) before acting on it; never trust a `tenant_id` embedded only in the webhook body without cross-checking |

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-------------------|
| Silent stale dashboard data after Render sleep gaps | Tenant thinks sync is "broken" when it's just delayed | Surface a visible "last synced at" timestamp per resource on the dashboard, and a sync health indicator tied to `tiny_credentials.status` |
| No feedback during first-connection full backfill (can take a while given rate limits) | Tenant thinks the connection failed or the app is broken during initial OAuth connect | Show backfill progress/status explicitly (e.g. "syncing 120/450 products") rather than a blank dashboard until backfill completes |
| Token expiry/revocation surfaced only as silent sync failures | Tenant doesn't know they need to reconnect until they notice stale data | Detect persistent 401s, mark `status=expired`/`revoked`, and surface an explicit "reconnect your Tiny account" prompt in the dashboard |

## "Looks Done But Isn't" Checklist

- [ ] **`DATABASE_URL` handling:** Often missing the scheme rewrite for the exact driver in use (`postgresql+asyncpg://`, not just `postgresql://`) — verify by deploying to Render (not just local Docker Compose) before considering the DB layer done.
- [ ] **Async engine + Supabase pooler:** Often missing `statement_cache_size: 0` for the transaction pooler — verify with a concurrency test (multiple simultaneous requests), not a single manual request.
- [ ] **Idempotent upsert:** Often missing the actual `ON CONFLICT (tenant_id, tiny_id) DO UPDATE` — verify by manually replaying the same webhook payload twice and asserting no duplicate row / no error.
- [ ] **Tenant isolation:** Often missing app-level `WHERE tenant_id` alongside RLS, and missing `SET LOCAL` (using `SET` instead) — verify with an automated two-tenant cross-access test, not manual QA with one tenant.
- [ ] **Sync watermark persistence:** Often kept in memory during early development — verify by restarting the process mid-development and confirming sync resumes from the correct point, not from scratch or from a stale point.
- [ ] **Rate limit handling:** Often only handles the happy path plus a generic retry — verify by deliberately forcing several 429s in a row (e.g. lower a test rate limit artificially) and confirming the code backs off and stops well before any lockout threshold, without crashing the sync process for other tenants.
- [ ] **Free-tier keep-alive:** Often entirely absent until the first failed demo — verify a keep-alive ping is actually configured and firing (check Render logs / Supabase activity) before relying on the deployment for anything customer-facing.

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|----------------|------------------|
| `DATABASE_URL`/pooler misconfiguration in production | LOW | Fix the scheme/pooler choice in env vars and redeploy; no data loss since it's a connection-layer issue, not a data-layer one |
| Cross-tenant RLS leak discovered post-launch | HIGH | Immediately restrict the affected table (revoke broad grants), audit logs for actual cross-tenant reads, patch policy + add app-level filter, add regression test before reopening access |
| Supabase project paused mid-demo | LOW | Un-pause from Supabase dashboard (near-instant); add keep-alive afterward so it doesn't recur |
| Sync watermark lost/corrupted after a bad restart | LOW–MEDIUM | Because bronze (`raw_tiny_payloads`) preserves raw payloads and upserts are idempotent, a full re-poll from an earlier watermark (or full backfill re-run) safely reconciles state — the design already accounts for this, just re-trigger backfill for the affected tenant/resource |
| Tiny API 1-hour lockout triggered for a tenant | LOW (waiting) / MEDIUM (trust) | Stop all sync attempts for that tenant immediately on detection, surface status to the tenant, wait out the lockout window before resuming — do not retry during the block |

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|-------------------|----------------|
| `DATABASE_URL`/pooler/IPv4-IPv6 mismatch | Infrastructure/setup phase (pre-Phase 1) | CI smoke test opens a real connection through the deployed-shape `DATABASE_URL` and runs `SELECT 1`; manual deploy-to-Render check before first feature phase starts |
| asyncpg + transaction pooler prepared statements | Infrastructure/setup phase (same as above) | Concurrency test issuing several simultaneous queries against the deployed pooler URL without `DuplicatePreparedStatementError` |
| Scheduler reliability on free-tier Render (no Background Worker, spin-down) | Sync engine phase (products polling/webhook) + Infrastructure/deploy phase for keep-alive | Restart the process mid-test and confirm watermark-based resume with no duplicate/no gap; confirm external keep-alive ping is live in Render logs |
| Tiny per-tenant rate limiting + 429 lockout risk | Tiny OAuth2 connection + first-sync (backfill) phase | Artificially trigger repeated 429s in a test/staging Tiny sandbox (or via a mocked client) and confirm backoff halts well before the lockout threshold |
| Supabase Auth vs custom `tenant_id` RLS bridging | Auth/tenant-provisioning phase (first tenant-scoped table) | Automated two-tenant cross-access test in CI; `pg_class.relrowsecurity` check on every tenant-scoped table |
| Free-tier pause/spin-down compounding around demos | Infrastructure/deploy phase | Keep-alive mechanism configured and observably firing before any demo is scheduled |

## Sources

- [Supabase Connection Pooler Deprecating Session Mode on Port 6543 (changelog)](https://supabase.com/changelog/32755-supabase-connection-pooler-deprecating-session-mode-on-port-6543-on-february-28) — HIGH (official)
- [Supabase Docs: Supavisor and Connection Terminology Explained](https://supabase.com/docs/guides/troubleshooting/supavisor-and-connection-terminology-explained-9pr_ZO) — HIGH (official)
- [Supabase Docs: Connect to your database](https://supabase.com/docs/guides/database/connecting-to-postgres) — HIGH (official)
- [Supabase Docs: Disabling Prepared statements](https://supabase.com/docs/guides/troubleshooting/disabling-prepared-statements-qL8lEL) — HIGH (official)
- [`PreparedStatementError` using asyncpg and sqlalchemy — supabase/supabase#35684](https://github.com/supabase/supabase/issues/35684) — MEDIUM-HIGH (official repo issue, corroborated by multiple independent reports)
- [Python asyncpg fails with burst requests on both Supabase poolers — supabase/supabase#39227](https://github.com/supabase/supabase/issues/39227) — MEDIUM-HIGH (currently open, confirms the issue persists in 2025/2026)
- [sqlalchemy/sqlalchemy #6467 — statement_cache_size / prepared_statement_name_func for asyncpg + pgbouncer](https://github.com/sqlalchemy/sqlalchemy/issues/6467) — HIGH (official SQLAlchemy repo, documents the fix pattern)
- [Supabase Docs: Supabase & Your Network — IPv4 and IPv6 compatibility](https://supabase.com/docs/guides/troubleshooting/supabase--your-network-ipv4-and-ipv6-compatibility-cHe3BP) — HIGH (official)
- [Supabase Docs: Dedicated IPv4 Address for Ingress](https://supabase.com/docs/guides/platform/ipv4-address) — HIGH (official)
- [Render Discourse: Issues Connecting Render to Supabase After IPv6 Transition](https://render.discourse.group/t/issues-connecting-render-to-supabase-after-ipv6-transition/24156) — MEDIUM (community, corroborates official docs)
- [Supabase Docs: Project Pausing](https://supabase.com/docs/guides/platform/free-project-pausing) — HIGH (official)
- [Render Discourse: Web worker not part of the free plan?](https://render.discourse.group/t/web-worker-not-part-of-the-free-plan/24555) — MEDIUM (community, official-adjacent — confirms Background Worker is paid-only)
- [Render: Platforms with a real free tier for developers in 2026](https://render.com/articles/platforms-with-a-real-free-tier-for-developers-in-2026) — MEDIUM (vendor blog)
- [APScheduler discussion: AsyncIOScheduler + FastAPI + gunicorn + multiple workers — agronholm/apscheduler#1088](https://github.com/agronholm/apscheduler/discussions/1088) — HIGH (official APScheduler repo, maintainer-adjacent)
- [Vercel free tier limits 2026 (multiple corroborating sources: deploywise.dev, promptstoproduct.com)](https://deploywise.dev/blog/vercel-free-tier-limits-2026) — MEDIUM (third-party, cross-checked against multiple 2026 writeups converging on the same numbers)
- [Fly.io Free Tier 2026: What's Left After the Cuts?](https://www.saaspricepulse.com/blog/flyio-free-tier-2026) — MEDIUM (third-party, confirms Fly.io is not a viable free-tier alternative to Render for this project as of 2026)
- `docs/03-INTEGRACAO-TINY-ERP.md` (this project's own prior research, dated jul/2026) — MEDIUM, carried forward; **re-verify exact rate-limit numbers and the 5-consecutive-429/1-hour-lockout figure against `ajuda.tiny.com.br` / `tiny.com.br/api-docs` immediately before implementing the rate limiter**, since this session could not independently re-extract that page's content (JS-rendered) and third-party API limits change without notice.
- Prior project fix, `tinysaas` repo commit `55b0f80` ("fix: suporta DATABASE_URL completa para compatibilidade com Render/Supabase pooler") — HIGH (first-hand, confirmed production incident from this user's own prior project; the async-driver equivalent of this exact bug is Pitfall 1 above)

---
*Pitfalls research for: Multi-tenant Tiny ERP → Supabase sync SaaS (FastAPI + SQLAlchemy async + Supabase + free-tier PaaS, no Celery/Redis)*
*Researched: 2026-07-27*
