-- Quick task 260802-hvz: silver (products) + bronze (raw_tiny_payloads) +
-- watermark (sync_watermarks) tables for the products sync engine
-- (sync-enqueue/sync-worker). Target shape per docs/02-MODELO-DE-DADOS.md
-- §2/§4, confirmed during planning (see this quick task's PLAN.md <context>
-- "Facts confirmed during planning").

create table products (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null references tenants(id) on delete cascade,
    tiny_id bigint not null,
    sku text,
    name text not null,
    price numeric,
    stock_quantity int,
    tiny_updated_at timestamptz,
    synced_at timestamptz not null default now()
);

create unique index ux_products_tenant_tiny on products (tenant_id, tiny_id);
create index ix_products_tenant_sku on products (tenant_id, sku);

-- sync_watermarks: one row per (tenant, resource_type), tracking the last
-- successful sync. UNIQUE (tenant_id, resource_type) is NOT explicit in
-- docs/02-MODELO-DE-DADOS.md's ER diagram, but is required here so
-- sync-worker's watermark write can use
-- ON CONFLICT (tenant_id, resource_type) DO UPDATE.
create table sync_watermarks (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null references tenants(id) on delete cascade,
    resource_type text not null,
    last_synced_at timestamptz,
    last_cursor text,
    unique (tenant_id, resource_type)
);

-- raw_tiny_payloads: bronze layer. One row per INDIVIDUAL product in a
-- fetched batch (not one row per whole API call) -- resource_id holds that
-- product's own tiny_id (as text), keeping bronze replay granularity 1:1
-- with products.
create table raw_tiny_payloads (
    id bigint generated always as identity primary key,
    tenant_id uuid not null references tenants(id) on delete cascade,
    resource_type text not null,
    resource_id text,
    payload jsonb not null,
    fetched_at timestamptz not null default now()
);

create index ix_raw_tiny_payloads_tenant_resource
    on raw_tiny_payloads (tenant_id, resource_type, fetched_at desc);

-- RLS: fail-closed NULLIF(...)::uuid pattern, matching the pattern already
-- fixed for tenants/users/tiny_credentials in
-- 20260801234106_fix_rls_tenant_id_cast_and_grants.sql (applied fresh here,
-- not the old direct-cast bug, since these are brand-new tables).
alter table products enable row level security;
alter table products force row level security;
create policy tenant_isolation_products on products
    using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table sync_watermarks enable row level security;
alter table sync_watermarks force row level security;
create policy tenant_isolation_sync_watermarks on sync_watermarks
    using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table raw_tiny_payloads enable row level security;
alter table raw_tiny_payloads force row level security;
create policy tenant_isolation_raw_tiny_payloads on raw_tiny_payloads
    using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- No `grant select ... to authenticated` yet for any of these three tables:
-- sync-worker's own connection (via _shared/db.ts, Transaction Pooler)
-- bypasses RLS entirely regardless of grants, and no dashboard/Phase-4
-- consumer exists yet to need `authenticated` read access. That grant is
-- Phase 4's job when the dashboard actually reads `products` -- matching the
-- exact precedent reasoning already used for tiny_credentials's own grant
-- migration (20260801234106_fix_rls_tenant_id_cast_and_grants.sql).
