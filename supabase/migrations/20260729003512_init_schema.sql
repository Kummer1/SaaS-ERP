create extension if not exists pgcrypto;

create table tenants (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    plan text not null default 'basico',
    created_at timestamptz not null default now()
);

create table users (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null references tenants(id) on delete cascade,
    email text not null,
    hashed_password text not null,
    role text not null default 'member',
    created_at timestamptz not null default now(),
    unique (tenant_id, email)
);

create table tiny_credentials (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null references tenants(id) on delete cascade,
    client_id text not null,
    encrypted_client_secret text not null,
    encrypted_refresh_token text,
    encrypted_access_token text,
    token_expires_at timestamptz,
    status text not null default 'connected'
        check (status in ('connected', 'expired', 'revoked')),
    created_at timestamptz not null default now(),
    unique (tenant_id)
);

-- RLS
alter table tenants enable row level security;
alter table users enable row level security;
alter table tiny_credentials enable row level security;

-- tenants: cada conexão tenant-scoped só enxerga o próprio registro,
-- e só em SELECT. Criação de tenant (signup) passa pela service_role,
-- que sempre ignora RLS — não existe policy de insert aqui de propósito.
create policy tenant_self_read on tenants
    for select
    using (id = current_setting('app.tenant_id', true)::uuid);

create policy tenant_isolation_users on users
    using (tenant_id = current_setting('app.tenant_id', true)::uuid)
    with check (tenant_id = current_setting('app.tenant_id', true)::uuid);

create policy tenant_isolation_tiny_credentials on tiny_credentials
    using (tenant_id = current_setting('app.tenant_id', true)::uuid)
    with check (tenant_id = current_setting('app.tenant_id', true)::uuid);