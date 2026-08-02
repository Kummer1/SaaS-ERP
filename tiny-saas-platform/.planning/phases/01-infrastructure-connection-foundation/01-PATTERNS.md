# Phase 1: Infrastructure & Connection Foundation - Pattern Map

**Mapped:** 2026-07-28
**Files analyzed:** 8 (new/modified — no files modified, all new)
**Analogs found:** 0 / 8 (greenfield — no application code exists in this repository)

## Greenfield Confirmation

This repository has **no application source code yet**. Confirmed by direct filesystem listing:

```
tiny-saas-platform/
├── .claude/CLAUDE.md          (docs only — stale pre-pivot tech-stack table, see below)
├── .planning/                 (GSD planning artifacts: PROJECT.md, ROADMAP.md, STATE.md, research/)
└── docs/                      (architecture docs: 01-ARQUITETURA.md .. 05-ROADMAP.md)
    └── sql/rls_policies.example.sql   (the ONLY code-like artifact in the repo — a doc example, not runtime code)
```

`.planning/PROJECT.md` explicitly states no code has been written yet ("Nenhum código foi escrito ainda"). There is no `src/`, `supabase/`, `backend/`, `frontend/`, `app/`, or any `package.json`/`deno.json`/`requirements.txt` anywhere in the tree. **There are zero existing files that can serve as role/data-flow analogs for this phase's new files.** Do not fabricate analogs — every file below has "No analog — greenfield" and must be built from `01-RESEARCH.md`'s embedded code examples instead.

The one exception is `docs/sql/rls_policies.example.sql`, which is a **documentation-only SQL example** (not a migration, not runtime code) showing the RLS pattern later phases must follow. It's noted below as a convention reference, not a pattern-source analog, since Phase 1 itself creates no tenant-scoped tables (RLS application starts once `customers`/`products`/etc. tables exist, per that file's own comment).

## File Classification

| New File | Role | Data Flow | Closest Analog | Match Quality |
|----------|------|-----------|-----------------|----------------|
| `supabase/config.toml` | config | request-response | — | no analog (greenfield) |
| `supabase/functions/_shared/db.ts` | utility (client factory) | request-response | — | no analog (greenfield) |
| `supabase/functions/health/index.ts` | route (Edge Function handler) | request-response | — | no analog (greenfield) |
| `supabase/functions/sync-enqueue/index.ts` | controller (Edge Function handler) | event-driven / pub-sub (producer) | — | no analog (greenfield) |
| `supabase/functions/sync-worker/index.ts` | controller (Edge Function handler) | event-driven / pub-sub (consumer) | — | no analog (greenfield) |
| `supabase/migrations/<timestamp>_init.sql` | migration | batch (DDL) | — | no analog (greenfield); see `docs/sql/rls_policies.example.sql` for RLS *convention* reference (not runtime code, not this phase's scope to apply) |
| `.github/workflows/ci.yml` | config (CI pipeline) | batch | — | no analog (greenfield) |
| `scripts/smoke-test-db.ts` (recommended standalone file per RESEARCH.md Open Question 1) | test/utility | request-response | — | no analog (greenfield) |

All eight files are net-new; none modify existing code because none exists to modify.

## Pattern Assignments

Since no codebase analogs exist, every pattern below is sourced directly from `01-RESEARCH.md`'s **Architecture Patterns** section (which itself cites official Supabase docs, not invented). The planner should treat these as the primary reference in place of an analog file, and treat `docs/*.md` as the secondary constraint layer (data model, RLS, Tiny API facts — unaffected by the D-01/D-02 pivot).

### `supabase/functions/_shared/db.ts` (utility, request-response)

**Source:** `01-RESEARCH.md` Pattern 1 (no codebase analog — greenfield)

```typescript
import postgres from "npm:postgres@3.4.9";

const connectionString = Deno.env.get("DATABASE_URL") ?? Deno.env.get("SUPABASE_DB_URL")!;

// prepare: false is REQUIRED for the Transaction Pooler (port 6543)
export const sql = postgres(connectionString, { prepare: false });
```

**Critical constraint (from CLAUDE.md's "What NOT to Use" — still binding despite the stale stack table around it):** never reconstruct this connection string from separate host/user/password parts. Treat `DATABASE_URL`/`SUPABASE_DB_URL` as an opaque whole string copied from the Supabase dashboard. This is the direct lesson of prior-project incident commit `55b0f80`.

**Note the runtime-specific reversal vs. CLAUDE.md's stale guidance:** CLAUDE.md (pre-pivot, Python/Render) recommends the **Session Pooler (5432)**. For Deno Edge Functions (this phase's actual runtime per D-01/D-02), `01-RESEARCH.md` establishes the opposite: **Transaction Pooler (6543)** with `{ prepare: false }` on `postgres.js`. Do not follow CLAUDE.md's pooler-port table for this phase — it documents the superseded FastAPI/Render architecture.

---

### `supabase/functions/health/index.ts` (route, request-response)

**Source:** `01-RESEARCH.md` Pattern 2

```typescript
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

**Config companion** (`supabase/config.toml`):
```toml
[functions.health]
verify_jwt = false
```

**Error handling pattern:** try/catch around the single DB call; log server-side with `console.error`, return a minimal `{status:"error"}` body — never leak stack traces or connection-string details in the response (Security Domain, V14/V9 in RESEARCH.md).

---

### `supabase/functions/sync-enqueue/index.ts` (controller, event-driven producer)

**Source:** `01-RESEARCH.md` Pattern 4 (enqueue half)

```typescript
import { createClient } from "npm:@supabase/supabase-js@2.111.0";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

Deno.serve(async (_req) => {
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

**Auth pattern:** unlike `health`, this function should keep `verify_jwt` at its default (`true`) or be gated by a shared-secret header, since it's meant to be invoked only by the `pg_cron`/`pg_net` pipeline (Security Domain, V4 Access Control).

---

### `supabase/functions/sync-worker/index.ts` (controller, event-driven consumer)

**Source:** `01-RESEARCH.md` Pattern 4 (worker half)

```typescript
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
  console.log("processed message", data[0]);
  return new Response("processed", { status: 200 });
});
```

**Decision to document explicitly in the plan (per RESEARCH.md Pitfall 6 / Assumption A4):** this Phase 1 proof-of-concept uses `pgmq_public.pop` (delete-on-read, at-most-once). Phase 3's real sync worker must deliberately switch to `read` + explicit `archive`/`delete` for crash-safe at-least-once semantics (`SYNC-01` idempotency). Flag this choice in the plan so Phase 3 doesn't silently inherit `pop`-based semantics.

---

### `supabase/migrations/<timestamp>_init.sql` (migration, batch/DDL)

**Source:** `01-RESEARCH.md` Pattern 3 (cron/vault) + Pattern 4 (pgmq queue creation)

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists pgmq;

select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
select vault.create_secret('<service-or-anon-key>', 'edge_function_key');

select cron.schedule(
  'sync-enqueue-trigger',
  '*/15 * * * *',
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

select pgmq.create('sync_work');
```

**Convention reference (not applied this phase):** `docs/sql/rls_policies.example.sql` shows the `ALTER TABLE ... ENABLE/FORCE ROW LEVEL SECURITY` + `CREATE POLICY tenant_isolation_<table> ON <table> USING (tenant_id = current_setting('app.tenant_id', true)::uuid)` pattern. Phase 1 creates no tenant-scoped tables, so this pattern doesn't apply yet, but any later-phase migration touching `customers`/`products`/`orders`/`tiny_credentials`/`raw_tiny_payloads`/`users`/`sync_watermarks` must repeat this exact structure.

**Critical anti-pattern (Pitfall 4):** never hardcode the literal URL/API key in the migration body — always `vault.create_secret()` + `vault.decrypted_secrets` lookup, as shown above.

---

### `.github/workflows/ci.yml` (config, batch/CI pipeline)

**Source:** `01-RESEARCH.md` Code Examples (flagged LOW-MEDIUM confidence / synthesized — no canonical single source found)

```yaml
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
        run: deno run --allow-net --allow-env scripts/smoke-test-db.ts

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

**Note:** RESEARCH.md's Open Question 1 recommends preferring a committed standalone `scripts/smoke-test-db.ts` over an inline YAML heredoc (easier local testing, avoids YAML quoting pitfalls) — the workflow above reflects that recommendation rather than the raw heredoc variant also shown in RESEARCH.md.

---

### `scripts/smoke-test-db.ts` (test/utility, request-response)

**Source:** `01-RESEARCH.md` Code Examples, adapted per Open Question 1's recommendation

```typescript
import postgres from "npm:postgres@3.4.9";
const sql = postgres(Deno.env.get("DATABASE_URL")!, { prepare: false });
const result = await sql`select 1 as ok`;
if (result[0].ok !== 1) throw new Error("smoke test failed");
console.log("SELECT 1 OK via production-shape connection");
await sql.end();
```

This must use the **same client construction** (`postgres.js`, `{ prepare: false }`) as `_shared/db.ts` — per Pitfall 5, a generic `postgres:` service container smoke test validates nothing about this phase's actual risk (pooler mode).

## Shared Patterns

### Connection string discipline (applies to `_shared/db.ts`, `scripts/smoke-test-db.ts`, CI secrets)
**Source:** `01-RESEARCH.md` Pattern 1, Pitfalls 1-2; CLAUDE.md "What NOT to Use" (principle carries forward, specifics differ)
- Always Transaction Pooler, port 6543, `postgres.<project-ref>` username, `{ prepare: false }` on `postgres.js`.
- Never reconstruct from host/user/password parts — copy the whole string from Supabase dashboard into a `DATABASE_URL`/`SUPABASE_DB_URL` secret.
- **This inverts CLAUDE.md's stale Session-Pooler (5432) recommendation** — do not follow that table for this phase; it's pre-pivot (FastAPI/Render), and RESEARCH.md explicitly documents why the port/mode differs for serverless Edge Functions.

### Secrets via Supabase Vault (applies to migration + cron wiring)
**Source:** `01-RESEARCH.md` Pattern 3, Pitfall 4
- Never inline a live URL/API key in a `cron.schedule()` SQL body committed to git.
- `vault.create_secret()` once, reference via `vault.decrypted_secrets` lookups.

### Access control on internal pipeline functions (applies to `sync-enqueue`, `sync-worker`)
**Source:** `01-RESEARCH.md` Security Domain, V4 Access Control
- `health` is intentionally public (`verify_jwt = false`).
- `sync-enqueue`/`sync-worker` should stay `verify_jwt`-protected (default) or use a shared-secret header check — they're meant to be invoked only by the cron/queue pipeline, not the public.

### Error handling / logging discipline (applies to all Edge Functions)
**Source:** `01-RESEARCH.md` Security Domain, V14 Configuration
- Never `console.log`/`console.error` the raw connection string or an error object embedding it.
- Keep response bodies minimal on failure (`{"status": "error"}`) — no stack traces.

## No Analog Found

All 8 files listed in File Classification have no codebase analog — this is a fully greenfield phase. Planner must build each file directly from the `01-RESEARCH.md` code excerpts reproduced above (all traced to official Supabase docs per that file's Sources section), constrained secondarily by:
- `docs/02-MODELO-DE-DADOS.md`, `docs/03-INTEGRACAO-TINY-ERP.md` — data model / Tiny API facts, unaffected by the D-01/D-02 pivot, not yet relevant to Phase 1's infra-only scope.
- `docs/sql/rls_policies.example.sql` — RLS convention reference for later phases once tenant-scoped tables exist (not applied in Phase 1).

## Metadata

**Analog search scope:** entire repository (`.claude/`, `.planning/`, `docs/`) — no `src/`, `supabase/`, `backend/`, `frontend/`, or package manifest directories exist.
**Files scanned:** 8 (`.claude/CLAUDE.md`, `.planning/PROJECT.md`, `.planning/ROADMAP.md`, `.planning/STATE.md`, `docs/01-05-*.md`, `docs/sql/rls_policies.example.sql`) plus a full-tree `find` confirming no application code.
**Pattern extraction date:** 2026-07-28
