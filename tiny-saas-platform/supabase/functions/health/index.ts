// Public, unauthenticated health-check Edge Function.
// GET /functions/v1/health -> { status: "ok" } (200) when Postgres is reachable
// through the Transaction Pooler, or { status: "error" } (500) otherwise.
//
// verify_jwt = false is set for this function only in supabase/config.toml —
// this is intentional so uptime checkers / bare curl requests can reach it
// without a Supabase Auth JWT (see 01-RESEARCH.md Pattern 2, Pitfall 3).
import { sql } from "../_shared/db.ts";

Deno.serve(async (_req) => {
  try {
    await sql`select 1`;
    return new Response(JSON.stringify({ status: "ok" }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    // Log only the caught error object itself — never interpolate or log the
    // connection string / DATABASE_URL (Information Disclosure, threat T-01-01).
    console.error("health check DB ping failed", err);
    return new Response(JSON.stringify({ status: "error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
