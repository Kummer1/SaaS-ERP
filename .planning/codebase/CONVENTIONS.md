# Coding Conventions

**Analysis Date:** 2026-08-01

## Naming Patterns

**Files:**
- Edge Function handlers: `supabase/functions/[function-name]/index.ts` (kebab-case)
- Test files: `tests/[module]_test.ts` (kebab-case with `_test` suffix)
- Shared utilities: `supabase/functions/_shared/[module].ts` (kebab-case, prefixed with underscore)
- Scripts: `scripts/[script-name].ts` (kebab-case)

**Functions:**
- camelCase for all functions: `getTestSql()`, `ensureSecret()`, `getHealthUrl()`, `queueDepth()`
- Exported utility factories use verb-noun pattern: `getHealthUrl()`, `getTestSql()`
- Private async helpers describe their action: `ensureSecret()`, `queueDepth()`

**Variables:**
- camelCase throughout: `connectionString`, `projectUrl`, `edgeFunctionKey`, `sql`, `supabase`, `depthBefore`
- Constants: ALL_CAPS (e.g., `QUEUE = "sync_work"`)
- Type annotation: included in destructuring patterns `const { error } = await ...`

**Types:**
- Inferred from context; explicit TypeScript types used in function signatures: `Promise<void>`, `ReturnType<typeof getTestSql>`

## Code Style

**Formatting:**
- 2-space indentation (standard Deno default)
- 80-character soft line limit observed in most files (see `health/index.ts`, `db.ts`)
- Single blank line between function definitions
- Semicolons required (Deno default)
- Line breaks after opening braces in control structures

**Linting:**
- No formal linter configured (Deno's built-in linting not explicitly enabled in `deno.jsonc`)
- Convention-driven through comments and documentation rather than enforced tooling

**Formatting Tool:**
- Deno's built-in formatter available but not enforced (`deno fmt`)
- Code follows Deno default style (observed consistency across all files)

## Import Organization

**Order:**
1. Standard library / Deno built-in (none observed — Deno APIs use Deno.* global)
2. Third-party npm packages (prefixed with `npm:`)
3. JSR packages (prefixed with `jsr:`)
4. Local relative imports (`./` or `../`)

**Examples from codebase:**

```typescript
// Pattern from supabase/functions/sync-enqueue/index.ts
import { createClient } from "@supabase/supabase-js";
```

```typescript
// Pattern from tests/conftest.ts
import postgres from "npm:postgres@3.4.9";

export function getTestSql() { ... }
export function getHealthUrl(): string { ... }
```

```typescript
// Pattern from tests/db_connection_test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { getTestSql } from "./conftest.ts";
```

**Import Rules:**
- Deno imports must include file extension: `.ts` not bare specifiers
- npm packages use semantic versioning in `deno.json` per function: `npm:postgres@3.4.9`, `npm:@supabase/supabase-js@2.111.0`
- Relative imports always use `./` or `../` prefix
- No import aliases or path remapping configured
- No barrel files (`index.ts` re-exports) — each module exports directly

## Error Handling

**Patterns:**
- `try/catch` blocks standard for async operations

```typescript
// From supabase/functions/health/index.ts
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
```

- RPC error checks destructured from response: `const { error } = await supabase.schema(...).rpc(...)`
- Null/empty checks with explicit guard statements

```typescript
// From supabase/functions/sync-worker/index.ts
if (!data || data.length === 0) {
  return new Response("queue empty", { status: 200 });
}
```

- `try/finally` for resource cleanup in tests

```typescript
// From tests/db_connection_test.ts
try {
  for (let i = 0; i < 5; i++) {
    const result = await sql`select ${i}::int as n`;
    assertEquals(result[0].n, i);
  }
} finally {
  await sql.end();
}
```

**Security discipline:**
- Never log connection strings or raw database URLs (enforced by comments and code review)
- Never log service-role keys or secrets
- Error responses return minimal JSON (e.g., `{ status: "error" }`) with no stack traces or sensitive details
- Environment variable validation happens at module initialization, never at runtime within request handlers

## Logging

**Framework:** `console` (Deno's native `console.log`, `console.error`)

**Patterns:**
- `console.error()` for errors: logs error object only, never surrounding context like connection strings

```typescript
// From supabase/functions/health/index.ts
console.error("health check DB ping failed", err);
```

- `console.log()` for info: descriptive messages and safe data

```typescript
// From scripts/setup-vault-secrets.ts
console.log(`vault secret "${name}" created`);
console.log(`confirmed ${rows.length} vault secret(s) present: ${rows.map((r) => r.name).join(", ")}`);
```

- Log level discipline: errors logged when client initialization or database operations fail, info logged on success

## Comments

**When to Comment:**
- Top-of-file block comments (always present) explain the function's purpose, security implications, and reference to architecture/research documents
- Inline comments for non-obvious logic, especially around connection pooling and prepared-statement discipline
- Comments reference prior incidents (commit `55b0f80`) and design patterns (`01-RESEARCH.md` Security Domain V4)

**Example:** From `supabase/functions/_shared/db.ts`

```typescript
// CRITICAL connection discipline (see 01-RESEARCH.md Pattern 1, Pitfall 1-2;
// prior-project incident tinysaas commit 55b0f80):
//   - Always connect through the Supabase Transaction Pooler (port 6543,
//     username `postgres.<project-ref>`), never the Session Pooler or a
//     direct connection — Edge Functions are short-lived/serverless, and the
//     Transaction Pooler is Supabase's documented fit for that workload shape.
```

**JSDoc/TSDoc:**
- Not consistently used for function signatures; type information is inline in function declarations
- File-level comments are more descriptive than function-level JSDoc

```typescript
// From tests/conftest.ts (doc comment above export)
/** Public URL of the deployed health Edge Function, derived from env vars. */
export function getHealthUrl(): string { ... }
```

## Function Design

**Size:** Small, focused functions — single responsibility (each Edge Function handles one HTTP request, each test validates one assertion)

**Parameters:**
- Functions accept environment-derived parameters at initialization, not as arguments
- HTTP handlers accept `_req` parameter (underscore prefix indicates intentionally unused parameter)
- Database client passed as argument to test helpers, not globally accessible

**Return Values:**
- Async functions return `Promise<void>` for setup scripts
- HTTP handlers return `Response` objects with explicit status codes and headers
- Query functions return arrays or objects from database client (postgres.js template results)
- Helper functions return primitives or objects: `string`, `number`, `Promise<void>`

## Module Design

**Exports:**
- Named exports for utility functions in shared modules (`export function getTestSql()`)
- Each Edge Function `index.ts` is a single default handler (`Deno.serve(async (_req) => ...)`)
- Shared clients exported at module level: `export const sql = postgres(...)`

**Barrel Files:**
- Not used — each module exports directly, no `index.ts` re-exports from parent directories

**Constants:**
- Module-level constants (`const QUEUE = "sync_work"`) placed near top of file
- Environment variables read at module initialization: `Deno.env.get("DATABASE_URL")`
- No global state beyond single-instance clients (sql, supabase)

## Deno-Specific Patterns

**Runtime entry points:**
- `Deno.serve()` for HTTP handlers (standard Edge Function pattern)
- `Deno.env.get()` for environment variables (no process.env)
- `Deno.test()` for test registration (covered in TESTING.md)

**Client construction:**
- postgres.js client: `{ prepare: false }` required for Transaction Pooler (port 6543)
- Supabase JS client: initialized with environment variables at module level (not per-request)
- Both clients explicitly require full connection strings, never reconstructed from parts

---

*Convention analysis: 2026-08-01*
