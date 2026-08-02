// Automated round-trip test for the Cron/Queue/Worker pipeline mechanism
// (ROADMAP Phase 1 Success Criterion 4). Proves, independent of the deployed
// sync-enqueue/sync-worker Edge Functions, that the pgmq_public wrapper
// functions those Edge Functions call (plan 01-04's Rule 3 fix -
// supabase/migrations/20260729232533_pgmq_public_wrappers.sql) correctly
// enqueue and dequeue a message on the sync_work queue:
//   1. pgmq_public.send increases queue depth by 1.
//   2. pgmq_public.pop, called immediately afterward, returns that same
//      message and returns queue depth to its prior value.
import { assertEquals } from "jsr:@std/assert@1";
import { getTestSql } from "./conftest.ts";

const QUEUE = "sync_work";

async function queueDepth(sql: ReturnType<typeof getTestSql>): Promise<number> {
  const rows = await sql`select count(*)::int as n from pgmq.q_sync_work`;
  return rows[0].n as number;
}

Deno.test("pgmq_public round trip: send increases queue depth by 1, pop drains the same message and restores queue depth", async () => {
  const sql = getTestSql();
  try {
    // Defensive drain: the production sync-enqueue-trigger cron job (plan
    // 01-03) fires every 15 minutes independent of this test run, so the
    // queue may already hold an unrelated {kind:"ping"} message from the
    // cron pipeline or a manual sync-enqueue invocation. Drain it first so
    // this test's own assertions aren't affected by FIFO ordering against a
    // message this test didn't send (pgmq.pop always returns the oldest
    // available message, not necessarily this test's own).
    for (let i = 0; i < 100 && (await queueDepth(sql)) > 0; i++) {
      await sql`select * from pgmq_public.pop(${QUEUE})`;
    }
    if ((await queueDepth(sql)) > 0) {
      throw new Error(
        "failed to drain sync_work queue before test assertions (100 pop iterations exhausted)",
      );
    }

    const depthBefore = await queueDepth(sql);
    assertEquals(depthBefore, 0);

    const testMessage = { kind: "test-round-trip", nonce: crypto.randomUUID() };
    const sendResult = await sql`
      select * from pgmq_public.send(${QUEUE}, ${sql.json(testMessage)}::jsonb)
    `;
    const msgId = sendResult[0].send;

    const depthAfterSend = await queueDepth(sql);
    assertEquals(depthAfterSend, depthBefore + 1);

    const popResult = await sql`select * from pgmq_public.pop(${QUEUE})`;
    assertEquals(popResult.length, 1);
    assertEquals(popResult[0].msg_id, msgId);
    assertEquals(popResult[0].message.kind, testMessage.kind);
    assertEquals(popResult[0].message.nonce, testMessage.nonce);

    const depthAfterPop = await queueDepth(sql);
    assertEquals(depthAfterPop, depthBefore);
  } finally {
    await sql.end();
  }
});
