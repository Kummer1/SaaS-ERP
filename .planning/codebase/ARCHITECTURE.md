<!-- refreshed: 2026-08-01 -->
# Architecture

**Analysis Date:** 2026-08-01

## System Overview

```text
┌──────────────────────────────────────────────────────────────────┐
│                        Frontend Layer                             │
│                   React SPA (Vercel)                              │
│              `tiny-saas-platform` (future)                        │
└────────────────────────┬─────────────────────────────────────────┘
                         │ HTTPS/JSON
         ┌───────────────▼──────────────────────────┐
         │  Supabase Edge Functions (Deno/TS)       │
         │  `supabase/functions/`                   │
         │  - health (unauthenticated)              │
         │  - sync-enqueue (cron producer)          │
         │  - sync-worker (queue consumer)          │
         └────────┬──────────────────┬──────────────┘
                  │                  │
         ┌────────▼──────────────────▼──────────────┐
         │   Supabase Postgres (Database Layer)     │
         │   - Auth schema (sessions/users)         │
         │   - Public schema (business tables)      │
         │   - pgmq schema (queue via extension)    │
         │   - Vault (secrets/encryption)           │
         │                                           │
         │  Data Model:                             │
         │  - Bronze: raw_tiny_payloads (JSONB)     │
         │  - Silver: customers, products, orders   │
         │  - sync_watermarks (cursors)             │
         │  - pgmq.sync_work (queue)                │
         └──────────────────────────────────────────┘
              ▲       │          │
              │       │          │
         ┌────┴───────┴──────────▼──────────┐
         │  Supabase Cron (pg_cron + pg_net)│
         │  Triggers sync-enqueue every 15 min
         └────────────────────────────────────┘
              │
              ▼ (OAuth2 + REST JSON)
         ┌──────────────────────────┐
         │   Tiny ERP API v3        │
         │   (per-tenant account)   │
         └──────────────────────────┘
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| Health Check | Verify Postgres connectivity via Transaction Pooler | `supabase/functions/health/index.ts` |
| Sync Enqueuer | Queue producer triggered by Cron every 15 min | `supabase/functions/sync-enqueue/index.ts` |
| Sync Worker | Queue consumer that processes one message at a time | `supabase/functions/sync-worker/index.ts` |
| Database Client | Shared postgres.js connection with Transaction Pooler config | `supabase/functions/_shared/db.ts` |
| Migrations | Schema, extensions, RLS policies, cron schedule, queue setup | `supabase/migrations/*.sql` |
| Tests | Deno test suite verifying pipeline end-to-end | `tests/*.ts` |

## Pattern Overview

**Overall:** Serverless event-driven pipeline with stateless Edge Functions and event sourcing through Postgres queue.

**Key Characteristics:**
- Zero-infrastructure compute (Supabase Edge Functions scale to zero)
- Immutable event log in Postgres (bronze layer) for replay/audit
- Stateless functions stateless between invocations (state in Postgres)
- RLS fail-closed for multi-tenant isolation
- Queue-based async processing instead of long-running workers

## Layers

**Presentation Layer (Frontend):**
- Purpose: React SPA consumed by users, hosted on Vercel
- Location: `tiny-saas-platform/` (currently stub, future phase)
- Contains: React components, auth flow, dashboard
- Depends on: Edge Function API endpoints
- Used by: End users

**API Layer (Edge Functions):**
- Purpose: All backend compute via serverless functions
- Location: `supabase/functions/`
- Contains: Request handlers for health, queue operations, webhooks
- Depends on: Postgres via Transaction Pooler, Supabase Auth, Vault
- Used by: Frontend, Cron scheduler, external webhooks

**Orchestration Layer (Cron + Queue):**
- Purpose: Schedule and coordinate async work
- Location: `supabase/migrations/20260729231615_cron_sync_trigger.sql` (Cron job definition)
- Contains: pg_cron job that calls sync-enqueue via HTTP, pgmq queue storing work items
- Depends on: Edge Functions, Postgres extensions (pg_cron, pg_net, pgmq)
- Used by: Business logic to trigger sync cycles

**Data Layer (Postgres):**
- Purpose: Store business data, queue messages, auth state, secrets
- Location: Supabase Postgres (managed)
- Contains: Auth, public tables, queue schema, vault secrets
- Depends on: RLS policies, indices, migrations
- Used by: All Edge Functions, Cron jobs

**Secrets Layer (Vault):**
- Purpose: Store and decrypt sensitive credentials at rest
- Location: Supabase Vault (builtin to Supabase)
- Contains: Tiny ERP OAuth credentials, platform API keys
- Depends on: Migration setup (`scripts/setup-vault-secrets.ts`)
- Used by: Edge Functions for Tiny API calls

## Data Flow

### Primary Request Path (Health Check)

1. Uptime monitor / load balancer → GET `/functions/v1/health` (`supabase/functions/health/index.ts:10`)
2. Health function connects to Postgres via Transaction Pooler → `supabase/functions/_shared/db.ts:30`
3. Execute `SELECT 1` to verify connectivity (`supabase/functions/health/index.ts:12`)
4. Return `{ status: "ok" }` (200) or `{ status: "error" }` (500)

### Scheduled Sync Cycle (Cron → Queue → Worker)

1. Supabase Cron triggers every 15 minutes (`supabase/migrations/20260729231615_cron_sync_trigger.sql:14-27`)
2. Cron job calls `sync-enqueue` Edge Function via `net.http_post` with Bearer auth from Vault
3. Sync-enqueue connects using Supabase JS client with service-role key (`supabase/functions/sync-enqueue/index.ts:15-19`)
4. Enqueuer calls `pgmq_public.send()` RPC to insert work item into `pgmq.sync_work` queue (`supabase/functions/sync-enqueue/index.ts:23-25`)
5. Return 200 (success) or 500 (error)
6. Separate invocation of sync-worker (triggered externally or by monitoring) calls `pgmq_public.pop()` RPC (`supabase/functions/sync-worker/index.ts:23-25`)
7. Worker processes message payload and returns 200

**State Management:**
- Function state: None (stateless invocations)
- Sync cursor state: Stored in `sync_watermarks` table (tenant + resource type → last_cursor, last_synced_at)
- Rate limit state: Will be stored in a dedicated table (not yet implemented, Phase 2)
- Queue state: Persisted in `pgmq.sync_work` table (at-most-once semantics with `pop`)

## Key Abstractions

**Edge Function:**
- Purpose: Stateless request handler tied to an HTTP endpoint
- Examples: `health/`, `sync-enqueue/`, `sync-worker/`
- Pattern: Import database client, execute business logic, return HTTP response

**Database Client (`postgres.js`):**
- Purpose: Postgres connection with Transaction Pooler configuration
- Examples: `supabase/functions/_shared/db.ts`
- Pattern: Export singleton `sql` tagged-template client with `{ prepare: false }` for Supabase pooler compatibility

**Migration:**
- Purpose: Versioned SQL schema changes applied in order
- Examples: Extensions, cron jobs, queue setup, RLS policies
- Pattern: Timestamp-prefixed filename, idempotent (use `if not exists` / `if not` patterns)

**Supabase RPC Wrapper:**
- Purpose: Expose Postgres stored procedures as PostgREST endpoints
- Examples: `pgmq_public.send()`, `pgmq_public.pop()`
- Pattern: SECURITY DEFINER functions delegating to pgmq schema, with role-based grants

## Entry Points

**Health Endpoint:**
- Location: `supabase/functions/health/index.ts`
- Triggers: HTTP GET /functions/v1/health (public, unauthenticated)
- Responsibilities: Ping Postgres via Transaction Pooler, return JSON status

**Sync Enqueue Endpoint:**
- Location: `supabase/functions/sync-enqueue/index.ts`
- Triggers: HTTP POST /functions/v1/sync-enqueue (protected by JWT, called by Cron via Bearer token from Vault)
- Responsibilities: Insert placeholder work item into queue

**Sync Worker Endpoint:**
- Location: `supabase/functions/sync-worker/index.ts`
- Triggers: HTTP POST /functions/v1/sync-worker (protected by JWT, manually triggered or by external monitor)
- Responsibilities: Pop and process one message from queue

**Cron Job:**
- Location: Defined in `supabase/migrations/20260729231615_cron_sync_trigger.sql`
- Triggers: Every 15 minutes via pg_cron
- Responsibilities: Call sync-enqueue Edge Function via HTTP with Bearer auth from Vault

## Architectural Constraints

- **CPU limit per invocation:** 2 seconds CPU time max per Edge Function invocation (150s wall-clock). Large syncs must chunk and re-invoke.
- **Global state:** No shared memory between invocations. All state (cursors, rate limits, queue) lives in Postgres.
- **Stateless functions:** Edge Functions are ephemeral; connection pooling via Transaction Pooler (port 6543, not 5432). Never use Session Pooler or direct connection for runtime.
- **Connection discipline:** Always read `DATABASE_URL` as one opaque env var; never reconstruct from parts (causes pooler user bugs like `postgres` instead of `postgres.<project-ref>`).
- **Prepared statements:** Must use `{ prepare: false }` in postgres.js when connecting via Transaction Pooler (port 6543), because pooler swaps backend connections between statements.
- **Multi-tenancy:** Isolation enforced by `tenant_id` column + RLS policy `USING (tenant_id = current_setting('app.tenant_id', true)::uuid)`. Absence of `app.tenant_id` setting denies access by default (fail-closed).
- **Authentication:** Supabase Auth native (no custom JWT). Service-role key used only for system operations (queue ops); user requests authenticated with JWT from Supabase Auth.
- **Secrets:** Never hardcode credentials in migrations or functions. Use Supabase Vault for Tiny ERP tokens, platform keys, edge function invocation secrets.

## Anti-Patterns

### Confusing Port 5432 (Direct) with Port 6543 (Pooler)

**What happens:** Migration scripts or functions connect to port 5432 (Session Pooler or direct) instead of 6543 (Transaction Pooler), or vice versa.
**Why it's wrong:** Port 5432 is meant for DDL/migrations and long-lived connections. Edge Functions are short-lived and serverless; using 5432 exhausts session pool limits and defeats the purpose of the pooler. Conversely, using 6543 for migrations risks prepared-statement cache issues if not handled carefully.
**Do this instead:** Use port 6543 with `{ prepare: false }` for all Edge Function connections (`supabase/functions/_shared/db.ts`). Migrations and CLI tools use port 5432 via Supabase CLI, not raw psql.

### Reconstructing DATABASE_URL from Parts

**What happens:** Function reads separate env vars for host, user, password, database, port, and reconstructs the connection string.
**Why it's wrong:** The Supabase Transaction Pooler requires the user to be `postgres.<project-ref>`, not just `postgres`. Hand-reconstruction usually misses the project ref and fails silently or causes auth errors. Prior-project incident: `tinysaas` commit `55b0f80`.
**Do this instead:** Read `DATABASE_URL` or `SUPABASE_DB_URL` as a single env var from Supabase dashboard; never reconstruct. See `supabase/functions/_shared/db.ts:19-20`.

### Hardcoding Secrets in Migrations or Inline

**What happens:** Bearer token, API key, or Tiny ERP secret appears as a literal string in a migration or function.
**Why it's wrong:** Migrations are committed to git. Secrets in git are permanent security incidents.
**Do this instead:** Store secrets in Supabase Vault via `scripts/setup-vault-secrets.ts`. Reference via `vault.decrypted_secrets` views. See `supabase/migrations/20260729231615_cron_sync_trigger.sql:19-22` for Cron job example.

### Using `pop` (Delete-on-Read) for Durable Queue Processing

**What happens:** Sync-worker uses `pgmq.pop()` which deletes the message immediately, then processes it. If the function crashes, the message is lost (at-most-once semantics).
**Why it's wrong:** Real sync work needs idempotence and crash-safety. A lost message could mean orders never sync.
**Do this instead:** Phase 3 will switch to `pgmq.read()` + explicit `archive()` after processing succeeds (at-least-once). This is **declared tech debt** — Phase 1 deliberately uses `pop` to prove the pipeline mechanism. See `supabase/functions/sync-worker/index.ts:17-22` comment.

### RLS Policy Without Fail-Closed Guarantee

**What happens:** A policy uses `USING (tenant_id = current_setting('app.tenant_id'))` without the second `true` parameter, so missing `app.tenant_id` raises an error instead of denying access.
**Why it's wrong:** Error recovery paths might accidentally grant access or allow unintended data leaks if the fail-open error is swallowed.
**Do this instead:** Always use `USING (tenant_id = current_setting('app.tenant_id', true)::uuid)`. The `true` parameter makes missing settings return `NULL`, so `NULL = NULL` evaluates to false (safe default deny). See `docs/02-MODELO-DE-DADOS.md §3`.

## Error Handling

**Strategy:** Fail-fast with structured logging; no retry logic in Edge Functions (rely on external monitoring/scheduler).

**Patterns:**
- Database connection errors: Log error object, return HTTP 500
- Queue operation errors: Log RPC error, return HTTP 500
- Missing required env vars: Throw error immediately on module load (fail-fast)
- Never log connection strings, service-role keys, or sensitive env vars — log error objects only

See `supabase/functions/health/index.ts:17-19` for example of safe error logging.

## Cross-Cutting Concerns

**Logging:** Console.log/console.error to Supabase Edge Function logs (visible in dashboard). Structured as `console.error("context", errorObject)` — never interpolate secrets.

**Validation:** Not yet implemented (Phase 2+). Incoming webhook payloads will be validated against Tiny ERP schema before queue insertion.

**Authentication:** Supabase Auth for user requests. Service-role key for system operations (queue, sync). Bearer tokens from Vault for Cron calls to Edge Functions.

---

*Architecture analysis: 2026-08-01*
