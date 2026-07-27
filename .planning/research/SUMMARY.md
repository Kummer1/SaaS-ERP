# Project Research Summary

**Project:** TinySaaS - Tiny ERP to Dashboard multi-tenant SaaS
**Domain:** Multi-tenant SaaS syncing a third-party ERP (Tiny/Olist) into an owned Postgres database, exposed as an opinionated read-only dashboard, on cost-minimized free-tier hosting
**Researched:** 2026-07-27
**Confidence:** MEDIUM-HIGH

## Executive Summary

This is a multi-tenant integration SaaS: connect a Brazilian small/medium business's Tiny ERP account via OAuth2, sync its product catalog into an owned Postgres database (Supabase), and present a zero-setup dashboard (stock value, low-stock alerts, SKU search) that beats both Tiny's native reporting and the "bring your own Power BI" competitors (Kondado, Integrai) already serving this niche. The pivoted stack removes Celery/Redis in favor of an in-process APScheduler plus an external cron trigger, and replaces custom auth with Supabase Auth (Postgres 16 + Auth), all optimized for a $0/month MVP on Render + Vercel + Supabase free tiers.

The recommended approach is narrow and disciplined: sync exactly one resource (products) for one tenant first, using a trigger-agnostic sync_products(tenant_id, session) function called identically by webhook, in-process scheduler, and an external-cron-triggered HTTP endpoint. Idempotent upserts (ON CONFLICT (tenant_id, tiny_id) DO UPDATE) and a Postgres-persisted sync watermark are non-negotiable from day one - they are what make free-tier unreliability (Render spin-down, Supabase pausing) a staleness problem instead of a correctness problem. Tenant isolation (RLS + SET LOCAL app.tenant_id + explicit app-level WHERE tenant_id) must also exist from the very first tenant-scoped table, not be retrofitted.

The dominant risks are almost entirely infrastructure/platform-shaped, not product-shaped: (1) the exact DATABASE_URL/pooler-mode bug class that already broke the prior tinysaas project (now compounded by the async driver switch to psycopg3/asyncpg and Supabase's IPv4/IPv6 pooler split); (2) Render's free tier having no Background Worker and spinning down after 15 minutes, silently starving the in-process scheduler; (3) Supabase Auth's auth.uid()-based RLS conventions not applying automatically through a raw SQLAlchemy connection, requiring a deliberately bridged custom tenant_id + SET LOCAL pattern; and (4) Tiny's per-tenant-account rate limit, which a naive retry-on-429 loop can escalate into an hour-long lockout. All four are well-understood and have concrete, verified mitigations - the research confidence here is HIGH because most of this is corroborated by official Supabase/Render docs and, for pitfall #1, by direct evidence from this user's own prior project commit history.

## Key Findings

### Recommended Stack

Python 3.12 + FastAPI + SQLAlchemy 2.0 async remain unchanged from the original docs. The key pivot-driven change is the Postgres driver: psycopg3 (async mode) is now recommended over asyncpg, because asyncpg has a currently-open, well-documented incompatibility with Supabase's transaction-mode pooler's prepared-statement handling. Supabase (managed Postgres 16 + Supabase Auth) replaces custom auth entirely; PyJWT + PyJWKClient verifies Supabase JWTs locally against JWKS (not python-jose, which is unmaintained). APScheduler's AsyncIOScheduler replaces Celery+beat for in-process periodic polling, paired with an external free cron (GitHub Actions or cron-job.org) hitting an internal HTTP endpoint - this simultaneously triggers the sync and wakes Render's sleeping free dyno.

**Core technologies:**
- FastAPI + SQLAlchemy 2.0 async - unchanged, async-native, fits I/O-bound ERP-polling workload
- psycopg3 (async) - Postgres driver; avoids asyncpg's open prepared-statement bug against Supabase's pooler
- Supabase (Postgres 16 + Auth) - managed DB and auth, removes hand-rolled password/session logic
- APScheduler (AsyncIOScheduler) - in-process periodic polling without Celery/Redis
- PyJWT + JWKS - local, fast verification of Supabase-issued JWTs
- cryptography (Fernet), httpx, tenacity - token encryption at rest and resilient outbound Tiny API calls

### Expected Features

The MVP is explicitly and correctly scoped to a "1 tenant, 1 resource (products)" slice. The four features that work end-to-end on products-only data are exactly the ones with the highest value-to-cost ratio: total inventory value, low-stock indicator, SKU search, and visible sync status. Anything requiring orders or customers (Curva ABC, sales KPIs, cross-resource dashboards) is correctly deferred to v1.x.

**Must have (table stakes):**
- Idempotent, tenant-scoped product sync with visible sync status ("last synced at")
- SKU/product search and low-stock indicator (Tiny only added this natively in a late version - a documented gap)
- Total inventory value KPI (SUM(price * stock_quantity)) - the single highest-value, lowest-cost number
- Multi-tenant data isolation (invisible to users, but non-negotiable)
- Working OAuth2 connect flow to Tiny with encrypted token storage

**Should have (competitive differentiators):**
- Zero-setup opinionated dashboard vs. competitors' "bring your own Power BI" (Kondado, Integrai) - this is the core product wedge
- Transparent, specific sync-error reporting (vs. Tiny/Olist's own commonly-complained-about integration status opacity)

**Defer (v1.x / v2+):**
- Curva ABC, customer/order sync, cross-resource dashboards, historical trend charts - require Order/Customer resources not yet in scope
- Proactive alert delivery (email/WhatsApp) - compute the low-stock flag now, defer the delivery channel
- Two-way sync, custom report builder, multi-warehouse breakdown, financial reporting - explicitly anti-features; avoid indefinitely

### Architecture Approach

A single FastAPI process (one Render free Web Service) serves HTTP routes, an in-process APScheduler, and calls a framework-agnostic sync_products(tenant_id, session) function that is trigger-agnostic - invoked identically by the scheduler, an external-cron-triggered /internal/sync/poll endpoint, and Tiny's webhook. This is deliberate: it makes "add Celery later" a matter of wrapping the same function in a task, not a rewrite. Every tenant-scoped DB transaction opens with SET LOCAL app.tenant_id (never SET), which RLS policies check via current_setting('app.tenant_id'); because FastAPI connects directly via SQLAlchemy (bypassing PostgREST), it must play the role Supabase's own gateway would normally play in forwarding JWT claims.

**Major components:**
1. app/sync/products.py - pure async, trigger-agnostic idempotent sync logic (fetch, bronze insert, silver upsert, watermark advance)
2. app/api/deps.py - tenant-resolution dependency: JWT decode to tenant_id lookup to SET LOCAL per transaction
3. External cron (GitHub Actions / cron-job.org) - periodic HTTP trigger that doubles as a keep-alive for Render's sleeping dyno
4. Supabase Postgres - bronze (raw_tiny_payloads) + silver (products, tenants, tiny_credentials) tables, RLS FORCEd on every tenant table

### Critical Pitfalls

1. **DATABASE_URL scheme/pooler mismatch** - the exact bug class that broke the prior tinysaas project, now compounded by the psycopg3/asyncpg switch and Supabase's three connection-string variants (direct/IPv6-only, session pooler, transaction pooler). Never reconstruct the URL from parts; only rewrite the scheme on the platform-provided string; use session pooler (5432) for the app and Alembic.
2. **asyncpg + transaction-mode pooler breaks prepared statements under load** - silently, only under concurrency, not on first connection. Mitigated by using psycopg3 instead, or explicitly disabling asyncpg's statement cache if asyncpg is used.
3. **In-process scheduler silently stops firing when Render's free dyno sleeps** - no Background Worker exists on the free tier. Mitigated by persisting the sync watermark in Postgres (not memory) and making the poll trigger inbound (external cron) so triggering and waking happen together.
4. **Tiny's per-tenant-account rate limit** shared with the tenant's other integrations; naive immediate-retry-on-429 risks an hour-long lockout. Mitigated by a per-tenant_id token bucket, honoring Retry-After, and backing off well before the documented consecutive-429 threshold.
5. **Supabase Auth's auth.uid()/auth.jwt() RLS convention does not populate through a raw SQLAlchemy connection** - must bridge with custom tenant_id + SET LOCAL, enforced at both the RLS layer and an explicit app-level WHERE tenant_id (defense in depth, since pooled-connection session-variable leakage is otherwise a real cross-tenant risk).

## Implications for Roadmap

Based on research, suggested phase structure:

### Phase 1: Infrastructure & Connection Foundation
**Rationale:** Every later phase depends on the DB connection and deployment shape working identically in dev and on Render; this is where Pitfalls 1, 2, and 6 must be nailed down before any feature code exists.
**Delivers:** Working FastAPI skeleton deployed to Render, Supabase Postgres connected via the correct pooler/driver combination, Alembic migrations running, CI smoke test (SELECT 1 through the deployed-shape DATABASE_URL), external keep-alive cron configured.
**Avoids:** Pitfall 1 (DATABASE_URL/pooler mismatch), Pitfall 2 (prepared statements), Pitfall 6 (free-tier compounding pause/spin-down risk)

### Phase 2: Auth & Multi-Tenant Foundation
**Rationale:** Multi-tenant isolation is a day-one dependency for every other feature per PROJECT.md and must not be retrofitted; Supabase Auth needs to be wired up before any tenant-scoped data exists.
**Delivers:** Supabase Auth signup/login on the frontend, PyJWT+JWKS verification in FastAPI, tenants/memberships tables, SET LOCAL app.tenant_id dependency, RLS FORCEd on all tenant tables with an automated two-tenant cross-access test in CI.
**Addresses:** Multi-tenant data isolation (table stakes)
**Avoids:** Pitfall 5 (Auth/RLS trust-model mismatch)

### Phase 3: Tiny OAuth2 Connect + Sync Engine (Products)
**Rationale:** This is the core value proposition and the riskiest integration surface (rate limits, idempotency, watermark persistence) - build it as the trigger-agnostic sync_products function from the start so scheduler/webhook/cron-trigger all share one code path.
**Delivers:** OAuth2 authorize/callback flow with Fernet-encrypted token storage, idempotent product upsert (ON CONFLICT (tenant_id, tiny_id)), Postgres-persisted watermark, per-tenant rate limiter with 429 backoff, webhook endpoint + external-cron-triggered polling.
**Uses:** psycopg3 async driver, APScheduler, httpx+tenacity
**Implements:** Trigger-agnostic sync function pattern, external-cron-as-keep-alive pattern
**Avoids:** Pitfall 3 (scheduler reliability on free tier), Pitfall 4 (rate limit lockout)

### Phase 4: Dashboard (Product List, Stock Value, Low-Stock, Sync Status)
**Rationale:** Depends entirely on Phase 3's synced data; these four features are exactly the ones that work end-to-end with products-only data and deliver the "zero-setup dashboard" differentiator against Tiny's native reporting and competitors' BYO-PowerBI approach.
**Delivers:** Product list/search view, total inventory value KPI, low-stock indicator/badge, visible "last synced at" / sync health display.
**Addresses:** Table-stakes features (SKU search, stock value, low-stock indicator, sync status) and the core differentiator (zero-setup opinionated dashboard)

### Phase Ordering Rationale

- Infrastructure must come first because the DB-connection bug class has already caused a real production incident in the prior project and every subsequent phase silently assumes it's solved.
- Auth/tenant isolation comes before any tenant-scoped data exists, per PROJECT.md's explicit "from the first tenant" requirement - RLS bolted on later is the single highest-risk pattern identified across all four research files.
- The sync engine precedes the dashboard because the dashboard has no data to show without it, and the sync engine carries the highest external-integration risk (rate limits, watermark persistence) that should be validated before UI work.
- The dashboard is deliberately the last phase and deliberately narrow (products-only) - this matches the MVP definition in FEATURES.md and avoids building UI for data (orders, customers) that doesn't exist yet.

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 3 (Tiny OAuth2 + Sync Engine):** Tiny's exact rate-limit numbers (plan-tier thresholds, consecutive-429 lockout duration) are MEDIUM confidence, carried from prior project docs and explicitly flagged as needing re-verification against ajuda.tiny.com.br / tiny.com.br/api-docs immediately before implementation - the source page is JS-rendered and could not be re-fetched this session.
- **Phase 2 (Auth & Multi-Tenant):** Supabase Auth Hook plan-gating (whether Custom Access Token Hooks are Teams/Enterprise-only) is unresolved/inconsistent between official docs and community reports - not blocking (the recommended approach avoids Auth Hooks entirely for MVP), but worth a fresh check if this ever becomes relevant.

Phases with standard patterns (skip research-phase):
- **Phase 1 (Infrastructure):** Connection/pooler mechanics are HIGH confidence, verified directly against official Supabase docs and multiple corroborating GitHub issues.
- **Phase 4 (Dashboard):** Standard CRUD/read-endpoint + React SPA patterns, no novel integration risk.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Connection/pooler mechanics and free-tier limits verified against current official docs; exact point-release version pins are MEDIUM (verify at install time) |
| Features | MEDIUM | Tiny-specific complaint patterns and competitor analysis are MEDIUM (cross-checked); generic inventory-dashboard feature lists are LOW (industry boilerplate, not Tiny-specific) |
| Architecture | MEDIUM | Web-verified across multiple independent sources including Supabase official docs; not yet validated against this project's actual code |
| Pitfalls | MEDIUM-HIGH | Supabase/Render/Vercel platform facts are HIGH (official docs + multiple independent reports); Tiny ERP API specifics (rate limits) are MEDIUM and explicitly flagged for re-verification |

**Overall confidence:** MEDIUM-HIGH

### Gaps to Address

- **Tiny ERP exact rate-limit numbers** (per-plan-tier limits, consecutive-429 lockout duration): re-verify directly against ajuda.tiny.com.br / tiny.com.br/api-docs immediately before implementing the rate limiter in Phase 3 - do not code against numbers carried in project docs without a fresh check.
- **Supabase Custom Access Token Hook plan-gating**: conflicting reports on whether this is Teams/Enterprise-only. Not currently a blocker since the recommended architecture avoids Auth Hooks for MVP, but flag if the request-time tenant lookup (Option A) is ever migrated to hook-based claim injection (Option B).
- **Tiny API v3-specific webhook behavior**: the cited webhook doc is v2; PROJECT.md's own docs already flag this as needing re-verification before implementation.
- **Architecture patterns not yet validated against actual project code** - this research is grounded in the pivoted docs (PROJECT.md) but should be sanity-checked against the existing tinysaas codebase structure during Phase 1 planning.

## Sources

### Primary (HIGH confidence)
- Supabase official docs - connection pooling, Supavisor terminology, disabling prepared statements, IPv4/IPv6 compatibility, project pausing, JWT signing keys
- GitHub supabase/supabase issues #39227, #35684, #36618 - primary evidence of asyncpg/pooler prepared-statement bugs
- Prior-project git history (tinysaas repo, commit 55b0f80) - direct first-hand evidence of the DATABASE_URL/pooler bug class
- PyPI package metadata - current version numbers for core dependencies

### Secondary (MEDIUM confidence)
- Render community discussions and official blog - free-tier spin-down behavior, Background Worker paid-only status
- Fly.io free-tier removal coverage (multiple cross-checked 2026 sources)
- Vercel Hobby plan ToS/limits coverage (multiple cross-checked sources)
- Tiny ERP / Olist ReclameAqui complaint threads - reliability/reporting complaint patterns
- Kondado (Tiny+Power BI dashboard vendor) - competitor feature analysis
- Olist official blog - Tiny version 3.43 low-stock report addition, Curva ABC feature

### Tertiary (LOW confidence)
- Generic inventory-dashboard marketing content (Bold BI, Klipfolio, Knack) - not Tiny-specific, industry boilerplate only
- Marketfacil kit/variant modeling article - single third-party source

---
*Research completed: 2026-07-27*
*Ready for roadmap: yes*
