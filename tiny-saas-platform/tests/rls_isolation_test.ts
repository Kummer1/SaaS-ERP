// Automated regression test for the RLS tenant_id cast fix (migration
// 20260801234106_fix_rls_tenant_id_cast_and_grants.sql): FORCE ROW LEVEL
// SECURITY + the nullif(current_setting('app.tenant_id', true), '')::uuid
// cast on `users` (representative of the identical policy shape also applied
// to `tenants`/`tiny_credentials`). Promotes the manual diagnostic in
// scripts/verify-rls-local-isolation.ts (quick-260801-tef) into the project's
// permanent Deno.test suite so this regression is caught automatically by CI
// on every push, not just re-verified by hand.
//
// Two things this proves, against a real connected Postgres role (not SQL
// text inspection):
//   1. Two-tenant isolation: a session scoped to tenant A's app.tenant_id
//      sees only tenant A's row, never tenant B's, and vice versa.
//   2. Fail-closed on RESET/empty-string: the pre-fix bug cast
//      current_setting('app.tenant_id', true) directly to ::uuid, which
//      throws "invalid input syntax for type uuid" when the setting is ''
//      (not NULL) - the exact state a RESET or an unset session variable
//      produces on some pooled-connection paths. The fix wraps the cast in
//      nullif(..., '') so this reads as NULL and denies access (0 rows)
//      instead of throwing. This test fails loudly if that regression
//      reappears.
import { assertEquals } from "jsr:@std/assert@1";
import { getTestSql } from "./conftest.ts";

Deno.test("RLS: two-tenant isolation + RESET/empty-string fail-closed (no cross-tenant leakage, no cast error)", async () => {
  const sql = getTestSql();
  let tenantAId: string | undefined;
  let tenantBId: string | undefined;

  try {
    // --- Setup: two disposable fake tenants + one user each, inserted as
    // the connecting role (bypasses RLS regardless of the policies under
    // test - this is the trusted setup path, not the thing being tested). ---
    const [tenantA] = await sql`
      insert into tenants (name)
      values ('RLS Isolation Test Tenant A - tests/rls_isolation_test')
      returning id
    `;
    tenantAId = tenantA.id;

    const [tenantB] = await sql`
      insert into tenants (name)
      values ('RLS Isolation Test Tenant B - tests/rls_isolation_test')
      returning id
    `;
    tenantBId = tenantB.id;

    // Non-optional aliases for use below - both are guaranteed set at this
    // point (assigned immediately above from a `returning id` insert), but
    // the outer `let ... | undefined` declarations (needed so `finally` can
    // safely check-before-delete regardless of where a failure occurred)
    // otherwise force every downstream usage to prove non-undefined itself.
    const aId: string = tenantAId!;
    const bId: string = tenantBId!;

    await sql`
      insert into users (tenant_id, email, hashed_password)
      values (${aId}, 'rls-test-a@rls-isolation-test.local', 'placeholder-not-a-real-hash')
    `;
    await sql`
      insert into users (tenant_id, email, hashed_password)
      values (${bId}, 'rls-test-b@rls-isolation-test.local', 'placeholder-not-a-real-hash')
    `;

    // --- Two-tenant isolation ---
    const rowsA = await sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE authenticated`;
      await tx`select set_config('app.tenant_id', ${aId}, true)`;
      return await tx`
        select id, tenant_id, email from users
        where tenant_id in (${aId}, ${bId})
      `;
    });
    assertEquals(
      rowsA.length,
      1,
      `tenant A session should see exactly its own row, got: ${
        JSON.stringify(rowsA)
      }`,
    );
    assertEquals(rowsA[0].tenant_id, aId);

    const rowsB = await sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE authenticated`;
      await tx`select set_config('app.tenant_id', ${bId}, true)`;
      return await tx`
        select id, tenant_id, email from users
        where tenant_id in (${aId}, ${bId})
      `;
    });
    assertEquals(
      rowsB.length,
      1,
      `tenant B session should see exactly its own row, got: ${
        JSON.stringify(rowsB)
      }`,
    );
    assertEquals(rowsB[0].tenant_id, bId);

    // --- Fail-closed: literal RESET app.tenant_id ---
    try {
      const resetRows = await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE authenticated`;
        // PostgreSQL's SET does not accept bind parameters. aId is a
        // system-generated UUID (gen_random_uuid()), not attacker-controlled
        // input, so interpolating it here is safe - every other statement in
        // this test uses parameterized queries or set_config().
        await tx.unsafe(`SET LOCAL app.tenant_id = '${aId}'`);
        await tx`RESET app.tenant_id`;
        return await tx`
          select id, tenant_id, email from users
          where tenant_id in (${aId}, ${bId})
        `;
      });
      assertEquals(
        resetRows.length,
        0,
        `RESET app.tenant_id should deny access (0 rows), got: ${
          JSON.stringify(resetRows)
        }`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("invalid input syntax for type uuid")) {
        throw new Error(
          `REGRESSION REPRODUCED (RESET scenario): the nullif-wrapped cast fix is NOT in effect - got "invalid input syntax for type uuid": ${message}`,
        );
      }
      throw err;
    }

    // --- Fail-closed: explicit empty-string via set_config ---
    try {
      const emptyStringRows = await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE authenticated`;
        await tx`select set_config('app.tenant_id', '', true)`;
        return await tx`
          select id, tenant_id, email from users
          where tenant_id in (${aId}, ${bId})
        `;
      });
      assertEquals(
        emptyStringRows.length,
        0,
        `empty-string app.tenant_id should deny access (0 rows), got: ${
          JSON.stringify(emptyStringRows)
        }`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("invalid input syntax for type uuid")) {
        throw new Error(
          `REGRESSION REPRODUCED (empty-string scenario): the nullif-wrapped cast fix is NOT in effect - got "invalid input syntax for type uuid": ${message}`,
        );
      }
      throw err;
    }
  } finally {
    // Cleanup: delete both fake tenants (cascades their users), regardless
    // of which assertion above failed or passed.
    if (tenantAId) await sql`delete from tenants where id = ${tenantAId}`;
    if (tenantBId) await sql`delete from tenants where id = ${tenantBId}`;
    await sql.end();
  }
});
