// Proves 01-RESEARCH.md's single highest-consequence claim (Assumption A1):
// the Transaction Pooler + { prepare: false } postgres.js client (built in
// supabase/functions/_shared/db.ts / mirrored by tests/conftest.ts) survives
// repeated sequential queries through ONE shared client instance with no
// "prepared statement does not exist" error - the exact failure mode Pitfall 2
// describes (the Transaction Pooler swapping backend connections between
// statements within one client session).
import { assertEquals } from "jsr:@std/assert@1";
import { getTestSql } from "./conftest.ts";

Deno.test("5+ sequential queries through one client instance all succeed (prepare:false pooler safety)", async () => {
  const sql = getTestSql();
  try {
    for (let i = 0; i < 5; i++) {
      const result = await sql`select ${i}::int as n`;
      assertEquals(result[0].n, i);
    }
  } finally {
    await sql.end();
  }
});
