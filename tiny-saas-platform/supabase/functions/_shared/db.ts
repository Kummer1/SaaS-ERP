// Shared Postgres client factory for all Edge Functions in this project.
//
// CRITICAL connection discipline (see 01-RESEARCH.md Pattern 1, Pitfall 1-2;
// prior-project incident tinysaas commit 55b0f80):
//   - Always connect through the Supabase Transaction Pooler (port 6543,
//     username `postgres.<project-ref>`), never the Session Pooler or a
//     direct connection — Edge Functions are short-lived/serverless, and the
//     Transaction Pooler is Supabase's documented fit for that workload shape.
//   - Read DATABASE_URL / SUPABASE_DB_URL as ONE opaque environment variable.
//     Never split it into host/user/password parts and never rebuild it from
//     separate secrets — that reconstruction is the exact bug class that
//     caused the prior project's production incident.
//   - Always construct the client with { prepare: false }. The Transaction
//     Pooler swaps the underlying backend connection between statements
//     within a single client session, which breaks postgres.js's default
//     prepared-statement caching if left enabled.
import postgres from "npm:postgres@3.4.9";

const connectionString =
  Deno.env.get("DATABASE_URL") ?? Deno.env.get("SUPABASE_DB_URL");
if (!connectionString) {
  throw new Error(
    "DATABASE_URL or SUPABASE_DB_URL environment variable is required and unset",
  );
}

// prepare: false is REQUIRED for the Transaction Pooler (port 6543) — prepared
// statements are tied to a single backend connection, and transaction mode
// swaps connections between statements, which breaks prepared-statement caching.
export const sql = postgres(connectionString, { prepare: false });
