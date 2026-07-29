// Standalone connection smoke-test script.
//
// Run: deno run --allow-net --allow-env scripts/smoke-test-db.ts
//
// Connects using the SAME client construction as supabase/functions/_shared/db.ts
// (Transaction Pooler, { prepare: false }) - per 01-RESEARCH.md Pitfall 5, a
// generic `postgres:` service container smoke test would validate nothing
// about this phase's actual risk (pooler mode + prepared-statement config).
//
// This exact script is reused unchanged by plan 01-02's CI smoke-test job.
import postgres from "npm:postgres@3.4.9";

const connectionString =
  Deno.env.get("DATABASE_URL") ?? Deno.env.get("SUPABASE_DB_URL")!;

const sql = postgres(connectionString, { prepare: false });

const result = await sql`select 1 as ok`;
if (result[0].ok !== 1) {
  throw new Error("smoke test failed: unexpected result from select 1 as ok");
}
console.log("SELECT 1 OK via production-shape connection");
await sql.end();
