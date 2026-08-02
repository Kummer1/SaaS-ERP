// Verifies the RLS tenant_id cast fix (nullif-wrapped cast), FORCE ROW LEVEL
// SECURITY, and authenticated SELECT grants are all live on tenants, users,
// and tiny_credentials.
//
// Run: deno run --allow-net --allow-env scripts/verify-rls-tenant-fix.ts
//
// Connects using the SAME client construction as scripts/smoke-test-db.ts and
// supabase/functions/_shared/db.ts (Transaction Pooler, { prepare: false }) -
// this is the project's one enforced convention for every DB-touching script.
import postgres from "npm:postgres@3.4.9";

const connectionString =
  Deno.env.get("DATABASE_URL") ?? Deno.env.get("SUPABASE_DB_URL");
if (!connectionString) {
  throw new Error(
    "DATABASE_URL or SUPABASE_DB_URL environment variable is required and unset",
  );
}

const sql = postgres(connectionString, { prepare: false });

const TABLES = ["tenants", "users", "tiny_credentials"];

// Check A: cast fix - every policy's qual (and with_check, where present)
// must reference nullif(...) instead of a direct current_setting(...)::uuid
// cast, so an empty-string GUC normalizes to NULL and denies access instead
// of throwing invalid input syntax for type uuid.
const policyRows = await sql`
  select policyname, qual, with_check
  from pg_policies
  where schemaname = 'public'
    and tablename = any(${TABLES})
`;

if (policyRows.length !== 3) {
  throw new Error(
    `Check A (cast fix) failed: expected 3 policy rows for ${TABLES.join(", ")}, found ${policyRows.length}: ${JSON.stringify(policyRows)}`,
  );
}

for (const row of policyRows) {
  const qual = String(row.qual ?? "");
  const withCheck = row.with_check === null ? null : String(row.with_check);
  if (!/nullif/i.test(qual)) {
    throw new Error(
      `Check A (cast fix) failed: policy "${row.policyname}" qual does not contain "nullif": ${qual}`,
    );
  }
  if (withCheck !== null && !/nullif/i.test(withCheck)) {
    throw new Error(
      `Check A (cast fix) failed: policy "${row.policyname}" with_check does not contain "nullif": ${withCheck}`,
    );
  }
}

// Check B: FORCE ROW LEVEL SECURITY - both relrowsecurity and
// relforcerowsecurity must be true on all three tables, otherwise the
// table-owner/migration role can bypass RLS entirely.
const rlsRows = await sql`
  select c.relname, c.relrowsecurity, c.relforcerowsecurity
  from pg_class c
  join pg_namespace n on c.relnamespace = n.oid
  where n.nspname = 'public'
    and c.relname = any(${TABLES})
`;

if (rlsRows.length !== 3) {
  throw new Error(
    `Check B (FORCE RLS) failed: expected 3 pg_class rows for ${TABLES.join(", ")}, found ${rlsRows.length}: ${JSON.stringify(rlsRows)}`,
  );
}

for (const row of rlsRows) {
  if (row.relrowsecurity !== true || row.relforcerowsecurity !== true) {
    throw new Error(
      `Check B (FORCE RLS) failed: table "${row.relname}" has relrowsecurity=${row.relrowsecurity}, relforcerowsecurity=${row.relforcerowsecurity} (both must be true)`,
    );
  }
}

// Check C: grants - authenticated must have SELECT on all three tables,
// since raw create table migrations don't auto-grant like Studio-created
// tables do.
const grantRows = await sql`
  select table_name
  from information_schema.role_table_grants
  where table_schema = 'public'
    and grantee = 'authenticated'
    and table_name = any(${TABLES})
    and privilege_type = 'SELECT'
`;

if (grantRows.length !== 3) {
  throw new Error(
    `Check C (grants) failed: expected 3 authenticated SELECT grants for ${TABLES.join(", ")}, found ${grantRows.length}: ${JSON.stringify(grantRows)}`,
  );
}

console.log(
  "RLS tenant_id fix verified: nullif-wrapped cast, FORCE ROW LEVEL SECURITY, and authenticated SELECT grants are all present on tenants, users, and tiny_credentials.",
);

await sql.end();
