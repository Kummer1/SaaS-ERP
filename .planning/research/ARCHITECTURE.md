# Architecture Research

**Domain:** Multi-tenant SaaS syncing a third-party ERP (Tiny/Olist) into an owned Postgres database, on a no-Celery/no-Redis, Supabase-backed, free-tier-hosted MVP slice (1 tenant, 1 resource: products)
**Researched:** 2026-07-27
**Confidence:** MEDIUM (web-verified across multiple independent sources incl. Supabase official docs; not yet validated against this project's actual code)

This document assumes the baseline decisions from `docs/01-ARQUITETURA.md` / `docs/02-MODELO-DE-DADOS.md` are still correct (row-level multi-tenancy via `tenant_id` + Postgres RLS, bronze/silver split, hybrid webhook+polling sync). It answers only what changes when Celery/Redis are removed and Supabase (Postgres + Auth) is introduced, scoped to the "1 tenant, 1 resource" MVP slice.

## Standard Architecture

### System Overview

```
┌───────────────────────────────────────────────────────────────────────┐
│                         React SPA (Vercel)                             │
│  - Supabase Auth client SDK (login/signup, session/JWT storage)        │
│  - Calls FastAPI for: OAuth connect flow, dashboard reads               │
└───────────────────────────┬─────────────────────────────────────────────┘
                             │ HTTPS + Authorization: Bearer <supabase JWT>
┌───────────────────────────▼─────────────────────────────────────────────┐
│              FastAPI process — single free web service (Render)         │
│                                                                          │
│  ┌────────────────────┐   ┌───────────────────────────────────────┐    │
│  │ HTTP routes         │   │ In-process scheduler (APScheduler,     │    │
│  │  - /auth (verify)   │   │  AsyncIOScheduler started in lifespan) │    │
│  │  - /tiny/oauth/*     │   │  - ticks while process is awake         │    │
│  │  - /webhooks/tiny    │   └──────────────┬──────────────────────┘    │
│  │  - /internal/sync/*  │◀── external cron │                             │
│  │    (cron-triggered)  │    wakes+triggers │                             │
│  │  - /products (read)  │                   │                             │
│  └─────────┬───────────┘                   │                             │
│            │           tenant-scoped call    │                             │
│            └────────────────┬───────────────┘                             │
│                              ▼                                            │
│              sync_products(tenant_id, session) — pure async function      │
│              (same function called by scheduler, webhook, cron trigger,   │
│               and — later — a Celery task, unchanged)                     │
└──────────────────────────────┬───────────────────────────────────────────┘
                                │ SET LOCAL app.tenant_id + SQL (asyncpg/SQLAlchemy)
                    ┌───────────▼────────────┐        OAuth2 + REST JSON
                    │  Supabase Postgres      │        ┌────────────────────┐
                    │  - tenants, users        │◀──────▶│  Tiny ERP API v3    │
                    │  - tiny_credentials       │        │  (per tenant)        │
                    │  - products (silver)       │        └────────────────────┘
                    │  - raw_tiny_payloads (bronze)│
                    │  - RLS FORCE'd on all above  │
                    └────────────────────────┘
                    ┌────────────────────────┐
                    │ Supabase Auth           │  (issues JWT, backend verifies it;
                    │ (signup/login/session)  │   does NOT drive Postgres RLS directly
                    └────────────────────────┘   since FastAPI, not PostgREST, owns the DB conn)

External free cron (GitHub Actions scheduled workflow or cron-job.org)
  → POST /internal/sync/poll every ~15 min, shared-secret authenticated
  → doubles as a "wake the sleeping dyno" mechanism on Render free tier
```

### Component Responsibilities

| Component | Responsibility | Typical Implementation |
|-----------|----------------|-------------------------|
| FastAPI process | Single deployable unit: HTTP API + in-process scheduler + sync logic. No separate worker process for MVP. | One Render free Web Service running `uvicorn` with a single worker |
| `sync_products(tenant_id, session)` | Idempotent, tenant-scoped sync of one resource. The one place that talks to Tiny's REST API and upserts into Postgres. Trigger-agnostic. | Plain async function, no FastAPI/Celery imports inside it |
| In-process scheduler (APScheduler) | Fires `sync_products` periodically **while the process happens to be awake** | `AsyncIOScheduler`, started/stopped via FastAPI `lifespan` |
| External cron trigger | Fires `sync_products` via HTTP on a fixed cadence, **and** wakes the sleeping free-tier dyno by making an inbound request | GitHub Actions scheduled workflow or cron-job.org hitting `POST /internal/sync/poll` |
| Webhook endpoint | Near-real-time push from Tiny; fetches the full resource and calls the same idempotent upsert path | `POST /webhooks/tiny`, minimal signature/shared-secret check for MVP |
| Tenant-resolution dependency | Decodes Supabase JWT → looks up `tenant_id` → opens a DB transaction and issues `SET LOCAL app.tenant_id` before any query runs | FastAPI `Depends()` wrapping an `AsyncSession` |
| Supabase Postgres | Stores bronze (`raw_tiny_payloads` JSONB) and silver (`products`, `tenants`, `tiny_credentials`) tables; RLS is the enforcement backstop | Managed Postgres 16, RLS policies `FORCE`d on every tenant table |
| Supabase Auth | User signup/login/session issuance only. Does **not** drive our RLS automatically — see Data Flow below. | Supabase client SDK on the frontend; backend only verifies JWTs |

## Recommended Project Structure

```
backend/
├── app/
│   ├── main.py                 # FastAPI app, lifespan starts/stops APScheduler
│   ├── api/
│   │   ├── deps.py             # get_current_tenant() — JWT decode + SET LOCAL
│   │   ├── routes/
│   │   │   ├── auth.py         # thin: verify-only, Supabase SDK does the heavy lifting
│   │   │   ├── tiny_oauth.py   # /tiny/oauth/authorize, /tiny/oauth/callback
│   │   │   ├── webhooks.py     # /webhooks/tiny
│   │   │   ├── internal_sync.py# /internal/sync/poll (external-cron-triggered)
│   │   │   └── products.py     # dashboard read endpoints
│   ├── sync/
│   │   ├── products.py         # sync_products(tenant_id, session) — pure, trigger-agnostic
│   │   └── tiny_client.py      # Tiny REST client: OAuth refresh, 429/backoff handling
│   ├── scheduler.py            # APScheduler setup, registers sync/products.py jobs
│   ├── db/
│   │   ├── session.py          # SQLAlchemy async engine + set-tenant-per-transaction helper
│   │   └── models.py           # tenants, tiny_credentials, products, raw_tiny_payloads
│   └── core/
│       ├── security.py         # Supabase JWT verification (JWKS/secret)
│       └── crypto.py           # Fernet encrypt/decrypt for Tiny tokens
└── alembic/                    # migrations, including RLS policy DDL (not just tables)
```

### Structure Rationale

- **`app/sync/` is framework-agnostic on purpose:** it must not import anything from `app/api/`. This is what makes "add Celery later" a matter of pointing a `@celery_app.task` at `sync_products` instead of rewriting it.
- **`app/api/routes/internal_sync.py` is a distinct route from `webhooks.py`:** one is Tiny calling you (webhook), the other is your own external cron calling you (poll trigger). Conflating them makes the "who triggered this and why" question harder to debug later.
- **`alembic/` owns RLS DDL, not just table DDL:** `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY` plus the policy statements belong in versioned migrations from migration #1, not a manual one-off SQL script run against the Supabase dashboard.

## Architectural Patterns

### Pattern 1: Trigger-agnostic sync function (decouple "what to sync" from "what fired it")

**What:** `sync_products(tenant_id: UUID, session: AsyncSession) -> SyncResult` is the single source of truth for the sync logic (fetch from Tiny, upsert idempotently via `ON CONFLICT (tenant_id, tiny_id) DO UPDATE`). It is called identically by three different triggers.
**When to use:** Any time the orchestration mechanism (in-process scheduler now, Celery later) is expected to change but the business logic isn't.
**Trade-offs:** Slightly more indirection than "just write it in the route handler," but this is exactly what avoids a rewrite when Celery/Redis get added post-MVP.

**Example:**
```python
# app/sync/products.py — no FastAPI, no APScheduler imports here
async def sync_products(tenant_id: UUID, session: AsyncSession) -> SyncResult:
    creds = await get_tiny_credentials(session, tenant_id)
    products = await tiny_client.fetch_products(creds, since=watermark)
    for p in products:
        await upsert_product(session, tenant_id, p)   # ON CONFLICT (tenant_id, tiny_id)
    await advance_watermark(session, tenant_id, "products")
    return SyncResult(...)

# app/scheduler.py
scheduler.add_job(lambda: run_with_new_session(sync_products, tenant_id), "interval", minutes=15)

# app/api/routes/internal_sync.py
@router.post("/internal/sync/poll")
async def trigger_poll(session: AsyncSession = Depends(get_session)):
    for tenant_id in await connected_tenant_ids(session):
        await sync_products(tenant_id, session)

# app/api/routes/webhooks.py
@router.post("/webhooks/tiny")
async def tiny_webhook(payload: dict, session: AsyncSession = Depends(get_session)):
    tenant_id = resolve_tenant_from_webhook(payload)
    await sync_products(tenant_id, session)  # same function, event-triggered
```

### Pattern 2: Free-tier-aware polling — external cron as both trigger and keep-alive

**What:** Because Render's free tier only offers Web Services and Static Sites for free — Background Workers require the paid Starter plan (~$7/mo) — an in-process `APScheduler` job only fires while the process happens to be awake. A free web service sleeps after ~15 minutes of no inbound HTTP traffic, so a purely in-process timer will silently stop firing with no error, which is worse than not polling at all (false sense of reliability). The fix is to make the periodic poll **inbound**, not purely internal: an external free scheduler (a GitHub Actions scheduled workflow, or a service like cron-job.org) calls `POST /internal/sync/poll` on a cadence. This wakes the dyno (inbound HTTP = activity) *and* performs the sync tick in the same call.
**When to use:** Any FastAPI app deployed on a free tier that sleeps on inactivity, where periodic background work must actually run on schedule regardless of traffic.
**Trade-offs:** Adds an external dependency (GitHub Actions or a pinger service) and a shared-secret-protected endpoint that must not be exposed publicly without auth. In exchange, polling reliability no longer depends on the dyno being coincidentally awake. Keep in-process `APScheduler` too — it's useful for anything that only matters while the process is already awake (e.g. token-refresh housekeeping) — but do not rely on it alone for the reconciliation poll that the original docs' "webhook is not a delivery guarantee" reasoning depends on.

### Pattern 3: SET LOCAL, never SET SESSION, for the tenant context

**What:** Every DB transaction that touches tenant-scoped tables must run `SELECT set_config('app.tenant_id', :tenant_id, true)` (the `true` = local-to-transaction) as its first statement, inside the same transaction as the subsequent tenant-scoped queries. RLS policies read it via `current_setting('app.tenant_id')::uuid`.
**When to use:** Always — this is the mechanism connecting the resolved tenant identity to Postgres RLS enforcement.
**Trade-offs:** None real — the alternative (`SET SESSION` / `SET` without `true`) is a correctness bug, not a simpler alternative. It leaks tenant context across requests because both Supabase's PgBouncer/Supavisor pooler (in transaction mode) *and* SQLAlchemy's own async connection pool reuse physical connections across different logical requests. `SET LOCAL` auto-resets at `COMMIT`/`ROLLBACK`, so it cannot leak regardless of which pooling layer is involved.

**Example:**
```python
# app/db/session.py
async def get_tenant_session(tenant_id: UUID) -> AsyncIterator[AsyncSession]:
    async with async_session_factory() as session:
        async with session.begin():
            await session.execute(
                text("SELECT set_config('app.tenant_id', :tid, true)"),
                {"tid": str(tenant_id)},
            )
            yield session
```

## Data Flow

### Request Flow: Supabase JWT → RLS-enforced query

```
Frontend (Supabase Auth SDK login)
    ↓ issues JWT (sub=user_id, app_metadata, exp, ...)
Authorization: Bearer <jwt>  →  FastAPI route
    ↓
get_current_tenant() dependency:
    1. Verify JWT signature (Supabase JWT secret / JWKS) — reject if invalid/expired
    2. Extract user_id from `sub`
    3. Resolve tenant_id for that user_id (see options below)
    4. Open DB transaction, SET LOCAL app.tenant_id = tenant_id
    ↓
Route handler runs tenant-scoped SQL inside that same transaction
    ↓
Postgres RLS policy: USING (tenant_id = current_setting('app.tenant_id')::uuid)
    ↓
Rows returned only if they belong to the resolved tenant — enforced at the DB,
even if the route handler forgot a WHERE clause
```

**Why this differs from Supabase's "native" `auth.uid()`-based RLS pattern:** Supabase's own docs describe RLS policies like `USING (organization_id = auth.jwt()->>'organization_id')`, which works automatically when clients query Postgres *through* Supabase's Data API (PostgREST) or the Supabase client SDK talking to Supavisor — that gateway layer forwards the caller's JWT claims into `request.jwt.claims` as a per-request Postgres setting for you. This project's FastAPI backend connects to Postgres directly via SQLAlchemy/asyncpg, bypassing PostgREST entirely — so that automatic claim-forwarding machinery does not exist here. **FastAPI itself has to play the role PostgREST would normally play**: decode the JWT, resolve the tenant claim, and explicitly set it as a transaction-local Postgres setting (`app.tenant_id`, a custom name — not `request.jwt.claims`) before any query runs. This is a deliberate, correct choice for a project with a custom multi-tenant model (tenant ≠ user, business entity vs. login), not a workaround.

**Two ways to resolve `tenant_id` from the JWT — pick one, MVP recommendation is (A):**

| Option | How | When to use |
|---|---|---|
| **(A) Request-time lookup (recommended for MVP)** | Decode JWT → `user_id`. Query a `memberships`/`profiles` table (`user_id → tenant_id`) once per request. | Simple to build/debug, no Supabase dashboard config beyond a normal table. One extra indexed lookup per request — trivial at MVP scale (1 tenant, few requests/min). |
| **(B) Custom Access Token Hook** | Configure a Supabase Auth Hook (Postgres function or HTTPS hook) that injects `tenant_id` into `app_metadata` at token-mint time; FastAPI reads it straight off the decoded JWT, no DB lookup. | Adds real value once request volume/tenant count grow enough that the per-request lookup matters, or once you want the claim available to be usable client-side too. Requires configuring the hook and handling staleness (a claim only refreshes on next token issuance). |

Migrating from (A) to (B) later does not change anything about the RLS/`SET LOCAL` mechanism — only where the `tenant_id` value comes from inside `get_current_tenant()`. This is a safe, non-breaking upgrade path, not a rewrite.

### Key Data Flows

1. **Auth:** Supabase Auth SDK (frontend) → JWT → FastAPI verifies + resolves tenant → `SET LOCAL` per transaction. Supabase Auth never talks to the app's business tables directly.
2. **Tiny connect:** Tenant (already authenticated) → `/tiny/oauth/authorize` → Tiny login/consent → `/tiny/oauth/callback` (`code` → token exchange) → tokens encrypted (Fernet) → stored in `tiny_credentials`, tenant-scoped and RLS-protected like every other table.
3. **Sync (poll):** External cron → `POST /internal/sync/poll` → for each connected tenant → `sync_products(tenant_id)` → Tiny REST API → bronze insert (`raw_tiny_payloads`) → silver upsert (`products`, `ON CONFLICT (tenant_id, tiny_id) DO UPDATE`) → watermark advanced.
4. **Sync (webhook):** Tiny → `POST /webhooks/tiny` → resolve tenant from payload → same `sync_products` path as above (idempotent, so double-processing with the poll path is safe by construction).
5. **Dashboard read:** Frontend → `GET /products` (JWT attached) → same tenant-resolution dependency → RLS-scoped `SELECT` → JSON response.

## Scaling Considerations

| Scale | Architecture Adjustments |
|-------|---------------------------|
| MVP: 1 tenant, 1 resource | Single free Render web service, in-process APScheduler + external cron trigger, no rate limiter needed (nothing to contend with) |
| Few tenants, 3 resources (customers, orders added) | Iterate `sync_products`-shaped functions per resource; `sync_watermarks` table (already correctly shaped from day 1) gains rows, not a redesign; still no Celery needed if total sync volume stays low and a single 15-min poll cycle for all tenants finishes well within the interval |
| Many tenants / high sync volume | This is where the original docs' Celery+Redis design earns its cost: per-tenant token-bucket rate limiting (Tiny's rate limit is per Tiny account, not per app), parallel worker fan-out, retry/backoff as first-class job behavior. Because `sync_products` was kept trigger-agnostic from day 1, this becomes "add a Celery task that calls the same function" rather than a rewrite |

### Scaling Priorities

1. **First bottleneck:** A single sequential `for tenant in connected_tenants: sync_products(tenant)` loop inside one `/internal/sync/poll` call will eventually not finish inside its interval as tenant count grows. Fix: fan out (asyncio.gather with a concurrency cap first; Celery task queue once that cap itself becomes the bottleneck).
2. **Second bottleneck:** Tiny's rate limit is per tenant's Tiny account, not per your app — a naive shared rate limiter is wrong once there's more than one tenant. Needs a per-`tenant_id` token bucket before scaling past a handful of tenants.

## Anti-Patterns

### Anti-Pattern 1: Trusting `SET SESSION` (or a bare `SET`) with any pooled connection

**What people do:** Set the tenant context once per "session" the way you would with a single dedicated Postgres connection, assuming it's isolated per request.
**Why it's wrong:** Both Supabase's pooler (in transaction mode) and SQLAlchemy's own async connection pool reuse physical connections across different logical requests. A session-scoped `SET` silently leaks tenant A's context into tenant B's request — the worst possible bug class in a multi-tenant SaaS, and one that will not show up in single-user manual testing.
**Instead:** `SET LOCAL` / `set_config(..., true)` inside the same transaction as the queries it protects. It auto-resets at `COMMIT`/`ROLLBACK`, so it cannot outlive the request that set it.

### Anti-Pattern 2: Enabling RLS but not `FORCE`-ing it, or connecting as the table owner

**What people do:** `ALTER TABLE products ENABLE ROW LEVEL SECURITY;` and assume that's sufficient protection.
**Why it's wrong:** RLS policies do not apply to the table owner role by default. If the backend connects to Supabase Postgres using a role that owns the tables (easy to do accidentally with Supabase's default connection string), every RLS policy is silently bypassed — the app *looks* correctly isolated in testing (because there's only one tenant to test against) and fails exactly when a second tenant is added.
**Instead:** `ALTER TABLE products FORCE ROW LEVEL SECURITY;` on every tenant table, and connect the backend as a non-owner application role. Add an explicit cross-tenant isolation test (seed two tenant_ids, prove tenant A cannot read tenant B's row) before writing any real sync code — this test only takes seconds to write and is the cheapest possible insurance against the single worst bug class in this architecture.

### Anti-Pattern 3: Relying on the in-process scheduler alone as the reconciliation safety net

**What people do:** Trust `APScheduler`'s interval job to be the "polling catches what webhooks miss" safety net described in `docs/03-INTEGRACAO-TINY-ERP.md`, without accounting for free-tier sleep.
**Why it's wrong:** A Render free web service sleeping after 15 minutes of inactivity means the scheduler simply doesn't tick during that window — with no error, no log, no alert. The very safety net the architecture depends on to compensate for "webhook is not a delivery guarantee" quietly stops working exactly when there's no traffic (which is also when webhooks are least likely to be tested/observed).
**Instead:** Make the poll trigger inbound (external cron hitting an HTTP endpoint) so the act of triggering the poll is also what wakes the process. Treat in-process `APScheduler` as a bonus for while the process is already awake, not the load-bearing mechanism.

## Integration Points

### External Services

| Service | Integration Pattern | Notes |
|---------|----------------------|-------|
| Tiny ERP API v3 | OAuth2 per tenant; REST/JSON; webhook (Triggers API) + polling reconciliation | Rate limit is per Tiny account, not per app (see `docs/03-INTEGRACAO-TINY-ERP.md`); irrelevant for MVP's single tenant, must be added back (token bucket) before adding a second tenant |
| Supabase Auth | Frontend SDK for login/signup; backend only verifies the resulting JWT | Do not build custom JWT/password logic — this was the original docs' plan pre-pivot and is now explicitly replaced |
| Supabase Postgres | Managed connection via SQLAlchemy async + asyncpg | Use a session-mode/direct connection (not Supavisor transaction-mode) since FastAPI is a persistent process, not serverless — simplifies pooling, though `SET LOCAL` discipline is still mandatory regardless (SQLAlchemy's own pool has the same leak risk) |
| External cron (GitHub Actions / cron-job.org) | Scheduled HTTP POST to a shared-secret-protected internal endpoint | Free; also solves the "wake the sleeping dyno" problem as a side effect |

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|----------------|-------|
| `app/api/` ↔ `app/sync/` | Direct async function call, tenant_id + session passed explicitly | Deliberately no framework coupling in `app/sync/`, so it's portable to a Celery task later without modification |
| `app/api/deps.py` ↔ Postgres | `SET LOCAL app.tenant_id` inside the transaction that follows it | The single choke point where "who is this request for" becomes "what can this DB session see" |
| FastAPI process ↔ external cron | Authenticated HTTP (shared secret header), not a shared queue/broker | Deliberately avoids introducing Redis/Celery just to get a reliable periodic trigger |

## Sources

- Render free tier: Web Services/Static Sites free with sleep after inactivity; Background Workers require paid Starter plan — cross-checked across multiple pricing/comparison sources (MEDIUM confidence, no single canonical Render pricing page cited by title in results)
- Fly.io no longer offers an ongoing free tier as of 2026 (only a short trial) — cross-checked across multiple 2026 pricing-comparison sources (MEDIUM confidence)
- APScheduler + FastAPI lifespan pattern, multi-worker duplicate-job caveat — github.com/agronholm/apscheduler discussions, multiple FastAPI scheduling tutorials (MEDIUM confidence)
- PgBouncer/Supavisor transaction-mode session-variable leakage and the `SET LOCAL` fix — supabase.github.io/supavisor docs plus multiple multi-tenant Postgres RLS articles (MEDIUM confidence; core mechanism corroborated by Postgres's own documented behavior of `SET LOCAL` being transaction-scoped)
- Supabase Custom Access Token Hook injecting `tenant_id` into `app_metadata`, and `auth.jwt()`-based RLS policies — supabase.com/docs (Custom Claims & RBAC, Custom Access Token Hook, Token Security and RLS pages) (MEDIUM-HIGH: official docs surfaced directly, though not fetched via a curated-docs provider in this run)
- FastAPI + SQLAlchemy async tenant-context-per-request pattern (`SET LOCAL` via dependency, RLS as backstop) — multiple FastAPI multi-tenancy pattern write-ups (MEDIUM confidence)

---
*Architecture research for: Multi-tenant SaaS ERP sync (Tiny/Olist) — no-Celery, Supabase-backed MVP slice*
*Researched: 2026-07-27*
