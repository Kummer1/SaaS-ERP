# Roadmap: Tiny SaaS Platform

## Overview

The journey starts with a boring but non-negotiable foundation: a FastAPI backend deployed on
Render, wired to Supabase Postgres through the exact driver/pooler combination that already broke
the prior `tinysaas` project once (see commit `55b0f80`), with migrations and a keep-alive cron
proven working end-to-end before any feature code exists. On top of that, tenant identity and
isolation go in — Supabase Auth for signup/login, and `tenant_id` + Postgres RLS enforced and
tested with a cross-tenant access test from the very first tenant, never retrofitted. With
identity and isolation solid, the core value proposition gets built: a tenant connects their Tiny
ERP account via OAuth2 and the platform syncs their product catalog idempotently, on an automatic
schedule, resilient to Tiny's rate limits. The roadmap ends with the payoff — a dashboard where
that same tenant sees their synced products, total stock value, low-stock signal, and sync health,
proving the sync engine works reliably end-to-end. This is the one thing the MVP exists to prove
before any expansion to more tenants or more resources.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: Infrastructure & Connection Foundation** - Backend deployed on Render, connected to Supabase Postgres via the correct driver/pooler, migrations and keep-alive cron proven working
- [ ] **Phase 2: Auth & Multi-Tenant Foundation** - Tenants sign up/log in via Supabase Auth, with tenant isolation (`tenant_id` + RLS) enforced and tested from day one
- [ ] **Phase 3: Tiny OAuth2 Connect + Sync Engine (Products)** - Tenant connects their Tiny ERP account and products sync idempotently on an automatic, rate-limit-aware schedule
- [ ] **Phase 4: Dashboard (Product List, Stock Value, Low-Stock, Sync Status)** - Tenant sees synced products, stock value, low-stock indicator, and sync health in a dashboard

## Phase Details

### Phase 1: Infrastructure & Connection Foundation
**Goal**: The backend's core infrastructure works end-to-end in production — FastAPI deployed on Render, connected to Supabase Postgres through the correct driver/pooler combination, with Alembic migrations and a keep-alive cron configured — before any feature code exists.
**Mode:** mvp
**Depends on**: Nothing (first phase)
**Requirements**: None directly — this phase de-risks the DATABASE_URL/pooler bug class (already caused a production incident in the prior `tinysaas` project, see commit `55b0f80`) and free-tier scheduler reliability risk that every later phase silently depends on.
**Success Criteria** (what must be TRUE):
  1. The FastAPI backend responds to a health-check request at its public URL deployed on Render's free tier.
  2. Alembic migrations run successfully against Supabase Postgres using the correct pooler/driver combination (session pooler + psycopg3 async), both locally and in production.
  3. A CI smoke test executes `SELECT 1` using exactly the same DATABASE_URL shape used in production, preventing the pooler/driver mismatch that broke the prior project.
  4. An external keep-alive cron is configured and successfully wakes Render's sleeping free-tier dyno between scheduled hits.
**Plans**: TBD

### Phase 2: Auth & Multi-Tenant Foundation
**Goal**: Users can sign up and log in via Supabase Auth, and tenant isolation (`tenant_id` + Postgres RLS) is enforced and validated before any tenant-scoped data exists in the system.
**Mode:** mvp
**Depends on**: Phase 1
**Requirements**: AUTH-01, AUTH-02, TENANT-01
**Success Criteria** (what must be TRUE):
  1. A user can sign up and log in to the application through a login/signup form backed by Supabase Auth.
  2. The user's session persists across browser refreshes without requiring a new login.
  3. Every tenant-scoped table has RLS forced, with policies keyed on `tenant_id` applied via `SET LOCAL app.tenant_id` per transaction.
  4. Tenant isolation is validated by an automated cross-access test — tenant A cannot read tenant B's data.
**Plans**: TBD

### Phase 3: Tiny OAuth2 Connect + Sync Engine (Products)
**Goal**: A tenant connects their Tiny ERP account via OAuth2, and the system syncs products idempotently, reliably, and resiliently to rate limits, on an automatic schedule — without requiring manual action from the tenant.
**Mode:** mvp
**Depends on**: Phase 2
**Requirements**: TINY-01, TINY-02, TINY-03, SYNC-01, SYNC-02, SYNC-04
**Success Criteria** (what must be TRUE):
  1. A tenant can connect their Tiny ERP account through a complete OAuth2 flow (authorize → callback → tokens saved), with tokens (client_secret, access_token, refresh_token) stored encrypted at rest via Fernet.
  2. The tenant sees their Tiny connection status (connected/expired/revoked) in the application.
  3. Products sync from Tiny to the platform's own database idempotently — running the same sync twice does not duplicate records.
  4. Sync runs automatically on a schedule (in-process scheduler + external cron trigger), without requiring manual action from the tenant.
  5. The system respects Tiny's rate limit — applies backoff on `429` responses, honors `Retry-After`, and avoids the 1-hour lockout triggered by 5 consecutive 429s.
**Plans**: TBD

### Phase 4: Dashboard (Product List, Stock Value, Low-Stock, Sync Status)
**Goal**: A tenant sees their synced products, total stock value, low-stock indicator, and sync health in a dashboard — proving the sync engine works end-to-end.
**Mode:** mvp
**Depends on**: Phase 3
**Requirements**: SYNC-03, DASH-01, DASH-02, DASH-03
**Success Criteria** (what must be TRUE):
  1. The tenant sees a list of synced products with search by SKU/name.
  2. The tenant sees the total stock value KPI (`SUM(price * stock_quantity)`).
  3. The tenant sees a low-stock indicator for products below their minimum stock level.
  4. The tenant sees "last synced at" and the sync health status on the dashboard.
**Plans**: TBD
**UI hint**: yes

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Infrastructure & Connection Foundation | 0/TBD | Not started | - |
| 2. Auth & Multi-Tenant Foundation | 0/TBD | Not started | - |
| 3. Tiny OAuth2 Connect + Sync Engine (Products) | 0/TBD | Not started | - |
| 4. Dashboard (Product List, Stock Value, Low-Stock, Sync Status) | 0/TBD | Not started | - |
