-- Tiny OAuth2 connect flow — supporting tables (mocked dev flow, quick-260802-oauth-mock).
--
-- Two tables:
--   1. tiny_oauth_states: ephemeral, holds a pending connection attempt between
--      "tenant clicked connect" (tiny-oauth-authorize) and "Tiny redirected back"
--      (tiny-oauth-callback). Anti-CSRF `state` is the join key. client_secret is
--      encrypted via Supabase Vault (vault.create_secret) even here, since it's
--      real tenant-supplied secret material the instant it's typed in — never
--      held in plaintext past the request that receives it. This table is NOT
--      tiny_credentials: a row here means "connection attempted, not yet proven",
--      so tiny_credentials.status keeps its existing three-value contract
--      (connected/expired/revoked) unchanged.
--   2. tiny_oauth_mock_codes: MOCK-ONLY infrastructure. Simulates the
--      authorization-code store a real OAuth2 provider (Tiny) keeps
--      server-side. Nothing in production wiring reads or writes this table —
--      it exists solely for tiny-mock-authorize / tiny-mock-token, so local/dev
--      testing can prove our OAuth *client* logic without a real Tiny app.
--
-- Both tables follow the fail-closed RLS convention already applied to
-- tenants/users/tiny_credentials (see 20260801234106_fix_rls_tenant_id_cast_and_grants.sql):
-- RLS enabled + forced, with NO policies defined. Only roles that bypass RLS
-- (the Transaction Pooler connection used by _shared/db.ts) can read/write —
-- these are backend-orchestration tables, never queried directly by
-- `authenticated`/`anon` through the Data API.

create table tiny_oauth_states (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null references tenants(id) on delete cascade,
    client_id text not null,
    encrypted_client_secret text not null, -- vault.secrets.id, stored as text
    redirect_uri text not null,
    state text not null unique,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null,
    consumed boolean not null default false
);

comment on table tiny_oauth_states is
    'Pending Tiny OAuth2 connection attempts, keyed by anti-CSRF state. Consumed and left to expire once tiny-oauth-callback finishes (success or failure) — not a durable credentials store, see tiny_credentials for that.';

create table tiny_oauth_mock_codes (
    id uuid primary key default gen_random_uuid(),
    code text not null unique,
    client_id text not null,
    redirect_uri text not null,
    state text not null,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null,
    used boolean not null default false
);

comment on table tiny_oauth_mock_codes is
    'MOCK-ONLY. Simulates Tiny''s server-side authorization-code store for tiny-mock-authorize/tiny-mock-token. Not part of the real Tiny integration — do not reference from production sync/dashboard code.';

alter table tiny_oauth_states enable row level security;
alter table tiny_oauth_states force row level security;
alter table tiny_oauth_mock_codes enable row level security;
alter table tiny_oauth_mock_codes force row level security;
