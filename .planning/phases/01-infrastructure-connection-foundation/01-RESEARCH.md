# Phase 1: Infrastructure & Connection Foundation - Research

**Researched:** 2026-07-28
**Domain:** Supabase Edge Functions (Deno/TypeScript) deployment mechanics, Postgres connection from Edge Functions (pooler/driver), Supabase CLI SQL migrations, Supabase Cron (pg_cron/pg_net), Supabase Queues (pgmq), CI smoke testing, free-tier limits
**Confidence:** MEDIUM-HIGH overall — package versions and free-tier numeric limits are directly verified against the npm registry and Supabase's own docs pages this session; the exact GitHub Actions "SELECT 1" smoke-test pattern is this research's own synthesis (no single canonical example found) and is flagged LOW/assumed accordingly.

> **Supersedes** the previous version of this file, which researched a Python/FastAPI/SQLAlchemy/Alembic/Render architecture. That architecture was abandoned mid-planning (see `01-CONTEXT.md` D-01/D-02) in favor of TypeScript/JavaScript Supabase Edge Functions. Do not carry forward driver/pooler-mode conclusions from the old file — the pooler mode recommendation is **different** for this runtime (see Standard Stack and Pitfall 1 below). The old file's data-model/RLS/Tiny-ERP-API content was never authoritative here in the first place — see `docs/02-MODELO-DE-DADOS.md` and `docs/03-INTEGRACAO-TINY-ERP.md`, both unaffected by the pivot.

## Summary

This phase proves the backend's infrastructure end-to-end before any feature code exists, on an entirely new (post-pivot) stack: Supabase Edge Functions (Deno/TypeScript) instead of FastAPI-on-Render. The single highest-risk item — carried forward explicitly from the prior project's production incident (`tinysaas` commit `55b0f80`) — is getting the Postgres connection method right for the *new* runtime. The risk pattern is the same shape (wrong pooler, wrong username format, reconstructing a connection string from parts) but the specifics have changed in an important way: whereas the old Python/Render research correctly recommended the **Session Pooler** (port 5432) because Render ran one persistent long-lived process, Edge Functions are short-lived/serverless, and Supabase's own documentation explicitly recommends the **Transaction Pooler** (port 6543) for exactly this workload shape. Using the Session Pooler recommendation from the old research in the new runtime would be itself a subtle but real mistake.

The second major finding is that Transaction Pooler mode does not support prepared statements — the same underlying pooler-connection-sharing behavior that broke asyncpg in the old Python stack has a direct analog for the recommended Deno client (`postgres.js` / `npm:postgres`): it must be constructed with `{ prepare: false }`. This is the exact "same bug class, different runtime" risk `01-CONTEXT.md` flags, and it is the most important single configuration line in this phase.

Third, this phase's Cron + Queue + Edge Function pipeline (success criterion 4) is not a custom design — it is Supabase's own documented reference architecture (`pg_cron` + `pg_net` triggering an Edge Function, which enqueues work items into a `pgmq`-backed Queue, consumed by a separate worker Edge Function). All three pieces (pg_cron, pg_net, pgmq) are Postgres extensions enabled per-project, not external services, and none carries a separate free-tier price tag beyond the project's overall database size limit.

**Primary recommendation:** Scaffold `supabase/functions/health/index.ts` (public, `verify_jwt = false`) and `supabase/functions/sync-enqueue/` + `supabase/functions/sync-worker/` (or minimal placeholders proving the pattern) as Deno Edge Functions; connect to Postgres exclusively via the **Transaction Pooler** connection string (port 6543, username `postgres.<project-ref>`) using `postgres.js` with `prepare: false`, never reconstructed from parts; manage schema with the Supabase CLI's native SQL migration workflow (`supabase migration new` / `supabase db push`); wire `pg_cron` + `pg_net` (with credentials in Supabase Vault, never hardcoded) to invoke the enqueue function on schedule, publishing to a `pgmq` queue consumed by the worker function; and validate the whole connection path in CI with a small script using the same `postgres.js`/`prepare:false` client against a `DATABASE_URL` repository secret — not a generic `postgres:` service container, which would validate nothing about this phase's actual risk.

## Project Constraints (from CLAUDE.md)

`.claude/CLAUDE.md`'s "Technology Stack" table is **stale and pre-pivot** — it documents Python 3.12 + FastAPI + SQLAlchemy + Alembic + psycopg3 + APScheduler + Render, none of which apply after `01-CONTEXT.md` D-01/D-02. Per this research's assigned scope, this file does not rewrite CLAUDE.md, but the planner and any implementer must **not** follow that table for the backend runtime. The following CLAUDE.md directives remain in force and are *not* superseded by the pivot:

- **Cost constraint:** MVP infrastructure must run on free tiers. This is now Supabase free tier (DB + Auth + Edge Functions) + Vercel free tier (frontend) — Render is removed entirely, not replaced by a paid equivalent.
- **GSD workflow enforcement:** file-changing work must go through a GSD command (`/gsd-execute-phase`, `/gsd-quick`, `/gsd-debug`), not direct ad-hoc edits.
- **"Never reconstruct a platform-provided connection string from separate host/user/password parts"** — the specific driver/scheme target changes (see Standard Stack below) but this rule itself is unchanged and is the direct lesson from commit `55b0f80`.
- **Timeline:** no fixed deadline; correctness over speed.
- **Commercial stage:** pre-revenue/speculative — do not add paid-tier infrastructure preemptively.

CLAUDE.md's stale Technology Stack table should be refreshed after this phase's plan executes (flagged here per `01-CONTEXT.md`'s own recommendation; not part of this phase's plan).

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|-----------------|-----------|
| Health-check endpoint (`GET /functions/v1/health`) | API / Backend (Edge Function) | — | Public, unauthenticated Deno function; the polling actor (uptime checker, later phases) lives outside this tier |
| Postgres connection (pooler + driver config) | API / Backend | Database / Storage | Connection logic lives in Edge Function code, but exists entirely to satisfy Supabase's Supavisor pooler contract on the database tier |
| Schema migrations (Supabase CLI SQL) | Database / Storage | API / Backend (invokes via CI/CD) | Migrations define/own schema state; `supabase db push` is a CLI action invoked from CI, not app runtime code |
| `pg_cron` schedule | Database / Storage | API / Backend (target of the call) | Runs *inside* Supabase Postgres itself — this is a DB-tier actor calling out to the API tier via `pg_net`, not the reverse |
| `pg_net` HTTP call from cron to Edge Function | Database / Storage (initiator) | API / Backend (receiver) | `pg_net` is a Postgres extension; it originates the HTTP request from the DB tier into the Edge Function |
| Supabase Queue (`pgmq`) | Database / Storage | API / Backend (producer/consumer) | Queue tables live in Postgres; Edge Functions are producers (enqueue) and consumers (worker), but message durability/ordering is owned by the DB tier |
| Worker Edge Function (dequeue + process) | API / Backend | Database / Storage (reads/writes queue) | Processing logic and idempotency belong to the API tier; the queue state it reads/writes is DB-tier |
| CI smoke test (`SELECT 1`, prod-shape connection) | Database / Storage (validates) | API / Backend (executes, same code path) | Validates the connection contract before feature code depends on it — must run through the same driver/pooler config the app uses, not a substitute |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|---------------|
| Deno | Bundled with Supabase Edge Functions runtime (no separate install for deployed functions; Supabase CLI bundles a matching local runtime) | Edge Function runtime | Only runtime Supabase Edge Functions support today — no native Python/Node runtime option [CITED: supabase.com/docs/guides/functions] |
| Supabase CLI | `2.110.0` (npm `supabase` package, latest as of this research) | Local dev, `functions deploy`, `functions serve`, migrations, secrets | [VERIFIED: npm registry — `npm view supabase version`] |
| TypeScript | Deno's built-in TS support (no separate compiler step needed) | Edge Function source language | Locked by D-01; Deno type-checks/transpiles TS natively |
| `postgres` (postgres.js, imported as `npm:postgres` in Edge Function code) | `3.4.9` (latest) | Postgres client for Edge Functions | Actively maintained (12.9M weekly downloads), works with Deno's `npm:` specifier support, and is Supabase's example driver for Drizzle-based raw-SQL access. **Must be constructed with `{ prepare: false }`** when connecting via the Transaction Pooler (see Pitfall 1) [VERIFIED: npm registry] [CITED: supabase.com/docs/guides/functions/connect-to-postgres] |
| `@supabase/supabase-js` | `2.111.0` (latest) | Auth-aware client for calling `pgmq_public` RPC wrappers (queue send/pop/archive/delete) and any PostgREST-fronted table access | Official first-class client; required to use the `pgmq_public` schema's safe RPC wrappers instead of raw SQL for queue operations from Edge Functions [VERIFIED: npm registry] [CITED: supabase.com/docs/guides/queues/quickstart] |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| Hono | `4.12.32` (latest) | Lightweight routing framework for combining multiple logical endpoints (e.g., health + internal routes) into one deployed Edge Function to reduce cold starts | Optional for Phase 1 (a single `health` function needs no router); worth adopting once Phase 3/4 add more Edge Function routes, to combine them and reduce cold-start count [VERIFIED: npm registry] [CITED: hono.dev/docs/getting-started/supabase-functions] |
| `pg_cron` (Postgres extension) | Bundled with Supabase Postgres, enabled per-project | Cron scheduling inside Postgres | Enable via Dashboard → Database → Extensions, or `create extension pg_cron;` [CITED: supabase.com/docs/guides/functions/schedule-functions] |
| `pg_net` (Postgres extension) | Bundled with Supabase Postgres, enabled per-project | Async HTTP calls from SQL (used by `pg_cron` jobs to invoke Edge Functions) | Enable alongside `pg_cron`; required for the `net.http_post()` call in the cron job body [CITED: supabase.com/docs/guides/functions/schedule-functions] |
| `pgmq` (Postgres extension) | Available on Postgres 15.6.1.143+ (current Supabase-managed Postgres versions satisfy this) | Message queue backing Supabase Queues | Enable via Dashboard → Integrations → Queues, or `create extension pgmq;` [CITED: supabase.com/docs/guides/queues/quickstart] |
| Supabase Vault | Built into Supabase Postgres | Store the project URL/API key used by the `pg_cron` → `pg_net` → Edge Function call, instead of hardcoding secrets in SQL | Required by Pattern 3 below — never inline credentials in a `cron.schedule()` body [CITED: supabase.com/docs/guides/functions/schedule-functions] |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Transaction Pooler (6543) for Edge Functions | Session Pooler (5432) | Session Pooler is what the *old* Python/Render research recommended, for a different reason (Render ran one persistent process). Edge Functions are short-lived/serverless — Supabase's own docs explicitly recommend Transaction Pooler for this workload shape. Using Session Pooler here would work but goes against the documented fit and risks exhausting the pooler's combined 30-connection cap faster under concurrent Edge Function invocations. |
| `postgres.js` (`npm:postgres`) | Deno Postgres driver (`https://deno.land/x/postgres`) | Deno Postgres still appears in some official examples, but `postgres.js` is more actively maintained, has an `npm:` specifier (fits Deno's Node-compat direction per Supabase's own "Node and native npm compatibility" blog post), and has explicit, well-documented `prepare: false` guidance for pooled connections. |
| `@supabase/supabase-js` for queue operations | Raw SQL via `postgres.js` directly against `pgmq.*` functions | Raw SQL works and is simpler for Phase 1's proof-of-concept, but bypasses RLS/grants Supabase Queues expects you to configure via `pgmq_public`; using `supabase-js` + `pgmq_public` RPCs is the documented, access-controlled path and is what later phases (with real tenant-scoped data) will need anyway. |
| Supabase CLI native SQL migrations | A JS/TS migration framework (e.g., `node-pg-migrate`, Drizzle Kit migrations) | The CLI's native workflow (`supabase migration new`/`db push`) requires zero extra dependencies, is what `01-CONTEXT.md`'s discretion note flags as "most natural fit," and keeps migration authoring in plain SQL — appropriate since this project has no ORM in this runtime (no SQLAlchemy equivalent is being introduced). Drizzle Kit becomes worth reconsidering only if the project later adopts Drizzle as a query builder across Edge Functions. |

**Installation:**
```bash
# One-time: Supabase CLI (dev machine / CI)
npm install -g supabase   # or: scoop install supabase (Windows), brew install supabase/tap/supabase

# Per-function dependencies are declared in each function's deno.json / import statements,
# not a single project-wide package.json — Deno resolves npm: specifiers directly.
# Example supabase/functions/health/deno.json:
#   { "imports": { "postgres": "npm:postgres@3.4.9" } }
```

**Version verification:** `npm view supabase version` → `2.110.0`; `npm view postgres version` → `3.4.9`; `npm view @supabase/supabase-js version` → `2.111.0`; `npm view hono version` → `4.12.32`. All confirmed against the npm registry on 2026-07-28.

## Package Legitimacy Audit

| Package | Registry | Age/History | Downloads | Source Repo | Verdict (raw) | Disposition |
|---------|----------|--------------|-----------|--------------|---------|-------------|
| `postgres` | npm | established (porsager/postgres, long history) | 12,994,026/wk | github.com/porsager/postgres | OK | **Approved** |
| `supabase` (CLI) | npm | frequent releases (official CLI) | 2,666,467/wk | github.com/supabase/cli | SUS (too-new) | **Approved** — false positive; "too-new" reflects a routine point-release timestamp, not package age. High download count and official `supabase/cli` repo confirm legitimacy. |
| `hono` | npm | frequent releases (active framework) | 52,732,254/wk | github.com/honojs/hono | SUS (too-new) | **Approved** — same false-positive pattern; extremely high download count. |
| `@supabase/supabase-js` | npm | frequent releases (official SDK) | 22,226,817/wk | github.com/supabase/supabase-js | SUS (too-new) | **Approved** — same false-positive pattern; official Supabase org repo. |

**Packages removed due to `[SLOP]` verdict:** none.
**Packages flagged as genuinely suspicious `[SUS]`:** none. All three raw `SUS` verdicts above stem from the legitimacy seam's `publishedAt`-based "too-new" heuristic reacting to a *recent point release* (all four packages ship frequently), not package novelty — each is cross-verified via extremely high weekly download counts (millions to tens of millions) and a source repo matching the well-known official project. The planner does **not** need `checkpoint:human-verify` gates before these installs.

*Note: package names above were discovered via WebSearch/training knowledge before registry verification, per the provenance rule — they are tagged `[VERIFIED: npm registry]` only where both the registry check and an authoritative source (Supabase's own docs, in each case) agree; see inline tags in Standard Stack.*

## Architecture Patterns

### System Architecture Diagram (Phase 1 scope)

```
┌───────────────────────────────────────────────────────────────────┐
│  GitHub repo                                                        │
│                                                                       │
│  supabase/functions/health/index.ts                                 │
│  supabase/functions/sync-enqueue/index.ts   (proves the pattern;    │
│  supabase/functions/sync-worker/index.ts     real sync = Phase 3)   │
│  supabase/migrations/<timestamp>_*.sql                              │
│                                                                       │
│  .github/workflows/ci.yml                                           │
│    on: push/PR                                                      │
│    → checkout → setup-cli (supabase/setup-cli@v1)                   │
│    → lint/typecheck → smoke test:                                   │
│        connect via DATABASE_URL secret (Transaction Pooler,         │
│        prepare:false, same postgres.js client as prod)              │
│        → SELECT 1 → pass/fail                                       │
│    → on main: supabase link + supabase db push (deploy migrations)  │
│    → supabase functions deploy (deploy Edge Functions)              │
└───────────────────────────┬───────────────────────────────────────────┘
                              │ deploy
                              ▼
┌───────────────────────────────────────────────────────────────────┐
│  Supabase project                                                   │
│                                                                       │
│  Edge Functions (Deno, public URL per function):                    │
│    GET /functions/v1/health          verify_jwt=false, public       │
│    POST /functions/v1/sync-enqueue   invoked by pg_cron via pg_net  │
│    POST /functions/v1/sync-worker    invoked to drain the queue     │
│                                                                       │
│  Postgres (Supavisor pooler):                                       │
│    Transaction Pooler, port 6543, postgres.<project-ref> user       │
│    pg_cron  → schedules the sync-enqueue call                       │
│    pg_net   → performs the http_post from inside Postgres           │
│    pgmq     → queue tables (pgmq.q_sync, pgmq.a_sync)               │
│    Supabase Vault → stores project URL + API key used by pg_net     │
│                                                                       │
│  Flow: pg_cron (schedule) ──▶ pg_net.http_post ──▶ sync-enqueue      │
│         sync-enqueue ──▶ pgmq.send() ──▶ pgmq.q_sync                │
│         sync-worker ──▶ pgmq.read()/pop() ──▶ process ──▶            │
│                          pgmq.archive()/delete()                    │
└───────────────────────────────────────────────────────────────────┘
```

### Recommended Project Structure (Phase 1 subset)

```
supabase/
├── config.toml                    # [functions.health] verify_jwt = false, etc.
├── functions/
│   ├── _shared/
│   │   └── db.ts                  # single Postgres client factory (Transaction Pooler, prepare:false)
│   ├── health/
│   │   ├── deno.json              # npm:postgres import map
│   │   └── index.ts               # GET /health -> {status:"ok"} (+ optional SELECT 1)
│   ├── sync-enqueue/
│   │   └── index.ts               # invoked by pg_cron; pushes work items to pgmq queue
│   └── sync-worker/
│       └── index.ts               # dequeues one item, processes, archives/deletes
├── migrations/
│   └── <timestamp>_init.sql       # extensions (pg_cron, pg_net, pgmq), queue creation, cron.schedule
└── seed.sql                        # optional local-dev seed data

.github/
└── workflows/
    └── ci.yml                      # lint + smoke test (SELECT 1) + deploy on main
```

### Pattern 1: Single shared Postgres client factory, Transaction Pooler, never reconstructed

**What:** One module (`supabase/functions/_shared/db.ts`) that reads `DATABASE_URL` (or `SUPABASE_DB_URL`, Supabase's own default secret name) as a single environment variable, and constructs the `postgres.js` client from it directly — never splitting into host/user/password.
**When to use:** Imported by every Edge Function that touches Postgres directly (health check's optional DB ping, sync-worker if it needs raw SQL beyond `pgmq_public`).
**Why this matters here specifically:** This is the direct analog of the fix pattern that resolved the prior project's incident (`55b0f80`), re-verified for the new runtime: the target pooler is different (Transaction, not Session) and the target client is different (`postgres.js`, not psycopg), but the discipline — copy the platform-provided connection string whole, never rebuild it from parts, never assume a bare `postgres` username — is identical.

**Example:**
```typescript
// supabase/functions/_shared/db.ts
import postgres from "npm:postgres@3.4.9";

// Supabase injects SUPABASE_DB_URL by default; if a custom DATABASE_URL secret
// is preferred instead, set it explicitly via `supabase secrets set` — either way,
// treat the value as an opaque, complete connection string. Never construct it
// from separate DB_HOST/DB_USER/DB_PASSWORD secrets.
const connectionString = Deno.env.get("DATABASE_URL") ?? Deno.env.get("SUPABASE_DB_URL")!;

// prepare: false is REQUIRED for the Transaction Pooler (port 6543) — prepared
// statements are tied to a single backend connection, and transaction mode
// swaps connections between statements, which breaks prepared-statement caching.
export const sql = postgres(connectionString, { prepare: false });
```

### Pattern 2: Health-check Edge Function, public and unauthenticated

**What:** A minimal Deno Edge Function returning `{status: "ok"}`, with `verify_jwt = false` set for this specific function in `supabase/config.toml` so it is reachable without a Supabase Auth JWT.
**When to use:** Satisfies success criterion 1 directly. Also serves as the health target for any later external uptime checker.
**Why `verify_jwt = false` matters:** By default, every Edge Function requires a valid Authorization JWT at the gateway level before your code even runs. An uptime pinger or the Cron pipeline's own health verification would otherwise get a 401 before reaching your handler.

**Example:**
```typescript
// supabase/functions/health/index.ts
import { sql } from "../_shared/db.ts";

Deno.serve(async (_req) => {
  try {
    await sql`select 1`;
    return new Response(JSON.stringify({ status: "ok" }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("health check DB ping failed", err);
    return new Response(JSON.stringify({ status: "error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
```
```toml
# supabase/config.toml
[functions.health]
verify_jwt = false
```

### Pattern 3: pg_cron + pg_net → enqueue Edge Function, credentials via Vault

**What:** A SQL migration that enables `pg_cron`/`pg_net`, stores the project URL and API key in Supabase Vault, and schedules a job that calls the `sync-enqueue` Edge Function.
**When to use:** Satisfies success criterion 4's trigger half. Vault avoids ever putting a live secret in a committed migration file.

**Example:**
```sql
-- supabase/migrations/<timestamp>_cron_sync_trigger.sql
create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists pgmq;

select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
select vault.create_secret('<service-or-anon-key>', 'edge_function_key');

select cron.schedule(
  'sync-enqueue-trigger',
  '*/15 * * * *',  -- every 15 min; tune within the 15-30 min SYNC-02 range in later phases
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/sync-enqueue',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'edge_function_key')
    ),
    body := '{}'::jsonb
  ) as request_id;
  $$
);
```

### Pattern 4: pgmq queue — create, enqueue, worker dequeue with visibility timeout

**What:** A queue created via `pgmq.create()`, populated from the enqueue function, drained by the worker function using `pgmq_public` RPCs (or raw `pgmq.read`/`pgmq.archive` SQL).
**When to use:** Satisfies success criterion 4's queue half. This is intentionally minimal for Phase 1 (prove the mechanism) — real per-page product-sync chunking is Phase 3 scope.

**Example:**
```sql
-- part of the same migration, after enabling pgmq
select pgmq.create('sync_work');
```
```typescript
// supabase/functions/sync-enqueue/index.ts
import { createClient } from "npm:@supabase/supabase-js@2.111.0";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, // service role: enqueue is a trusted, internal caller
);

Deno.serve(async (_req) => {
  // Phase 1: a single placeholder work item, proving cron -> enqueue -> queue -> worker.
  // Phase 3 replaces this with real per-page product-sync chunking.
  const { error } = await supabase.schema("pgmq_public").rpc("send", {
    queue_name: "sync_work",
    message: { kind: "ping", enqueued_at: new Date().toISOString() },
  });
  if (error) {
    console.error("enqueue failed", error);
    return new Response("enqueue failed", { status: 500 });
  }
  return new Response("enqueued", { status: 200 });
});
```
```typescript
// supabase/functions/sync-worker/index.ts
import { createClient } from "npm:@supabase/supabase-js@2.111.0";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

Deno.serve(async (_req) => {
  const { data, error } = await supabase.schema("pgmq_public").rpc("pop", {
    queue_name: "sync_work",
  });
  if (error) {
    console.error("dequeue failed", error);
    return new Response("dequeue failed", { status: 500 });
  }
  if (!data || data.length === 0) {
    return new Response("queue empty", { status: 200 });
  }
  // Phase 1: log and acknowledge. Phase 3 adds real processing + idempotency +
  // explicit archive-on-success / requeue-on-failure logic (pop already deletes
  // on read here — swap to read()+archive() if at-least-once + audit trail is needed).
  console.log("processed message", data[0]);
  return new Response("processed", { status: 200 });
});
```
`pgmq_public.pop` reads-and-deletes atomically (at-most-once). If the phase's success criterion needs to demonstrate retry-on-failure behavior, use `pgmq_public.read` (visibility timeout, message stays until explicitly archived/deleted) instead of `pop` — document which semantic Phase 1's proof-of-concept uses, since Phase 3's real sync worker will need to choose deliberately between them for idempotent processing (`SYNC-01`).

### Anti-Patterns to Avoid

- **Using the Session Pooler (5432) for Edge Functions "because that's what the old research said":** the old research's port choice was correct for Render's persistent process, not for serverless Edge Functions — re-verify per runtime, don't copy the conclusion across the pivot.
- **Omitting `{ prepare: false }` on the `postgres.js` client:** will intermittently fail under concurrent invocations once the Transaction Pooler swaps backend connections mid-session — the direct analog of the asyncpg/pooler bug class from the prior incident.
- **Reconstructing `DATABASE_URL`/`SUPABASE_DB_URL` from separate host/user/password secrets:** the exact bug class that caused commit `55b0f80`'s incident — always use the whole platform-provided string.
- **Hardcoding the Edge Function's URL or API key directly in a `cron.schedule()` SQL body:** commits a live secret into a migration file tracked in git; use Supabase Vault.
- **CI smoke test via a generic `postgres:` service container:** validates generic Postgres connectivity, not this phase's actual risk (pooler mode + prepared-statement config + driver behavior) — must hit the real Supabase project through the same client code.
- **Leaving `verify_jwt` at its default (`true`) on the health-check function:** breaks the "responds at its public URL" success criterion for any unauthenticated caller (uptime checker, curl, browser).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|---------------|-----|
| Job scheduling inside Postgres | A custom polling loop or external scheduler service to trigger periodic work | `pg_cron` (already bundled, enable via extension) | Native, zero additional infrastructure, exactly matches D-04's decision |
| Reliable work queue with retry/visibility semantics | A custom `processed boolean` column + manual polling table (the pattern shown in some blog posts, e.g. the "processing large jobs" blog's simplified example) | `pgmq` (Supabase Queues) — `pgmq.read`/`pgmq.archive` gives visibility-timeout-based redelivery for free | D-03 explicitly calls for the documented `pgmq`-based Queues feature, not an ad-hoc table; a hand-rolled `processed` flag column has no visibility timeout, so a crashed worker mid-processing loses the item silently instead of it becoming re-claimable |
| Async HTTP calls from inside Postgres (cron → Edge Function) | A custom `http` extension wrapper or shelling out | `pg_net` (already bundled, enable via extension) | Purpose-built, non-blocking, integrates directly with `cron.schedule()` bodies |
| Postgres connection pooling logic | Custom connection-reuse/retry logic in each Edge Function | Supavisor's Transaction Pooler (managed by Supabase) + `postgres.js`'s own internal pool | Supabase already runs and manages Supavisor; re-implementing pooling in application code duplicates infrastructure Supabase provides and is easy to get subtly wrong (this entire phase exists because getting *pooler usage* wrong, not pooling itself, caused the prior incident) |

**Key insight:** Every Phase 1 "don't hand-roll" item traces back to the same principle as `01-CONTEXT.md`'s Pattern rationale: Supabase ships a documented reference architecture (Cron + Queue + Edge Function) for exactly this constraint set (short CPU budget, no persistent process, chunked work). Building a custom equivalent — even a simple one — reintroduces failure modes (lost-on-crash work items, no backpressure, no visibility timeout) that the platform feature already solved.

## Runtime State Inventory

Not applicable — this is a greenfield phase (per `01-CONTEXT.md`'s `<code_context>`: "no code exists yet in this repository"). No rename/refactor/migration of existing runtime state is involved. Explicitly verified: no prior Supabase project, no prior deployed Edge Functions, no prior CI secrets to migrate — this phase creates all of it fresh.

## Common Pitfalls

### Pitfall 1: Copying the Session Pooler recommendation from the old (Python/Render) research
**What goes wrong:** Someone re-reads the superseded `STACK.md`/old `01-RESEARCH.md` guidance ("Session Pooler, port 5432") and applies it unchanged to the new Deno/Edge-Function runtime.
**Why it happens:** The old research is thorough, HIGH-confidence, and specifically about this exact bug class — it's tempting to treat its pooler-mode conclusion as still valid.
**How to avoid:** The pooler mode depends on the *workload shape* (persistent process vs. serverless), which changed with the pivot. Edge Functions are serverless/short-lived → **Transaction Pooler (6543)**, not Session Pooler (5432).
**Warning signs:** A connection string using port `5432` anywhere in Edge Function code or secrets.

### Pitfall 2: Missing `{ prepare: false }` on the postgres.js client
**What goes wrong:** Prepared-statement errors appear intermittently, worse under concurrent Edge Function invocations, because the Transaction Pooler can swap the underlying backend connection between statements within what the client thinks is one session.
**Why it happens:** `postgres.js` prepares statements by default for performance; this default is safe on a direct connection or Session Pooler, but not on Transaction Pooler.
**How to avoid:** Always construct the client as `postgres(connectionString, { prepare: false })` when the connection string points at port 6543.
**Warning signs:** Errors mentioning "prepared statement ... does not exist" or similar, especially appearing only under load/concurrency, not in simple manual tests.

### Pitfall 3: Default `verify_jwt = true` silently blocking the health-check success criterion
**What goes wrong:** The health-check function deploys successfully and returns 200 when tested with a valid Supabase key (e.g., from the dashboard's "Test" button), but returns 401 to a plain unauthenticated `curl`/uptime-checker request — the actual shape of "responds at its public URL."
**Why it happens:** Supabase's Edge Functions gateway enforces JWT verification by default for every function, and dashboard testing tools often inject a valid key automatically, masking the problem during manual spot-checks.
**How to avoid:** Set `verify_jwt = false` explicitly for the health function in `supabase/config.toml`, and verify success criterion 1 with a request that carries **no** Authorization header at all (e.g., `curl -i https://<ref>.supabase.co/functions/v1/health` with no `-H "Authorization: ..."`).
**Warning signs:** 401 responses from a bare `curl` request to the deployed function URL.

### Pitfall 4: Hardcoding the Edge Function URL/API key in a committed migration's `cron.schedule()` body
**What goes wrong:** A live service-role or publishable key ends up readable in the git history of a migration file.
**Why it happens:** It's the fastest way to get the cron job working during initial testing, and easy to forget to swap for Vault before committing.
**How to avoid:** Use `vault.create_secret()` once (can be run manually via the SQL editor or a one-off migration that only runs if the secret doesn't already exist) and reference `vault.decrypted_secrets` in the `cron.schedule()` body instead of literal values.
**Warning signs:** Any `net.http_post` call in a migration file with a literal `https://` URL or a literal API key string instead of a `vault.decrypted_secrets` lookup.

### Pitfall 5: CI smoke test validating the wrong thing
**What goes wrong:** A GitHub Actions `postgres:` service container is used for the "SELECT 1" smoke test because it's the standard tutorial pattern — CI stays green even if the real Supabase Transaction Pooler connection (wrong port, missing `prepare:false`, malformed connection string) is broken.
**Why it happens:** It's the default, well-documented CI Postgres pattern and looks correct at a glance; no single canonical "test the real Supabase pooler in CI" example was found during this research (see Assumptions Log A2).
**How to avoid:** The smoke test must import the *same* `_shared/db.ts` client factory the Edge Functions use, and connect using a `DATABASE_URL`/`SUPABASE_DB_URL` **repository secret** holding the real project's Transaction Pooler string — not a local/service-container substitute.
**Warning signs:** CI is green but the deployed function 500s on its first real DB query.

### Pitfall 6: Confusing `pgmq_public.pop` (delete-on-read) with `pgmq_public.read`/`read` semantics (visibility timeout, requires explicit archive/delete)
**What goes wrong:** Using `pop` (which deletes immediately) for a worker that's meant to demonstrate crash-safe redelivery, or conversely using `read` without ever calling `archive`/`delete`, leaving messages piling up as "invisible-then-visible-again" indefinitely once the visibility timeout elapses.
**Why it happens:** Both are valid, documented pgmq operations with genuinely different semantics, and the difference is easy to gloss over when following a quickstart.
**How to avoid:** Decide deliberately per Pattern 4's note — for Phase 1's proof-of-concept, either is acceptable, but document the choice, since Phase 3's real sync worker needs `read` + explicit `archive`-on-success (or `delete`) to get true at-least-once, crash-safe processing for `SYNC-01`'s idempotency requirement.
**Warning signs:** Messages that never get archived accumulating in `pgmq.q_sync` indefinitely, or a worker that "processes" the same message twice under retry with `pop`-based logic (impossible if using `pop` correctly, since `pop` deletes on read — but easy to design incorrectly if mixing the two).

## Code Examples

Additional pattern beyond those embedded in Architecture Patterns above:

### GitHub Actions CI — smoke test + deploy
```yaml
# .github/workflows/ci.yml
name: CI
on: [push, pull_request]

jobs:
  smoke-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: denoland/setup-deno@v2
        with:
          deno-version: v2.x
      - name: DB connectivity smoke test (real Supabase Transaction Pooler)
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
        run: |
          deno run --allow-net --allow-env - <<'EOF'
          import postgres from "npm:postgres@3.4.9";
          const sql = postgres(Deno.env.get("DATABASE_URL")!, { prepare: false });
          const result = await sql`select 1 as ok`;
          if (result[0].ok !== 1) throw new Error("smoke test failed");
          console.log("SELECT 1 OK via production-shape connection");
          await sql.end();
          EOF

  deploy:
    needs: smoke-test
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: supabase/setup-cli@v1
        with:
          version: latest
      - run: supabase link --project-ref ${{ secrets.SUPABASE_PROJECT_ID }}
        env:
          SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
      - run: supabase db push
        env:
          SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
          SUPABASE_DB_PASSWORD: ${{ secrets.SUPABASE_DB_PASSWORD }}
      - run: supabase functions deploy
        env:
          SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
```
The `DATABASE_URL` secret must be the project's **Transaction Pooler** connection string (port 6543), copied whole from the Supabase dashboard's "Connect" panel — never assembled from separate secrets. [ASSUMED: this exact workflow shape — no single canonical "Supabase + SELECT 1 + GitHub Actions" example was found verbatim this session; synthesized from Supabase's own documented CI/CD migration-deploy pattern plus the project's own connection-testing requirement. Verify by running it once before considering success criterion 3 done.]

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|-------------------|-----------------|--------|
| Session Mode available on port 6543 | Port 6543 is Transaction-Mode-only; Session Mode is 5432-only | Feb 28, 2025 (Supabase changelog, carried forward from prior research — still current) | Any tutorial referencing "session mode on 6543" predates this and is wrong for both the old and new architecture |
| Backend hosted on Render (separate process from Supabase) | Backend hosted as Supabase Edge Functions (same platform as DB/Auth) | This project, `01-CONTEXT.md` D-01/D-02, 2026-07-28 | Removes the free-tier-sleep/cold-start problem this phase's old research spent significant effort mitigating (`cron-job.org` keep-alive, `render.yaml`) — that entire mitigation category no longer applies |
| asyncpg / psycopg3 driver choice debate (Python) | `postgres.js` (`npm:postgres`) is the practical default for raw SQL from Deno Edge Functions | Pivot-driven, this research | The specific driver-vs-pooler compatibility research must be redone per runtime — the *conclusion* ("use the driver/pooler combo the platform docs recommend for your actual runtime, verify prepared-statement behavior explicitly") carries forward, the specific library names do not |

**Deprecated/outdated:**
- Everything in the old `01-RESEARCH.md` referencing `render.yaml`, Alembic, psycopg3, APScheduler, or `cron-job.org` keep-alive pinging — all superseded by the pivot, not applicable to this architecture.
- Session Mode on port 6543 — deprecated Feb 2025, unrelated to this pivot but still worth flagging since it recurs in older search results.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|-----------------|
| A1 | `postgres.js` (`npm:postgres`) with `{ prepare: false }` against the Transaction Pooler is the correct, safe combination for Edge Functions, fully analogous to the prior project's psycopg3/Session-Pooler fix | Standard Stack, Pattern 1, Pitfall 1-2 | MEDIUM — this is the single most important claim in this document; if wrong, this phase re-creates the exact class of production incident it exists to prevent. Mitigation: this claim is cross-corroborated by two independent official Supabase sources (connect-to-postgres guide's "use Transaction pooler for serverless/edge" + Supavisor troubleshooting docs' `prepare: false` guidance), so confidence is MEDIUM not LOW — but must be proven with a real deployed Edge Function hitting the real pooler before considering success criterion 3 done, not just trusted from docs. |
| A2 | The exact GitHub Actions "SELECT 1 via real Supabase connection" workflow shape (Code Examples section) is a reasonable, working pattern | Code Examples | LOW-MEDIUM — no single canonical example was found verbatim; the workflow is synthesized from documented pieces (Supabase's own migration-deploy CI pattern + a plain `deno run` script using the same client). If the exact YAML syntax has an error, CI will fail loudly and immediately (not silently pass), which limits the downside — but budget time to debug the exact `deno run --allow-net --allow-env` invocation syntax at implementation time. |
| A3 | `pgmq` has no separate free-tier quota beyond the project's overall Postgres database size limit (500MB) | Standard Stack (Supporting), Environment/limits research | LOW — if wrong (e.g., a message-count cap exists), the failure mode is hitting an unexpected quota during Phase 3's real sync volume, not during this phase's minimal proof-of-concept (a handful of test messages) |
| A4 | `pgmq_public.pop` deletes-on-read (at-most-once) while `pgmq_public.read`/`archive` gives visibility-timeout-based at-least-once semantics, and Phase 1 may use either for its proof-of-concept | Pattern 4, Pitfall 6 | LOW for Phase 1 (either choice satisfies "prove the pipeline works"); MEDIUM for Phase 3, which must choose `read`+`archive` deliberately for `SYNC-01`'s idempotency requirement — flag this choice explicitly in the Phase 1 plan so Phase 3 doesn't inherit an accidental `pop`-based pattern that doesn't fit its needs |

**If this table is empty:** N/A — see entries above.

## Open Questions

1. **Exact `deno run` invocation flags and script-embedding syntax for the CI smoke test**
   - What we know: `deno run --allow-net --allow-env <script>` is the general shape needed to run a small script that imports `npm:postgres` and hits the network.
   - What's unclear: Whether embedding the script inline via a heredoc in the GitHub Actions YAML (as shown in Code Examples) is the cleanest approach vs. committing a small standalone `scripts/smoke-test-db.ts` file to the repo and just calling `deno run --allow-net --allow-env scripts/smoke-test-db.ts`.
   - Recommendation: Prefer a committed standalone script file — easier to test locally (`deno run --allow-net --allow-env scripts/smoke-test-db.ts` with a local `.env`) before trusting it in CI, and avoids YAML heredoc quoting pitfalls.

2. **Whether the health-check function's optional `SELECT 1` DB ping is worth including, given it adds a DB round-trip (and therefore pooler/connection risk) to every health check**
   - What we know: Success criterion 1 only requires "responds to a health-check request" — it does not explicitly require the health check to prove DB connectivity.
   - What's unclear: Whether combining the health check with a DB ping (Pattern 2's example) is the better design, vs. keeping `/health` DB-free and letting the separate CI smoke test (success criterion 3) be the sole DB-connectivity proof.
   - Recommendation: Keep the DB ping in `/health` — it doubles as a cheap production-environment connectivity signal distinct from CI (CI proves the connection works at deploy time; the health check's DB ping proves it keeps working in the live environment), and the extra round-trip is negligible against the 2s CPU cap for a single `select 1`.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|--------------|-------------|---------|-----------|
| Node.js | Running `npm view`/GSD tooling, not part of the deployed app | ✓ | v24.15.0 (per prior session data) | — |
| Supabase CLI | Local dev, `functions serve`, migrations, deploy | Not directly probed this session — must be installed (`npm install -g supabase`) before implementation | `2.110.0` (latest on npm) | Install via npm globally, or Scoop (Windows) per Supabase's own install docs |
| Docker | `supabase functions serve` / `supabase start` for local dev stack | Not probed this session (prior phase research on this machine found Docker absent) | — | Supabase CLI's local dev stack requires Docker; if genuinely unavailable, develop directly against a real (free) Supabase project's hosted Edge Functions + `supabase db push` for migrations, skipping the local emulation loop — slower iteration but functionally complete for this phase's scope |
| Deno | Local testing of Edge Function code outside `supabase functions serve` (e.g., the CI smoke-test script) | Not probed this session | — | Install via `denoland/setup-deno` action in CI; for local dev, the Supabase CLI bundles a compatible Deno runtime for `functions serve`, so a separate Deno install is optional unless running scripts directly with `deno run` |
| git | Version control | ✓ (confirmed in prior phase research on this machine) | 2.49.0 | — |

**Missing dependencies with no fallback:**
- None identified — every dependency above has a documented installation path or a slower-but-workable fallback.

**Missing dependencies with fallback:**
- Docker (optional, only needed for fully local Edge Function emulation — can develop against the real hosted Supabase project instead).

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Deno's built-in test runner (`Deno.test`, `deno test`) — no separate test framework needed; Deno ships one natively, fitting D-01's runtime choice |
| Config file | none yet — `deno.json` per function (or a shared root `deno.json`) can set `"tasks": {"test": "deno test --allow-net --allow-env"}` in Wave 0 |
| Quick run command | `deno test --allow-net --allow-env supabase/functions/health` |
| Full suite command | `deno test --allow-net --allow-env supabase/functions/` |

### Phase Requirements → Test Map

Phase 1 has no formal `REQ-XX` IDs (per `REQUIREMENTS.md`'s traceability table — this phase carries zero direct requirement mappings by design, per `STATE.md`). Mapping instead to this phase's four `ROADMAP.md` success criteria:

| Success Criterion | Behavior | Test Type | Automated Command | File Exists? |
|--------------------|-----------|-----------|----------------------|---------------|
| SC-1: Edge Function responds at public health-check URL | `GET /functions/v1/health` returns 200, no auth required | integration (manual post-deploy curl + local `functions serve` check) | `curl -i https://<ref>.supabase.co/functions/v1/health` (no Authorization header) | N/A — manual/curl-based, not a Deno test |
| SC-2: Migrations run locally and in production | `supabase migration up` (local) and `supabase db push` (production) both succeed | manual (CLI command, run once each) | `supabase migration up` / `supabase db push` | N/A — CLI commands, not automated tests |
| SC-3: CI smoke test runs `SELECT 1` via prod-shape connection | `select 1` succeeds through the real Transaction Pooler + `prepare:false` client | integration, automated in CI | the `deno run` smoke-test script in `.github/workflows/ci.yml` (see Code Examples) | ❌ Wave 0 |
| SC-4: Cron + Queue + worker pipeline works end-to-end | `pg_cron` fires → `sync-enqueue` runs → message lands in `pgmq.q_sync` → `sync-worker` dequeues it | manual (check `pgmq.q_sync`/`pgmq.a_sync` tables and function logs after the scheduled interval elapses) + a direct manual invocation test (`supabase functions invoke sync-enqueue` then `sync-worker`) for fast iteration without waiting for the cron interval | `supabase functions invoke sync-enqueue --no-verify-jwt` then `supabase functions invoke sync-worker --no-verify-jwt`, followed by a SQL check `select * from pgmq.q_sync;` | N/A — CLI + SQL verification, not a Deno test |

### Sampling Rate
- **Per task commit:** the smoke-test script run locally (`deno run --allow-net --allow-env` against a dev Supabase project) before pushing.
- **Per wave merge:** full CI run (smoke test + `supabase db push` dry-run/lint if available).
- **Phase gate:** all four success criteria manually confirmed against the real deployed project (health URL curl, `supabase db push` succeeding, CI green, cron/queue pipeline observed firing at least once) before `/gsd-verify-work`.

### Wave 0 Gaps
- [ ] `supabase/config.toml` — created, with `[functions.health] verify_jwt = false`
- [ ] `.github/workflows/ci.yml` — created, covers SC-3 (smoke test) and the deploy steps for SC-2/SC-4
- [ ] `supabase/functions/_shared/db.ts` — shared Postgres client factory (Pattern 1)
- [ ] A dev/staging Supabase project (or documented decision to share the single free project) for CI's `DATABASE_URL` secret — same open question the old research flagged (A4 in the old file); still applies here, document the choice explicitly in the plan rather than leaving it implicit

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|-----------------|---------|---------------------|
| V2 Authentication | No | Not built until Phase 2 — Phase 1 has no user-facing auth surface |
| V3 Session Management | No | Same as above |
| V4 Access Control | Partial | The `health` function is intentionally public (`verify_jwt = false`); `sync-enqueue`/`sync-worker` should remain `verify_jwt`-protected (default) or gated by a shared secret in the `pg_net` call's Authorization header, since they are meant to be invoked only by the cron pipeline, not the public |
| V5 Input Validation | Minimal | Neither `health` nor the Phase 1 placeholder `sync-enqueue`/`sync-worker` take meaningful user input; revisit once Phase 3's real sync logic (processing Tiny ERP API responses) is built |
| V6 Cryptography | No | Fernet-equivalent token encryption is a Phase 3 concern (Tiny OAuth tokens); nothing to encrypt in Phase 1 |
| V9 Communications Security | Yes | Supabase terminates TLS automatically for `*.supabase.co` Edge Function URLs and the Postgres pooler connection; confirm the connection string always uses `sslmode=require` (default for Supabase-provided strings) and never falls back to plaintext |
| V14 Configuration | Yes | `DATABASE_URL`/`SUPABASE_DB_URL` and the cron pipeline's project URL/API key must live in Supabase secrets (`supabase secrets set`) and Supabase Vault respectively — never committed to git, never logged in plaintext (watch for `console.log`ing the connection string or a raw error object that embeds it) |

### Known Threat Patterns for this stack (Phase 1 scope)

| Pattern | STRIDE | Standard Mitigation |
|----------|--------|------------------------|
| Credential leakage via connection-string logging | Information Disclosure | Never log the raw `DATABASE_URL`/`SUPABASE_DB_URL` (embeds the DB password); if logging connection info for debugging, redact the credential portion |
| Unauthenticated invocation of internal pipeline functions (`sync-enqueue`, `sync-worker`) | Spoofing / Elevation of Privilege | Keep `verify_jwt` enabled (default) on these functions, or add a shared-secret header check comparing against a value stored in Vault/secrets, so only the `pg_cron`/`pg_net` caller (or an authorized manual invocation) can trigger them |
| Secrets committed in migration SQL (`cron.schedule` body with a literal key) | Tampering / Information Disclosure | Always use `vault.create_secret()` + `vault.decrypted_secrets` lookups instead of literal values in migration files (Pattern 3, Pitfall 4) |
| Health-check endpoint information disclosure | Information Disclosure | Keep `/health`'s response minimal (`{"status": "ok"}` / `{"status": "error"}`) — never return stack traces or connection details on failure |

## Sources

### Primary (HIGH confidence)
- `npm view supabase/postgres/@supabase-supabase-js/hono version` — direct npm registry query, this session (2026-07-28) — HIGH, primary source for version numbers
- `gsd-tools query package-legitimacy check` — direct registry/signal check for `postgres`, `supabase`, `hono`, `@supabase/supabase-js`, this session — HIGH for existence/download-count/repo signals

### Secondary (MEDIUM confidence, official Supabase docs fetched/searched this session)
- Supabase Docs — Edge Functions overview, quickstart, deploy, secrets (`supabase.com/docs/guides/functions/*`) — web-search-summarized and partially web-fetched this session
- Supabase Docs — Integrating with Supabase Database from Edge Functions (`supabase.com/docs/guides/functions/connect-to-postgres`) — web-fetched this session
- Supabase Docs — Connect to your database, pooler modes/ports (`supabase.com/docs/guides/database/connecting-to-postgres`) — web-fetched this session
- Supabase Docs — Schedule Functions via pg_cron/pg_net (`supabase.com/docs/guides/functions/schedule-functions`) — web-fetched this session
- Supabase Docs — Queues quickstart, pgmq (`supabase.com/docs/guides/queues/quickstart`, `.../guides/queues/pgmq`) — web-fetched this session
- Supabase Docs — Edge Function limits (`supabase.com/docs/guides/functions/limits`) — web-fetched this session, confirms 500k invocations/mo, 256MB memory, 2s CPU, 150s free/400s paid background task duration (matches `01-CONTEXT.md`'s user-verified figures)
- Supabase Docs — Managing environments / CI-CD (`supabase.com/docs/guides/deployment/managing-environments`) — web-fetched this session
- Supabase blog — "Processing large jobs with Edge Functions, Cron, and Queues" (`supabase.com/blog/processing-large-jobs-with-edge-functions`) — web-fetched this session; note its own worked example uses a simplified custom table-based queue, not `pgmq` API calls directly — this research recommends the actual `pgmq`/`pgmq_public` API per D-03's explicit intent, not the blog's simplified variant
- Community/troubleshooting sources on `postgres.js` + Transaction Pooler `prepare: false` requirement — cross-referenced against Supabase's own Supavisor documentation pattern (same underlying prepared-statement/pooler mechanism as the psycopg2/asyncpg cases in the prior project's research)

### Tertiary (LOW confidence)
- The GitHub Actions "SELECT 1 smoke test" YAML in Code Examples — this research's own synthesis; no single canonical worked example located this session (see Assumption A2)
- Various third-party Supabase pricing-explainer blog posts (schematichq, designrevision, etc.) — used only to cross-check the free-tier numbers already found in official docs, not as a primary source

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — package versions verified directly against npm registry this session; pooler-mode/driver recommendation cross-corroborated across two independent official Supabase doc pages
- Architecture: MEDIUM — Cron/Queue/Edge-Function pattern is Supabase's own documented reference architecture (CITED), but the exact CI smoke-test workflow and the Phase 1 placeholder sync-enqueue/worker code are this research's own synthesis, not copied verbatim from a single authoritative source
- Pitfalls: MEDIUM-HIGH — Pitfalls 1-4 and 6 are grounded directly in official Supabase docs findings this session; Pitfall 5 (CI smoke test) is inference from the same reasoning the old research applied to the Python case, re-applied to this runtime

**Research date:** 2026-07-28
**Valid until:** ~30 days for Supabase platform mechanics and free-tier limits (these have changed before — e.g., the Feb 2025 pooler-port change — so treat as stable-ish, not permanent); re-verify the exact `postgres.js`/`prepare:false` requirement and pooler port assignment against live docs immediately before finalizing `_shared/db.ts`, since this is the single highest-consequence claim in this document (Assumption A1).
