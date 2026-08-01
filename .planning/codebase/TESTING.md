# Testing Patterns

**Analysis Date:** 2026-08-01

## Test Framework

**Runner:**
- Deno test framework (native Deno.test())
- Config: `supabase/functions/deno.jsonc`
- Single root task configuration for all tests across all Edge Functions

**Assertion Library:**
- JSR Standard Library: `jsr:@std/assert@1`
- Primary assertion: `assertEquals(actual, expected)`

**Run Commands:**
```bash
deno test --allow-net --allow-env    # Run all tests (from supabase/functions/deno.jsonc task)
```

**Test invocation:**
- From repository root: `cd supabase/functions && deno test --allow-net --allow-env`
- Or using Deno task: `deno task test` (if running from `supabase/functions/` directory where `deno.jsonc` defines the task)

**Permissions required:**
- `--allow-net`: Required for HTTP fetches to deployed Edge Functions and external services
- `--allow-env`: Required to read environment variables (DATABASE_URL, SUPABASE_URL, etc.)
- No filesystem permissions required for current test suite

## Test File Organization

**Location:**
- Tests reside in `tests/` directory at repository root
- One test file per logical concern: `tests/health_test.ts`, `tests/db_connection_test.ts`, `tests/sync_pipeline_test.ts`, `tests/conftest.ts`

**Naming:**
- Test files: `[module]_test.ts` (kebab-case with `_test` suffix)
- Fixtures/helpers: `conftest.ts` (Pytest convention adopted for Deno)

**Structure:**
```
tests/
├── conftest.ts                  # Shared fixtures and helper functions
├── health_test.ts               # HTTP endpoint tests
├── db_connection_test.ts        # Database connectivity tests
└── sync_pipeline_test.ts        # Queue mechanism round-trip tests
```

## Test Structure

**Suite Organization:**
- No nested describe/it hierarchy (Deno.test uses flat structure)
- Each test is a top-level call: `Deno.test("test description", async () => { ... })`
- Tests can be independent or share setup via fixture imports

**Example from `tests/health_test.ts`:**

```typescript
import { assertEquals } from "jsr:@std/assert@1";
import { getHealthUrl } from "./conftest.ts";

Deno.test("GET /functions/v1/health returns 200 with status ok, no auth header", async () => {
  const res = await fetch(getHealthUrl());
  const body = await res.json();

  assertEquals(res.status, 200);
  assertEquals(body.status, "ok");
});
```

**Patterns:**

- **Setup:** Use factory functions from `conftest.ts` (e.g., `getTestSql()`, `getHealthUrl()`)
- **Cleanup:** `try/finally` block with cleanup in finally (required for database client closure)
- **Assertions:** Direct assertions using `assertEquals()` on meaningful values

**Example from `tests/db_connection_test.ts` (setup/cleanup):**

```typescript
Deno.test("5+ sequential queries through one client instance all succeed (prepare:false pooler safety)", async () => {
  const sql = getTestSql();
  try {
    for (let i = 0; i < 5; i++) {
      const result = await sql`select ${i}::int as n`;
      assertEquals(result[0].n, i);
    }
  } finally {
    await sql.end();  // Cleanup: close connection
  }
});
```

## Fixtures and Factories

**Test Data:**
- No explicit fixture files with seed data (tests work against live/test database)
- Defensive setup: tests drain existing queue before assertions (see `sync_pipeline_test.ts` lines 23-37)

**Example from `tests/sync_pipeline_test.ts`:**

```typescript
async function queueDepth(sql: ReturnType<typeof getTestSql>): Promise<number> {
  const rows = await sql`select count(*)::int as n from pgmq.q_sync_work`;
  return rows[0].n as number;
}

// Defensive drain before test assertions
for (let i = 0; i < 100 && (await queueDepth(sql)) > 0; i++) {
  await sql`select * from pgmq_public.pop(${QUEUE})`;
}
```

**Location:**
- Shared fixture functions in `tests/conftest.ts`
- Private test helper functions defined in test files themselves (e.g., `queueDepth()` in `sync_pipeline_test.ts`)

**Factory Functions:**

```typescript
// From tests/conftest.ts

export function getTestSql() {
  const connectionString =
    Deno.env.get("DATABASE_URL") ?? Deno.env.get("SUPABASE_DB_URL");
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL or SUPABASE_DB_URL environment variable is required and unset",
    );
  }
  return postgres(connectionString, { prepare: false });
}

export function getHealthUrl(): string {
  const explicit = Deno.env.get("HEALTH_URL");
  if (explicit) return explicit;
  const ref = Deno.env.get("SUPABASE_PROJECT_REF");
  if (!ref) {
    throw new Error(
      "Set HEALTH_URL or SUPABASE_PROJECT_REF to locate the deployed health function",
    );
  }
  return `https://${ref}.supabase.co/functions/v1/health`;
}
```

## Mocking

**Framework:** None — tests use real external services/databases (live Supabase instance)

**Approach:**
- Tests validate actual connection behavior, not mocked responses
- Database tests use real Transaction Pooler connection (port 6543, `{ prepare: false }`)
- HTTP tests fetch against actual deployed Edge Function URLs
- Rationale: Phase 1 priority is proving the infrastructure works end-to-end; mocking would hide connection pooler issues (which is the primary risk being validated)

**What to Mock:**
- Nothing currently — all tests exercise real connections to prove `01-RESEARCH.md` Assumptions A1-A4

**What NOT to Mock:**
- Database connections (need to validate pooler mode + prepared-statement discipline)
- HTTP endpoints (need to validate deployment and routing)
- Vault/secrets (need to validate Supabase Vault integration)

## Coverage

**Requirements:** None enforced

**View Coverage:** Not configured

**Current coverage:** Ad-hoc — see test scopes below

## Test Types

**Unit Tests:**
- Scope: Single Edge Function handler or utility function
- Approach: Call the handler/function, assert the output
- Examples:
  - `tests/health_test.ts` - Tests the `health/index.ts` Edge Function's HTTP response format
  - `tests/db_connection_test.ts` - Tests the postgres.js client construction from `_shared/db.ts` doesn't fail under repeated queries

**Integration Tests:**
- Scope: Multiple components working together (database client → queue → worker)
- Approach: Call RPC functions via Supabase JS client, verify state changes
- Example: `tests/sync_pipeline_test.ts` - Validates end-to-end enqueue/dequeue through pgmq

**E2E Tests:**
- Not formally separated — integration tests serve as E2E validation
- HTTP fetch tests (`health_test.ts`) validate deployed function availability and response format

## Common Patterns

**Async Testing:**

```typescript
// Standard pattern: async function with await
Deno.test("test name", async () => {
  const result = await someAsyncOperation();
  assertEquals(result, expectedValue);
});
```

All tests are async (database operations, HTTP fetches are async-only).

**Error Testing:**

```typescript
// From tests/sync_pipeline_test.ts — defensive error handling
if ((await queueDepth(sql)) > 0) {
  throw new Error(
    "failed to drain sync_work queue before test assertions (100 pop iterations exhausted)",
  );
}
```

Tests explicitly throw on unrecoverable conditions rather than using assertion libraries' `.throws()` pattern.

**Database Query Pattern:**

Tests use postgres.js template literals directly:

```typescript
// From tests/db_connection_test.ts
const result = await sql`select ${i}::int as n`;
assertEquals(result[0].n, i);
```

```typescript
// From tests/sync_pipeline_test.ts
const rows = await sql`select count(*)::int as n from pgmq.q_sync_work`;
return rows[0].n as number;
```

```typescript
// Complex example with parameterization
const testMessage = { kind: "test-round-trip", nonce: crypto.randomUUID() };
const sendResult = await sql`
  select * from pgmq_public.send(${QUEUE}, ${sql.json(testMessage)}::jsonb)
`;
```

## Test Execution Flow

**Local Development:**
1. Set `DATABASE_URL` or `SUPABASE_DB_URL` environment variable
2. Set `SUPABASE_PROJECT_REF` (for deployed HTTP tests) or `HEALTH_URL` (override)
3. Run: `deno test --allow-net --allow-env` from `supabase/functions/` or repository root

**CI Pipeline:**
See `.github/workflows/ci.yml`:
1. Smoke test runs first: `deno run --allow-net --allow-env scripts/smoke-test-db.ts`
2. Full test suite runs (implicit in deploy step or explicit test job)
3. Tests must pass before deployment to production

**Test Ordering:**
- Tests run in parallel by default (Deno.test behavior)
- `sync_pipeline_test.ts` includes defensive queue draining to handle race conditions with production cron job

## Test Documentation

Tests reference success criteria and research documents:

```typescript
// From tests/health_test.ts — references ROADMAP
// Automated Deno test proving ROADMAP Success Criterion 1: an unauthenticated
// GET request to the deployed health Edge Function's public URL returns HTTP
// 200 with a { status: "ok" } body.
```

```typescript
// From tests/sync_pipeline_test.ts — references plan and assumptions
// Automated round-trip test for the Cron/Queue/Worker pipeline mechanism
// (ROADMAP Phase 1 Success Criterion 4). Proves, independent of the deployed
// sync-enqueue/sync-worker Edge Functions, that the pgmq_public wrapper
// functions those Edge Functions call (plan 01-04's Rule 3 fix - 
// supabase/migrations/20260729232533_pgmq_public_wrappers.sql) correctly
// enqueue and dequeue a message on the sync_work queue
```

---

*Testing analysis: 2026-08-01*
