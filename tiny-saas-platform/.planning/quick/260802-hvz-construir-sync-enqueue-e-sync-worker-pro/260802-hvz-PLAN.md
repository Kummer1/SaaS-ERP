---
quick_id: 260802-hvz
type: quick
autonomous: true
requirements: [SYNC-01, SYNC-02]
files_modified:
  - supabase/migrations/<generated-timestamp>_products_sync_tables.sql
  - supabase/migrations/<generated-timestamp>_pgmq_public_read_archive.sql
  - supabase/migrations/<generated-timestamp>_cron_sync_worker_trigger.sql
  - supabase/functions/sync-enqueue/index.ts
  - supabase/functions/sync-enqueue/deno.json
  - supabase/functions/sync-worker/index.ts
  - supabase/functions/sync-worker/deno.json
  - supabase/functions/tiny-mock-produtos/index.ts
  - supabase/functions/tiny-mock-produtos/deno.json
  - supabase/config.toml
  - supabase/functions/.env
  - scripts/test-products-sync-pipeline.ts

must_haves:
  truths:
    - "A tenant with tiny_credentials.status='connected' and a null/stale (>15min) products watermark gets exactly one sync_work message enqueued by sync-enqueue; a tenant with a fresh watermark does not."
    - "sync-worker drains a bounded batch (<=15) of sync_work messages per invocation, resolves each message's own tenant's Tiny access token via Vault, calls the products endpoint (mock for now), and writes bronze (raw_tiny_payloads) + idempotent silver (products upsert) + sync_watermarks for that tenant/resource."
    - "Re-running sync-enqueue immediately after a successful sync-worker cycle for a tenant does NOT re-enqueue that tenant/resource (watermark suppression proven, not assumed)."
    - "Two tenants processed across sync-enqueue/sync-worker runs never show cross-contaminated data — Tenant A's stored products/raw payload trace back only to Tenant A's own mock access token, Tenant B's only to Tenant B's, proven by an explicit isolation tripwire in the test script, not just a tenant_id column check."
    - "A 401 from the Tiny products call marks that tenant's tiny_credentials.status='expired' without crashing the rest of the batch."
    - "sync-worker uses pgmq_public.read + explicit archive (visibility timeout, crash-safe), not Phase 1's pop (delete-on-read) — matching Phase 1's own forward note that Phase 3 must not inherit pop unchanged."
    - "A second, independent pg_cron job schedules sync-worker on a 2-5 min cadence, decoupled from the existing 15-min sync-enqueue-trigger."
  artifacts:
    - supabase/migrations/<ts>_products_sync_tables.sql
    - supabase/migrations/<ts>_pgmq_public_read_archive.sql
    - supabase/migrations/<ts>_cron_sync_worker_trigger.sql
    - supabase/functions/sync-enqueue/index.ts
    - supabase/functions/sync-worker/index.ts
    - supabase/functions/tiny-mock-produtos/index.ts
    - scripts/test-products-sync-pipeline.ts
  key_links:
    - "tiny_credentials.status='connected' + stale/null sync_watermarks.last_synced_at -> sync-enqueue SELECT -> pgmq_public.send('sync_work', {tenant_id, resource_type:'products'})"
    - "pgmq_public.read('sync_work', vt, qty) -> per-message tenant_id -> tiny_credentials.encrypted_access_token -> vault.decrypted_secrets -> fetch(TINY_API_BASE_URL) -> raw_tiny_payloads insert + products ON CONFLICT (tenant_id, tiny_id) DO UPDATE + sync_watermarks upsert -> pgmq_public.archive"
    - "sync_watermarks.last_synced_at -> sync-enqueue's pending-tenant query -> suppresses re-enqueue of an already-synced tenant/resource within the same cycle"
    - "New cron.schedule('sync-worker-trigger', every 2-5 min) -> net.http_post -> sync-worker, independent of the existing cron.schedule('sync-enqueue-trigger', every 15 min)"
---

<objective>
Build the real `sync-enqueue` (producer) and `sync-worker` (consumer) Edge Functions for the **products** resource, replacing Phase 1's `{kind:"ping"}` placeholder logic with the actual Cron→pgmq→Worker pipeline described in `docs/03-INTEGRACAO-TINY-ERP.md` §3-4: a tenant with a connected Tiny integration gets its product catalog synced idempotently, automatically, and resiliently to a single tenant's failure — without ever mixing one tenant's Tiny token or data into another tenant's processing.

Scope is deliberately narrow, matching the task brief exactly: only the `products` resource, only the enqueue/worker pair + their supporting migration + the worker's own cron schedule + a mandatory local end-to-end test. No `clientes`/`pedidos`/dashboard work of any kind.

**Purpose:** prove the sync engine's core mechanism (idempotent upsert, watermark-driven scheduling, per-tenant isolation under a shared service-role connection, crash-safe queue consumption) end-to-end for the first real resource, on the same architecture every later resource (`contatos`, `pedidos`, `estoque`) will reuse.

**Output:** three new migrations, two rewritten Edge Functions, one new mock Edge Function (`tiny-mock-produtos`), and a committed local-only test script proving the full two-tenant cycle — modeled on `scripts/test-oauth-mock-flow.ts` and `scripts/verify-rls-local-isolation.ts`.

---

### Nota de Conflito Arquitetural (pgmq vs. tabela simples) — leia antes de executar

`.planning/ROADMAP.md`'s Phase 3 entry, `docs/01-ARQUITETURA.md` §7, and `docs/02-MODELO-DE-DADOS.md` §5 all document a **confirmed architecture decision (2026-08-01)**: migrate the webhook/sync queue mechanism from `pgmq` (built in Phase 1) to a simple Postgres table with polling, explicitly **"antes da Fase 3 (sync engine) depender dela"** — i.e., before any real sync-engine work depends on the queue. `.planning/STATE.md` lists this as an open Pending Todo.

This task's brief explicitly instructs the opposite for this session: build `sync-enqueue`/`sync-worker` directly on the **existing** `pgmq`/`pgmq_public` infrastructure ("CONTEXTO QUE JÁ EXISTE... não recriar"), with the queue-mechanism migration explicitly framed as out of this session's scope. This is exactly the real dependency the confirmed decision said to avoid creating.

**Resolution for this plan:** proceed on `pgmq` as the task brief explicitly and repeatedly instructs — this also matches Phase 1's own forward-looking note (`01-04-SUMMARY.md`: "Phase 3's real sync worker must switch to `pgmq_public.read` + explicit `archive`... already flagged in-code"), which anticipated Phase 3 extending `pgmq`, not replacing it. This plan does NOT attempt the `pgmq` → `webhook_queue` table migration (out of scope per the brief, and not something three separate docs' worth of decision history should be silently reversed within a single quick-task plan).

**Flag for the user/orchestrator:** this plan, once executed, deepens the real dependency on `pgmq` that the 2026-08-01 decision wanted to avoid. After this session, `STATE.md`'s Pending Todo and `ROADMAP.md`'s Phase 3 "Pre-requisite" line need an explicit human decision: either (a) formally reverse the 2026-08-01 decision and keep `pgmq` permanently (this session's work is direct evidence for that outcome), or (b) still plan the `pgmq` → `webhook_queue` migration as a follow-up — which would now need to migrate this session's real usage, not just Phase 1's placeholder. This plan does not decide (a) or (b) for the user; it only proceeds under the explicit, repeated instruction given for this session.

### Decisão de Design: Enfileiramento Duplicado (obrigatório documentar, não decidir calado)

**Pergunta:** se o ciclo anterior do worker ainda não processou a mensagem quando `sync-enqueue` roda de novo 15 min depois, deixamos enfileirar duplicado ou checamos primeiro se já existe mensagem pendente pro mesmo tenant+recurso?

**Decisão: permitir duplicata.** `sync-enqueue`'s pending-tenant query does **not** check `sync_work` for an already-in-flight message before sending. Rationale, evaluated (not copied blindly from the brief's own suggestion):

- The watermark (`sync_watermarks.last_synced_at`) already prevents re-enqueueing once a cycle **completes**. The only duplicate-risk window is a still-in-flight message from the current, not-yet-finished cycle.
- A "check pending" query would add a second round-trip per invocation, directly working against the stated requirement that `sync-enqueue` be fast enough to comfortably fit the Edge Function CPU budget (`docs/01-ARQUITETURA.md` §5's 2s CPU ceiling) — and it introduces its own check-then-enqueue TOCTOU race unless wrapped in row-level locking, which is disproportionate complexity for the problem.
- The cost of a duplicate is small and bounded: one extra `pgmq` message, one extra (mocked, free) Tiny API call, one extra `ON CONFLICT (tenant_id, tiny_id) DO UPDATE` that is a near-no-op since the data hasn't changed. `docs/03-INTEGRACAO-TINY-ERP.md` §3 already accepts this class of redundancy by design ("rodar o mesmo evento duas vezes... é seguro por construção").
- Structurally, the worker cron (every 2-5 min, this plan's Task 1) runs far more often than the enqueue cron (every 15 min, already live), so the queue should almost never carry more than one pending cycle's worth of messages per tenant — bounding how often duplicates can even occur.
- `pgmq_public.read`'s visibility timeout (Task 1/3) already prevents a *second worker invocation* from double-processing the *same* message concurrently — the residual risk this decision accepts is strictly "enqueue happens again before the first message is archived," not "the same message gets processed twice."

This is implemented as a single efficient query (LEFT JOIN `tiny_credentials` to `sync_watermarks`, not the brief's literal "for each tenant, separate query" framing) — fewer round trips directly serves the "fast enough" requirement.

### Correção técnica: `pop` → `read`+`archive` (a semântica que o brief pede, não o nome que ele usa)

The brief's own worded description of step 1 ("`pgmq_public.pop('sync_work')` — mensagem fica invisível por um tempo, retry automático se o worker cair no meio") describes `pgmq`'s **`read`+visibility-timeout** semantics, not `pop`'s actual behavior (`pop` deletes on read — at-most-once, no crash retry, confirmed by this project's own `01-RESEARCH.md` Pattern 4 and `01-04-SUMMARY.md`). This plan implements the semantics the brief actually describes and needs (crash-safe, at-least-once, explicit archive-on-success) using `pgmq_public.read` + a new `pgmq_public.archive` wrapper — not `pop` — per Phase 1's own explicit forward note that this swap is Phase 3's job.

### Correção técnica: não existe "função wrapper" de Vault no fluxo OAuth

The brief assumes a wrapper function already resolves Vault secrets in the OAuth flow ("nunca lê `vault.decrypted_secrets` direto"). No such wrapper exists: `tiny-oauth-callback/index.ts` resolves secrets via a direct `select decrypted_secret from vault.decrypted_secrets where id = ...` through `_shared/db.ts`'s privileged Transaction-Pooler connection (which itself bypasses RLS — the same trust boundary `service_role` implies, just via a raw DB role rather than a PostgREST JWT claim). `sync-worker` follows this exact, already-established pattern for consistency, rather than inventing a new wrapper with no codebase precedent.
</objective>

<execution_context>
@$HOME/.claude/gsd-core/workflows/execute-plan.md
@$HOME/.claude/gsd-core/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@.claude/CLAUDE.md
@docs/02-MODELO-DE-DADOS.md
@docs/03-INTEGRACAO-TINY-ERP.md
@supabase/functions/_shared/db.ts
@supabase/functions/sync-enqueue/index.ts
@supabase/functions/sync-worker/index.ts
@supabase/migrations/20260729232533_pgmq_public_wrappers.sql
@supabase/migrations/20260729231615_cron_sync_trigger.sql
@supabase/functions/tiny-oauth-callback/index.ts
@scripts/test-oauth-mock-flow.ts
@.planning/quick/260802-oam-tiny-oauth-mock-flow/260802-oam-SUMMARY.md

Facts confirmed during planning (do not re-derive, just use):
- `products`, `sync_watermarks`, `raw_tiny_payloads` tables do not exist yet — this plan creates them. Target shape per `docs/02-MODELO-DE-DADOS.md` §2/§4: `products(id, tenant_id, tiny_id bigint, sku, name, price, stock_quantity, tiny_updated_at, synced_at)` with `UNIQUE (tenant_id, tiny_id)`; `sync_watermarks(id, tenant_id, resource_type, last_synced_at, last_cursor)` needs `UNIQUE (tenant_id, resource_type)` (not explicit in the docs' ER diagram, but required for this plan's `ON CONFLICT` upsert); `raw_tiny_payloads(id, tenant_id, resource_type, resource_id, payload jsonb, fetched_at)`.
- `tiny_credentials.encrypted_access_token` (not `access_token_secret_id` as the brief assumed) holds a Vault secret UUID as text — confirmed live in `20260729003512_init_schema.sql` and proven by `scripts/test-oauth-mock-flow.ts`'s own assertions.
- `pgmq_public` schema already exists, already exposed via the Data API (`supabase/config.toml` `[api] schemas` already lists it) — only `send`/`pop` are wrapped so far. This plan adds `read`/`archive` to the SAME schema via a NEW migration (adding functions to an already-exposed schema needs no further `config.toml`/Data API exposure change).
- `sync-enqueue`/`sync-worker` both stay at Supabase's default `verify_jwt = true` (no `config.toml` override, confirmed — do not add one). The new `tiny-mock-produtos` function DOES need `verify_jwt = false` added, mirroring `tiny-mock-authorize`/`tiny-mock-token`, because the caller (`sync-worker`) authenticates to it with the tenant's own mock Tiny access token, not a Supabase-signed JWT.
- `supabase/functions/.env` already exists on disk (gitignored, created in quick-260802-oam) holding `TINY_OAUTH_AUTHORIZE_URL`/`TINY_OAUTH_TOKEN_URL` and a literal-IP `DATABASE_URL` override for a local Deno-DNS-resolution quirk (`supabase_db_<project>` fails to resolve inside the edge-runtime container even though the container's OS resolver works). This plan's executor cannot read that file directly under this session's permissions, but the actual task executor (with full repo access) can and must: (a) leave the existing `DATABASE_URL` override untouched — `sync-enqueue`/`sync-worker` inherit it automatically once they import `_shared/db.ts`; (b) add `TINY_API_BASE_URL` to that same file, pointing at the **internal** edge-runtime port (mirroring whatever internal host:port `TINY_OAUTH_TOKEN_URL` already uses there, e.g. `127.0.0.1:8081` with the `/functions/v1/` Kong prefix stripped) rather than the externally-published `127.0.0.1:54321` Kong URL — because `sync-worker` calls `tiny-mock-produtos` server-side, from within the same edge-runtime container, the exact same class of call as `tiny-oauth-callback` → `tiny-mock-token` that needed this workaround.
- Local Supabase stack demo JWTs (anon/service_role) are deterministic only if `[auth]` `jwt_secret` is uncustomized in `config.toml` (confirmed: no custom `jwt_secret` set). Rather than hardcoding a literal JWT the planner cannot verify, every local HTTP call to `verify_jwt=true`-protected functions in this plan fetches the current local `SERVICE_ROLE_KEY` dynamically via `supabase status -o env`, guarded to only trust it when the same output's `API_URL` contains `127.0.0.1:54321`.
</context>

<tasks>

<task type="auto">
  <name>Task 1: Migrations — products/sync_watermarks/raw_tiny_payloads tables, pgmq_public read+archive wrappers, sync-worker cron schedule</name>
  <files>supabase/migrations/&lt;ts&gt;_products_sync_tables.sql, supabase/migrations/&lt;ts&gt;_pgmq_public_read_archive.sql, supabase/migrations/&lt;ts&gt;_cron_sync_worker_trigger.sql</files>
  <read_first>supabase/migrations/20260729003512_init_schema.sql, supabase/migrations/20260801234106_fix_rls_tenant_id_cast_and_grants.sql, supabase/migrations/20260729232533_pgmq_public_wrappers.sql, supabase/migrations/20260729231615_cron_sync_trigger.sql, docs/sql/rls_policies.example.sql</read_first>
  <precondition>The local Supabase stack (Docker Desktop + `supabase start`) must already be running — verify with `supabase status` reporting all services up before running `supabase db reset`. If it is not running, halt and report rather than starting Docker yourself, matching this project's established safety discipline (quick-260801-tef precondent).</precondition>
  <action>
Generate three separate, correctly-timestamped migration files via `supabase migration new products_sync_tables`, `supabase migration new pgmq_public_read_archive`, and `supabase migration new cron_sync_worker_trigger` (run sequentially so their timestamps sort in this order) — do not hand-write filenames.

**File 1 (`products_sync_tables`):** lowercase SQL keywords, matching every existing migration's style (never uppercase, unlike `docs/sql/rls_policies.example.sql`, which is reference-only). Create three tables:

`products`: `id uuid primary key default gen_random_uuid()`, `tenant_id uuid not null references tenants(id) on delete cascade`, `tiny_id bigint not null`, `sku text`, `name text not null`, `price numeric`, `stock_quantity int`, `tiny_updated_at timestamptz`, `synced_at timestamptz not null default now()`. Add `create unique index ux_products_tenant_tiny on products (tenant_id, tiny_id);` and `create index ix_products_tenant_sku on products (tenant_id, sku);` (both already specified in `docs/02-MODELO-DE-DADOS.md` §4).

`sync_watermarks`: `id uuid primary key default gen_random_uuid()`, `tenant_id uuid not null references tenants(id) on delete cascade`, `resource_type text not null`, `last_synced_at timestamptz`, `last_cursor text`. Add `unique (tenant_id, resource_type)` — not explicit in the docs' ER diagram, but required so `sync-worker`'s watermark write can use `ON CONFLICT (tenant_id, resource_type) DO UPDATE`; document this addition in a one-line comment.

`raw_tiny_payloads`: `id bigint generated always as identity primary key`, `tenant_id uuid not null references tenants(id) on delete cascade`, `resource_type text not null`, `resource_id text`, `payload jsonb not null`, `fetched_at timestamptz not null default now()`. Add `create index ix_raw_tiny_payloads_tenant_resource on raw_tiny_payloads (tenant_id, resource_type, fetched_at desc);`. Comment explaining this plan writes one bronze row **per individual product** in a fetched batch (not one row per whole API call) — `resource_id` holds that product's own `tiny_id` (as text), keeping bronze replay granularity 1:1 with `products`.

For all three tables: `alter table <t> enable row level security;` + `alter table <t> force row level security;` + `create policy tenant_isolation_<t> on <t> using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);` — the exact fail-closed pattern already fixed for `tenants`/`users`/`tiny_credentials` in `20260801234106_fix_rls_tenant_id_cast_and_grants.sql`, applied fresh here (not the old direct-cast bug) since these are brand-new tables. Add a comment noting NO `grant select ... to authenticated` is added yet for any of the three — `sync-worker`'s own connection (via `_shared/db.ts`, Transaction Pooler) bypasses RLS entirely regardless, and no dashboard/Phase-4 consumer exists yet to need `authenticated` read access; that grant is Phase 4's job when the dashboard actually reads `products`, matching the exact precedent reasoning already used for `tiny_credentials`'s own grant migration.

**File 2 (`pgmq_public_read_archive`):** model directly on `20260729232533_pgmq_public_wrappers.sql`'s exact structure and comment style. Add two new `SECURITY DEFINER` wrapper functions in the existing `pgmq_public` schema (do not recreate the schema or its `grant usage`, both already exist): `pgmq_public.read(queue_name text, vt integer, qty integer) returns setof pgmq.message_record language plpgsql security definer set search_path = '' as $$ begin return query select * from pgmq.read(queue_name, vt, qty); end; $$;` and `pgmq_public.archive(queue_name text, msg_id bigint) returns boolean language plpgsql security definer set search_path = '' as $$ begin return pgmq.archive(queue_name, msg_id); end; $$;`. Then `revoke all on function pgmq_public.read(text, integer, integer) from public;`, `revoke all on function pgmq_public.archive(text, bigint) from public;`, `grant execute on function pgmq_public.read(text, integer, integer) to service_role;`, `grant execute on function pgmq_public.archive(text, bigint) to service_role;` — service_role-only, matching `send`/`pop`'s exact grant discipline. Precede with a comment explaining this is the Phase 3 `read`+`archive` swap that `01-04-SUMMARY.md` explicitly flagged as required (crash-safe, at-least-once processing for `SYNC-01`), and that `pgmq_public`'s existing PostgREST exposure (`config.toml` `[api] schemas`) needs no further change since the schema is already listed there.

**File 3 (`cron_sync_worker_trigger`):** model directly on `20260729231615_cron_sync_trigger.sql`. Add a second, independent `cron.schedule(...)` job named `'sync-worker-trigger'` on schedule `'*/3 * * * *'` (every 3 minutes — inside the brief's 2-5 min range, decoupled from the existing 15-min `sync-enqueue-trigger`, which this file does NOT modify), whose body calls `net.http_post` to `.../functions/v1/sync-worker`, reusing the SAME `vault.decrypted_secrets` lookups by name (`project_url`, `edge_function_key`) already created by `scripts/setup-vault-secrets.ts` and already used by `sync-enqueue-trigger` — do not create new Vault secrets. Precede with a comment noting the same `pg_net` 5-second-timeout-vs-cold-start reliability risk already logged as an open `.planning/WINDOWS.md` deviation for the sibling enqueue job applies here too (informational only, not fixed in this migration — out of this plan's scope).
  </action>
  <verify>
    <automated>supabase db reset && [ "$(grep -c 'force row level security' supabase/migrations/*_products_sync_tables.sql)" = "3" ] && grep -q 'create or replace function pgmq_public.read' supabase/migrations/*_pgmq_public_read_archive.sql && grep -q 'create or replace function pgmq_public.archive' supabase/migrations/*_pgmq_public_read_archive.sql && grep -q 'sync-worker-trigger' supabase/migrations/*_cron_sync_worker_trigger.sql</automated>
  </verify>
  <done>`supabase db reset` applies all three new migrations cleanly (plus every pre-existing migration) with no errors. `products`, `sync_watermarks`, `raw_tiny_payloads` exist with the specified columns/indexes/unique constraints and all three have `ENABLE`+`FORCE ROW LEVEL SECURITY` plus a `tenant_isolation_*` policy using the `nullif(...)`-wrapped cast. `pgmq_public.read`/`pgmq_public.archive` exist, `service_role`-only. A second `cron.schedule` job (`sync-worker-trigger`, `*/3 * * * *`) exists alongside the untouched `sync-enqueue-trigger`.</done>
</task>

<task type="auto">
  <name>Task 2: sync-enqueue — real products-sync producer logic</name>
  <files>supabase/functions/sync-enqueue/index.ts, supabase/functions/sync-enqueue/deno.json</files>
  <read_first>supabase/functions/sync-enqueue/index.ts, supabase/functions/_shared/db.ts, supabase/functions/tiny-oauth-authorize/index.ts</read_first>
  <precondition>Task 1's migrations are applied (local `supabase db reset` succeeded) — `tiny_credentials`, `sync_watermarks` must already exist for this task's queries to be valid.</precondition>
  <action>
Replace the Phase 1 placeholder body (the `{kind:"ping"}` `pgmq_public.send` call) with real logic, keeping the existing verify_jwt-stays-default header rationale comment (still accurate, no `config.toml` change here) but replacing the "Phase 1 scope note" paragraph with a comment referencing this quick task (260802-hvz), the duplicate-enqueue design decision (documented in full in this PLAN's `<objective>` — link back to it briefly, do not re-litigate the reasoning inline at length), and the watermark-staleness threshold used.

Import `sql` from `../_shared/db.ts` in addition to the existing `createClient`/`@supabase/supabase-js` import — this function now needs both: `_shared/db.ts` for real table queries (`tiny_credentials`, `sync_watermarks`), and `supabase-js` + `.schema("pgmq_public").rpc("send", ...)` for the queue write, preserving `01-RESEARCH.md`'s explicit recommendation to keep `pgmq` operations behind the `pgmq_public` RPC path rather than raw SQL.

Handler logic: run a single query joining `tiny_credentials` (aliased `tc`) `LEFT JOIN sync_watermarks` (aliased `sw`, `ON sw.tenant_id = tc.tenant_id AND sw.resource_type = 'products'`) `WHERE tc.status = 'connected' AND (sw.last_synced_at IS NULL OR sw.last_synced_at < now() - interval '15 minutes')`, selecting `tc.tenant_id`. This single round-trip replaces the brief's literal "for each tenant, separate query" framing — deliberately, for speed (see `<objective>`'s Decisão section). For each returned `tenant_id`, call `pgmq_public.send('sync_work', { tenant_id, resource_type: 'products' })` via the existing `supabase.schema("pgmq_public").rpc("send", ...)` pattern, wrapped in its own try/catch so one tenant's enqueue failure doesn't abort the rest of the batch (log the error with the RPC error object only, per the existing "never log service-role key/config" discipline already in this file). Do NOT check `sync_work` for an already-pending message before sending — this is the deliberate, documented decision.

Collect the list of tenant IDs actually enqueued successfully and return `{ enqueued: <count>, tenant_ids: [...] }` as JSON with status 200 (even if `enqueued` is 0 — an empty result is a valid, successful "nothing pending" outcome, not an error).

Update `supabase/functions/sync-enqueue/deno.json` to add `"postgres": "npm:postgres@3.4.9"` alongside the existing `@supabase/supabase-js` import map entry, matching every other function that imports `_shared/db.ts`.
  </action>
  <verify>
    <automated>deno check supabase/functions/sync-enqueue/index.ts && KEY=$(supabase status -o env | grep SERVICE_ROLE_KEY | cut -d'=' -f2 | tr -d '"') && curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:54321/functions/v1/sync-enqueue -H "Authorization: Bearer $KEY" | grep -q '^200$'</automated>
  </verify>
  <done>`sync-enqueue` type-checks, and a manually-authorized local invocation returns HTTP 200 with a JSON body containing an `enqueued` count. Full behavioral proof (correct tenants enqueued, watermark suppression) is deferred to Task 4's end-to-end script.</done>
</task>

<task type="auto">
  <name>Task 3: tiny-mock-produtos + sync-worker — real products-sync consumer logic</name>
  <files>supabase/functions/tiny-mock-produtos/index.ts, supabase/functions/tiny-mock-produtos/deno.json, supabase/functions/sync-worker/index.ts, supabase/functions/sync-worker/deno.json, supabase/config.toml, supabase/functions/.env</files>
  <read_first>supabase/functions/sync-worker/index.ts, supabase/functions/tiny-mock-token/index.ts, supabase/functions/tiny-oauth-callback/index.ts, supabase/migrations/20260729232533_pgmq_public_wrappers.sql</read_first>
  <precondition>Task 1's migrations and Task 2's `sync-enqueue` rewrite are complete — `pgmq_public.read`/`archive` must exist, and `tiny_credentials`/`products`/`sync_watermarks`/`raw_tiny_payloads` must all exist.</precondition>
  <action>
**`tiny-mock-produtos` (new function, MOCK).** Follow the exact disclaimer-comment convention of `tiny-mock-authorize`/`tiny-mock-token` (header comment stating this is NOT the real Tiny API, simulates the `GET /produtos` v3 endpoint per `docs/03-INTEGRACAO-TINY-ERP.md` §4, exists solely to unblock this session before a real Tiny app is available). No database access needed (stateless mock) — `deno.json` needs no import map entries (empty `{}` object is fine, or omit the `imports` key entirely).

Handler: if the request's query string has `simulate=401`, return a 401 JSON error immediately (mock-only test scaffolding, documented as such — exists specifically so this plan's test script can exercise the 401→`expired`-status path deterministically without a real invalid token). Otherwise read the `Authorization` header; if missing or doesn't start with `Bearer `, return a 400 JSON error. Extract the token (strip the `Bearer ` prefix) and take its last 8 characters as a short, non-sensitive "tag" — **critical for this plan's isolation test**: embed this tag into every returned product's name field (e.g. `Produto Mock 1 (token:${tag})`), so the response is provably tied to whichever specific tenant access token was actually sent. Return `{ produtos: [ { id, sku, nome, preco, estoqueAtual, atualizadoEm }, ... ] }` — two fake products is enough — with `id` as fake but stable-looking Tiny numeric IDs (e.g. `900001`, `900002`), `preco` a number, `estoqueAtual` a number, `atualizadoEm` an ISO timestamp (`new Date().toISOString()`), status 200.

Add `[functions.tiny-mock-produtos]` with `verify_jwt = false` to `supabase/config.toml`, placed near the other `tiny-mock-*` entries, with a comment explaining why: this endpoint plays the role of the real Tiny API, which authenticates via the tenant's own Tiny access token (an opaque mock string here), never a Supabase-signed JWT — identical rationale to the existing `tiny-mock-authorize`/`tiny-mock-token` entries.

Add `TINY_API_BASE_URL` to `supabase/functions/.env` (existing gitignored file — append, do not overwrite its existing `TINY_OAUTH_*_URL`/`DATABASE_URL` entries), pointing at `tiny-mock-produtos`'s **internal** edge-runtime URL (mirror whatever internal host:port `TINY_OAUTH_TOKEN_URL` already uses in that file, per this plan's `<context>` note — read the file first to confirm the exact value, do not guess a port).

**`sync-worker` (rewrite).** Keep the existing verify_jwt-stays-default rationale comment; replace the Phase 1 placeholder body. Import `sql` from `../_shared/db.ts` in addition to the existing `supabase-js` client (same dual-client rationale as Task 2's `sync-enqueue`). Read `TINY_API_BASE_URL` from `Deno.env.get()`; if unset, log and return a 500 (matching the existing `TINY_OAUTH_*_URL` unset-guard pattern in `tiny-oauth-callback`/`tiny-oauth-authorize`).

Call `pgmq_public.read('sync_work', 60, 15)` via the existing `supabase.schema("pgmq_public").rpc("read", { queue_name: "sync_work", vt: 60, qty: 15 })` pattern (batch capped at 15, inside the brief's 10-20 range; 60-second visibility timeout, chosen shorter than the worker's own 3-minute cron cadence so a crashed message becomes retryable well before the next scheduled tick, per this PLAN's `<objective>` correction note). If empty, return `{ processed: 0, message: "queue empty" }` with status 200.

**Per-message loop — this is the tenant-isolation-critical section.** For each message returned by `read`, destructure `tenant_id` and `resource_type` freshly from `msg.message` inside the loop body itself (e.g. `const { tenant_id, resource_type } = msg.message as { tenant_id: string; resource_type: string };`) — never read from a variable declared outside the loop or left over from a prior iteration. If `resource_type !== "products"`, log a warning, archive the message (`pgmq_public.archive('sync_work', msg.msg_id)`), and `continue` — out of this session's scope by design, but handled defensively rather than silently mis-processed. Wrap the rest of this iteration's body in its own try/catch so one tenant's failure never aborts the batch or contaminates the next iteration's state.

Query `tiny_credentials` for exactly this iteration's `tenant_id` (`select status, encrypted_access_token from tiny_credentials where tenant_id = ${tenant_id}`). If no row, or `status !== 'connected'`, archive the message and `continue` (tenant disconnected between enqueue and processing — no point calling Tiny). Resolve the access token via `select decrypted_secret from vault.decrypted_secrets where id = ${row.encrypted_access_token}::uuid` — the exact established pattern from `tiny-oauth-callback` (see this PLAN's `<objective>` correction note on the non-existent "wrapper function").

Call `fetch(Deno.env.get("TINY_API_BASE_URL")!, { headers: { Authorization: \`Bearer ${accessToken}\` } })`. If `response.status === 401`: run `update tiny_credentials set status = 'expired' where tenant_id = ${tenant_id}`, archive the message, log a warning (never log the access token itself), and `continue` — do not retry a token already known to be dead. If not `response.ok` for any other reason: log the error, do **NOT** archive (let the visibility timeout expire so the next worker tick redelivers it), and `continue`. If ok, parse the JSON body's `produtos` array.

For a successful response, open one `sql.begin(async (tx) => { ... })` transaction scoped to this tenant/message only: for each product in `produtos`, insert one `raw_tiny_payloads` row (`tenant_id`, `resource_type: 'products'`, `resource_id: String(produto.id)`, `payload: produto` as jsonb, `fetched_at: now()`) — one bronze row per individual product, not one per API call (see Task 1's rationale) — then upsert into `products` (`tenant_id`, `tiny_id: produto.id`, `sku: produto.sku`, `name: produto.nome`, `price: produto.preco`, `stock_quantity: produto.estoqueAtual`, `tiny_updated_at: produto.atualizadoEm`, `synced_at: now()`) with `ON CONFLICT (tenant_id, tiny_id) DO UPDATE SET` all non-key columns from `excluded`. After all products in the batch are written, within the SAME transaction, upsert `sync_watermarks` (`tenant_id`, `resource_type: 'products'`, `last_synced_at: now()`) `ON CONFLICT (tenant_id, resource_type) DO UPDATE SET last_synced_at = excluded.last_synced_at` — ordering matters: the watermark only advances if the bronze+silver writes for this tenant actually committed, never before. Only after the transaction commits, call `pgmq_public.archive('sync_work', msg.msg_id)`; if archiving itself fails, log it but do not throw — the message will simply become visible again after the visibility timeout and be safely reprocessed (idempotent upsert).

Accumulate counts (`processed`, `skipped`, `failed`) across the loop and return them as JSON, status 200, once every message in the batch has been handled (success or failure) — one tenant's failure must never prevent the rest of the batch's messages from being attempted.

Update `supabase/functions/sync-worker/deno.json` to add `"postgres": "npm:postgres@3.4.9"`, matching Task 2's `sync-enqueue` change.
  </action>
  <verify>
    <automated>deno check supabase/functions/sync-worker/index.ts supabase/functions/tiny-mock-produtos/index.ts && grep -c 'functions.tiny-mock-produtos' supabase/config.toml | grep -q '^1$' && KEY=$(supabase status -o env | grep SERVICE_ROLE_KEY | cut -d'=' -f2 | tr -d '"') && curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:54321/functions/v1/sync-worker -H "Authorization: Bearer $KEY" | grep -q '^200$' && curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:54321/functions/v1/tiny-mock-produtos" -H "Authorization: Bearer faketoken12345678" | grep -q '^200$' && curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:54321/functions/v1/tiny-mock-produtos?simulate=401" -H "Authorization: Bearer faketoken12345678" | grep -q '^401$'</automated>
  </verify>
  <done>`sync-worker` and `tiny-mock-produtos` type-check. `tiny-mock-produtos` responds 200 with a `produtos` array embedding the caller's token tag for a normal call, and 401 for `?simulate=401`. A manually-authorized local invocation of `sync-worker` returns HTTP 200 (queue-empty or processed, either is valid at this point). Full behavioral proof (bronze/silver/watermark writes, isolation) is deferred to Task 4.</done>
</task>

<task type="auto">
  <name>Task 4: Local end-to-end test — two-tenant sync pipeline proof, watermark suppression, isolation tripwire</name>
  <files>scripts/test-products-sync-pipeline.ts</files>
  <read_first>scripts/test-oauth-mock-flow.ts, scripts/verify-rls-local-isolation.ts</read_first>
  <precondition>Tasks 1-3 are complete and the local Supabase stack (with hot-reloaded Edge Functions) is running.</precondition>
  <action>
Create `scripts/test-products-sync-pipeline.ts`, mirroring `scripts/test-oauth-mock-flow.ts` and `scripts/verify-rls-local-isolation.ts`'s exact safety conventions: hardcode `LOCAL_CONNECTION_STRING = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"` with a guard throwing if it doesn't contain `127.0.0.1:54322`; hardcode `FUNCTIONS_BASE = "http://127.0.0.1:54321/functions/v1"` with an equivalent guard; never read `DATABASE_URL`/`SUPABASE_DB_URL` from the environment. Build the `sql` client with `{ prepare: false }`.

**Fetch the local service-role key dynamically, never hardcoded:** run `supabase status -o env` via `Deno.Command` (requires `--allow-run=supabase`), parse its stdout for `API_URL="..."` and `SERVICE_ROLE_KEY="..."` (simple line-based regex, e.g. `/^(\w+)="?(.*?)"?$/m` per line), and throw immediately if `API_URL` does not contain `127.0.0.1:54321` — this is the same "structurally incapable of touching anything but local" discipline as the hardcoded connection string, extended to the dynamically-fetched JWT. Use the parsed `SERVICE_ROLE_KEY` as the `Authorization: Bearer` header for every call to `sync-enqueue`/`sync-worker` (both stay `verify_jwt=true`-protected).

**Setup helper** (used twice, once per tenant): insert a disposable `tenants` row (name traceable, e.g. `'Products Sync Test Tenant A - quick-260802-hvz'`), then create two Vault secrets (`vault.create_secret(...)`) — one arbitrary placeholder for `encrypted_client_secret` (NOT NULL column), and one holding a tenant-unique fake access token string (e.g. \`mock_at_tenantA_${crypto.randomUUID()}\`) for `encrypted_access_token` — then insert one `tiny_credentials` row for that tenant with `status = 'connected'`, `client_id` any placeholder, `token_expires_at` ~1h out. Return the tenant ID and the plaintext fake access token (needed later to recognize which tenant's data is whose in the isolation check).

**Step 1 — Tenant A, happy path:**
1. Create Tenant A via the setup helper.
2. `POST ${FUNCTIONS_BASE}/sync-enqueue` with the service-role Bearer token. Assert 200 and that the JSON body's `tenant_ids` includes Tenant A's ID (a null/never-synced watermark makes it pending by construction).
3. Query `select * from pgmq.q_sync_work where message->>'tenant_id' = ${tenantAId}` directly against the local DB — per the brief's literal instruction — filtering by Tenant A specifically (do not assume total queue depth is exactly 1; the pre-existing 15-min `sync-enqueue-trigger` cron job may also be live locally and could add unrelated messages, mirroring the exact defensive pattern already used in `tests/sync_pipeline_test.ts`). Assert exactly one such message exists, with `resource_type = 'products'`.
4. `POST ${FUNCTIONS_BASE}/sync-worker` with the service-role Bearer token. Assert 200.
5. Re-query `pgmq.q_sync_work` filtered by Tenant A — assert zero messages remain (message was archived, not just invisible).
6. Query `raw_tiny_payloads where tenant_id = tenantAId and resource_type = 'products'` — assert at least one row, and that its `payload->>'nome'` (or equivalent field) contains Tenant A's own fake access token's last-8-characters tag (proves the bronze row traces back to Tenant A's own token, not a mix-up).
7. Query `products where tenant_id = tenantAId` — assert rows exist, `tenant_id` correct, and `name` contains Tenant A's own token tag.
8. Query `sync_watermarks where tenant_id = tenantAId and resource_type = 'products'` — assert `last_synced_at` is non-null and within the last 30 seconds (`now() - last_synced_at < interval '30 seconds'`).

**Step 2 — watermark suppression:** immediately `POST ${FUNCTIONS_BASE}/sync-enqueue` again. Assert 200, and that the response's `tenant_ids` does **NOT** include Tenant A (freshly-synced watermark suppresses re-enqueue). Also re-query `pgmq.q_sync_work` filtered by Tenant A to confirm zero messages — corroborating the response body, not just trusting it.

**Step 3 — Tenant B, cross-tenant isolation tripwire:** create Tenant B via the same setup helper (its own distinct fake access token). `POST sync-enqueue` — assert Tenant B's ID appears in `tenant_ids` and Tenant A's still does not (proves A's suppression persists correctly even as a new tenant enters the same cycle). `POST sync-worker` — assert 200. Then the critical assertions: query `products where tenant_id = tenantBId` and assert every row's `name` contains **Tenant B's** token tag and does **NOT** contain Tenant A's; symmetrically, re-query `products where tenant_id = tenantAId` and assert its rows still only contain Tenant A's tag, never Tenant B's. Do the same cross-check on `raw_tiny_payloads` for both tenants. This is the concrete, automated proof that no loop-iteration variable or token ever leaked across tenants — throw a descriptive `Error` naming exactly which tenant's data contained the wrong tag if this fails.

On success, log a single final line summarizing every check passed. In a `finally` block, delete both test tenants (cascades `tiny_credentials`; `products`/`sync_watermarks`/`raw_tiny_payloads` reference `tenants(id) on delete cascade` too per Task 1, so no separate cleanup needed there) and call `sql.end()`.
  </action>
  <verify>
    <automated>deno run --allow-net --allow-env --allow-run=supabase scripts/test-products-sync-pipeline.ts</automated>
  </verify>
  <done>The script runs to completion with exit code 0, and its output — captured verbatim in the SUMMARY — proves, in order: (1) Tenant A gets enqueued and processed, with bronze/silver/watermark all written and traceable to Tenant A's own mock token; (2) an immediate re-run of sync-enqueue does NOT re-enqueue Tenant A; (3) Tenant B goes through the same cycle with zero cross-contamination in either direction (Tenant A's products never show Tenant B's tag and vice versa). Both fake tenants are cleaned up in the `finally` block.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| `sync-worker` (service-role-equivalent DB connection) → multiple tenants' Vault secrets/data in one invocation | The single highest-consequence boundary in this plan — the DB layer does NOT enforce isolation here (RLS is bypassed by the connecting role), so cross-tenant leakage is 100% a code-correctness concern, per the brief's own explicit warning. |
| `sync-worker`/`sync-enqueue` (Edge Function, `verify_jwt=true`) → local/production Data API | Both stay protected by Supabase's default JWT gate; only a valid Supabase-signed JWT (service-role, in this plan's manual/test invocations; the Cron job's Vault-sourced key in production) can invoke them. |
| `sync-worker` → `tiny-mock-produtos` (external-API-shaped call) | Authenticated with the tenant's own **Tiny** access token, never a Supabase JWT — mirrors the real Tiny API's own auth boundary, which is why `tiny-mock-produtos` needs `verify_jwt=false`. |

## STRIDE Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation Plan |
|-----------|----------|-----------|----------|-------------|------------------|
| T-hvz-01 | Information Disclosure | `sync-worker`'s per-tenant loop (Vault token resolution + Tiny call) | critical | mitigate | `tenant_id`/`resource_type` destructured fresh from each message inside the loop body, never hoisted; access token resolved fresh per message from that tenant's own `tiny_credentials.encrypted_access_token`; Task 4's isolation tripwire embeds each tenant's own mock token into stored bronze/silver data specifically to catch any accidental cross-tenant reuse, not just check `tenant_id` columns. |
| T-hvz-02 | Tampering | `sync_work` message processing crash mid-batch | high | mitigate | Switched from Phase 1's `pgmq_public.pop` (delete-on-read, at-most-once, silently drops in-flight work on crash) to `pgmq_public.read` + explicit `archive` (visibility timeout, message stays claimable until archived) — matching Phase 1's own forward note that Phase 3 must not inherit `pop` unchanged (`01-04-SUMMARY.md`). |
| T-hvz-03 | Repudiation | Duplicate `sync_work` enqueue for a tenant/resource still mid-cycle | medium | accept | Deliberately not guarded with a pre-enqueue "check pending" query — see `<objective>`'s full written rationale. Bounded, cheap cost (idempotent upsert absorbs it); avoids a second round-trip per invocation and its own TOCTOU race. |
| T-hvz-04 | Denial of Service | Tiny API error handling inside the per-tenant loop | high | mitigate | Non-401 errors are logged and the message is left un-archived (redelivered via visibility-timeout expiry) instead of throwing and aborting the whole batch; a 401 marks that tenant `status='expired'` and archives the message (no infinite retry against a token already known dead); every iteration wrapped in its own try/catch so one tenant's failure never blocks another's message in the same batch. |
| T-hvz-05 | Information Disclosure | `products`/`sync_watermarks`/`raw_tiny_payloads` RLS | medium | mitigate | All three get `ENABLE`+`FORCE ROW LEVEL SECURITY` and a `tenant_isolation_*` policy on the same fail-closed `NULLIF(...)::uuid` expression already fixed for `tenants`/`users`/`tiny_credentials` — defense-in-depth for whenever Phase 4's dashboard reads `products` as `authenticated`, even though this session's only writer bypasses RLS. |
| T-hvz-06 | Tampering | `tiny-mock-produtos`'s `?simulate=401` test scaffold reaching production | low | mitigate | Function is clearly comment-marked MOCK-ONLY, `verify_jwt=false`-scoped identically to `tiny-mock-authorize`/`tiny-mock-token` (already-accepted precedent for functions that must never be wired into real production traffic), and `TINY_API_BASE_URL` (not a hardcoded call site) is the only thing that would need to change to point at the real Tiny API. |
| T-hvz-SC | Tampering | npm/pip/cargo installs | n/a | accept | No new package installs this session — reuses `npm:postgres@3.4.9` and `npm:@supabase/supabase-js@2.111.0`, both already audited and in use since Phase 1. |

</threat_model>

<verification>
- [ ] `supabase db reset` applies all three new migrations cleanly alongside every pre-existing one
- [ ] `products`, `sync_watermarks`, `raw_tiny_payloads` exist with RLS enabled+forced+policy, matching the fail-closed `NULLIF(...)::uuid` pattern
- [ ] `pgmq_public.read`/`pgmq_public.archive` exist, `service_role`-only grants
- [ ] Second `cron.schedule` job (`sync-worker-trigger`) exists, decoupled from the existing 15-min `sync-enqueue-trigger`
- [ ] `sync-enqueue` enqueues exactly the tenants that are `connected` AND stale/never-synced for `products`, via one joined query (no per-tenant pending-check, per the documented decision)
- [ ] `sync-worker` reads a bounded batch via `read`+`archive`, resolves each message's own tenant's Vault token, writes bronze+silver+watermark atomically per tenant, and marks `expired` on 401
- [ ] `scripts/test-products-sync-pipeline.ts` proves, against a real local stack: enqueue→queue→worker→DB for Tenant A, watermark suppression on immediate re-enqueue, and zero cross-tenant contamination between Tenant A and Tenant B
- [ ] No `clientes`/`pedidos`/dashboard code touched anywhere in this plan
</verification>

<success_criteria>
- A tenant with a connected Tiny integration and a stale/null products watermark is enqueued, processed, and has its products synced idempotently — bronze (`raw_tiny_payloads`) and silver (`products`) both written, `sync_watermarks` advanced only after both commit
- Re-running `sync-enqueue` immediately after a successful cycle does not re-enqueue the same tenant/resource
- Two tenants' data and tokens are proven, not just assumed, never to cross-contaminate during the same or adjacent worker invocations
- `sync-worker` survives a mid-batch single-tenant failure (401 or otherwise) without losing or corrupting other tenants' messages in the same batch
- The worker runs on its own independent `pg_cron` schedule, decoupled from the existing enqueue schedule
- The duplicate-enqueue design decision and the `pgmq` vs. simple-table architecture tension are both explicitly documented, not silently resolved
</success_criteria>

<output>
Create `.planning/quick/260802-hvz-construir-sync-enqueue-e-sync-worker-pro/260802-hvz-SUMMARY.md` when done, including the verbatim output of `scripts/test-products-sync-pipeline.ts`'s run (all steps, not paraphrased), and explicitly restating the two flagged decisions from this plan's `<objective>` (duplicate-enqueue rationale, pgmq-vs-simple-table conflict) for STATE.md's Decisions log.
</output>
