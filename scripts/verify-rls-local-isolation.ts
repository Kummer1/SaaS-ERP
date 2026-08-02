// Local-only diagnostic: proves the RLS tenant_id cast fix (nullif-wrapped
// cast), FORCE ROW LEVEL SECURITY, and authenticated grants actually work
// against a real, freshly-reset local Postgres instance - not just SQL text
// inspection or a dry-run check.
//
// Run: deno run --allow-net --allow-env scripts/verify-rls-local-isolation.ts
// Precondition: `supabase db reset` must have been run first against the
// local stack (Docker container supabase_db_tiny-saas-platform on 54322).
//
// Connects using the SAME `postgres` import as scripts/verify-rls-tenant-fix.ts
// (import postgres from "npm:postgres@3.4.9"), but DELIBERATELY does NOT read
// DATABASE_URL/SUPABASE_DB_URL from the environment - in this repo's `.env`,
// that variable holds the LIVE project's Transaction Pooler connection string,
// and this script must be structurally incapable of touching production. The
// connection string below is hardcoded to the local stack only, with a guard
// that throws immediately if it does not point at 127.0.0.1:54322.
import postgres from "npm:postgres@3.4.9";

const LOCAL_CONNECTION_STRING =
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

if (!LOCAL_CONNECTION_STRING.includes("127.0.0.1:54322")) {
  throw new Error(
    "Refusing to connect: LOCAL_CONNECTION_STRING does not contain '127.0.0.1:54322'. " +
      "This script must never connect to anything other than the local Supabase stack.",
  );
}

const sql = postgres(LOCAL_CONNECTION_STRING, { prepare: false });

// --- Step: insert two disposable fake tenants + one user each, as the
// connecting `postgres` superuser (rolbypassrls = true, writes freely
// regardless of the new RLS policies). ---

const [tenantA] = await sql`
  insert into tenants (name)
  values ('Fake Tenant A - quick-260801-tef')
  returning id
`;
console.log("Inserted tenant A:", tenantA);

const [tenantB] = await sql`
  insert into tenants (name)
  values ('Fake Tenant B - quick-260801-tef')
  returning id
`;
console.log("Inserted tenant B:", tenantB);

const tenantAId = tenantA.id;
const tenantBId = tenantB.id;

const [userA] = await sql`
  insert into users (tenant_id, email, hashed_password)
  values (${tenantAId}, 'fake-a@quick-260801-tef.test', 'placeholder-not-a-real-hash')
  returning id, tenant_id, email
`;
console.log("Inserted user A:", userA);

const [userB] = await sql`
  insert into users (tenant_id, email, hashed_password)
  values (${tenantBId}, 'fake-b@quick-260801-tef.test', 'placeholder-not-a-real-hash')
  returning id, tenant_id, email
`;
console.log("Inserted user B:", userB);

// --- Two-fake-tenant isolation test ---
// Exercises tenant_isolation_users, which carries the identical
// nullif(current_setting('app.tenant_id', true), '')::uuid expression as
// tenant_self_read and tenant_isolation_tiny_credentials - testing this one
// policy is representative of all three, since the migration applied the
// identical cast fix to all three.

console.log("\n--- Two-fake-tenant isolation test ---");

const rowsA = await sql.begin(async (tx) => {
  await tx`SET LOCAL ROLE authenticated`;
  await tx`select set_config('app.tenant_id', ${tenantAId}, true)`;
  return await tx`SELECT id, tenant_id, email FROM users ORDER BY email`;
});
console.log("Tenant A session sees:", rowsA);

const rowsB = await sql.begin(async (tx) => {
  await tx`SET LOCAL ROLE authenticated`;
  await tx`select set_config('app.tenant_id', ${tenantBId}, true)`;
  return await tx`SELECT id, tenant_id, email FROM users ORDER BY email`;
});
console.log("Tenant B session sees:", rowsB);

if (rowsA.length !== 1) {
  throw new Error(
    `Isolation assertion failed: tenant A session expected exactly 1 row, found ${rowsA.length}: ${JSON.stringify(rowsA)}`,
  );
}
if (rowsA[0].tenant_id !== tenantAId) {
  throw new Error(
    `Isolation assertion failed: tenant A session's row has tenant_id=${rowsA[0].tenant_id}, expected ${tenantAId}`,
  );
}
if (rowsB.length !== 1) {
  throw new Error(
    `Isolation assertion failed: tenant B session expected exactly 1 row, found ${rowsB.length}: ${JSON.stringify(rowsB)}`,
  );
}
if (rowsB[0].tenant_id !== tenantBId) {
  throw new Error(
    `Isolation assertion failed: tenant B session's row has tenant_id=${rowsB[0].tenant_id}, expected ${tenantBId}`,
  );
}
if (rowsA.some((r) => r.tenant_id === tenantBId)) {
  throw new Error(
    `Isolation assertion failed: tenant A session's result set contains a row belonging to tenant B: ${JSON.stringify(rowsA)}`,
  );
}
if (rowsB.some((r) => r.tenant_id === tenantAId)) {
  throw new Error(
    `Isolation assertion failed: tenant B session's result set contains a row belonging to tenant A: ${JSON.stringify(rowsB)}`,
  );
}

console.log(
  "Isolation test PASSED: tenant A sees only its own row, tenant B sees only its own row, zero cross-tenant leakage.",
);

// --- RESET / empty-string fail-closed test ---
// This is the direct reproduction of the exact regression this fix targets:
// current_setting('app.tenant_id', true) returning '' (not NULL) in some
// pooled-connection paths, and the pre-fix direct ::uuid cast throwing
// "invalid input syntax for type uuid" instead of denying access.

console.log("\n--- RESET / empty-string fail-closed test ---");

// Scenario 1: literal RESET
console.log("\nScenario 1: literal RESET app.tenant_id");
try {
  const resetRows = await sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE authenticated`;
    // PostgreSQL's SET command does not accept bind parameters, so this one
    // line uses tx.unsafe() with the value interpolated directly. tenantAId
    // is a system-generated UUID from `tenants.id` (gen_random_uuid()), not
    // attacker-controlled input, so this is safe in this diagnostic-only
    // context. Every other statement in this script uses parameterized
    // queries or set_config().
    await tx.unsafe(`SET LOCAL app.tenant_id = '${tenantAId}'`);
    await tx`RESET app.tenant_id`;
    return await tx`SELECT id, tenant_id, email FROM users`;
  });
  console.log("Query: SELECT id, tenant_id, email FROM users (after RESET app.tenant_id)");
  console.log("Result:", resetRows);
  if (resetRows.length !== 0) {
    throw new Error(
      `Fail-closed assertion failed (RESET scenario): expected 0 rows, found ${resetRows.length}: ${JSON.stringify(resetRows)}`,
    );
  }
  console.log("RESET scenario PASSED: zero rows returned, no cast error.");
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("invalid input syntax for type uuid")) {
    throw new Error(
      `REGRESSION REPRODUCED (RESET scenario): the original bug is NOT fixed - got "invalid input syntax for type uuid": ${message}`,
    );
  }
  throw err;
}

// Scenario 2: explicit empty-string via set_config
console.log("\nScenario 2: explicit empty-string set_config('app.tenant_id', '', true)");
try {
  const emptyStringRows = await sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE authenticated`;
    await tx`select set_config('app.tenant_id', '', true)`;
    return await tx`SELECT id, tenant_id, email FROM users`;
  });
  console.log("Query: SELECT id, tenant_id, email FROM users (after set_config('app.tenant_id', '', true))");
  console.log("Result:", emptyStringRows);
  if (emptyStringRows.length !== 0) {
    throw new Error(
      `Fail-closed assertion failed (empty-string scenario): expected 0 rows, found ${emptyStringRows.length}: ${JSON.stringify(emptyStringRows)}`,
    );
  }
  console.log("Empty-string scenario PASSED: zero rows returned, no cast error.");
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("invalid input syntax for type uuid")) {
    throw new Error(
      `REGRESSION REPRODUCED (empty-string scenario): the original bug is NOT fixed - got "invalid input syntax for type uuid": ${message}`,
    );
  }
  throw err;
}

console.log(
  "\nALL LOCAL CHECKS PASSED: two-tenant isolation with zero cross-tenant leakage, " +
    "plus both RESET and empty-string fail-closed scenarios returned zero rows with no cast error.",
);

await sql.end();
