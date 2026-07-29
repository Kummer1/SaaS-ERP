// Queue consumer Edge Function — drains one message at a time from the
// sync_work pgmq queue that sync-enqueue (and the pg_cron trigger from plan
// 01-03) populate.
//
// verify_jwt stays at Supabase's DEFAULT (true) — same protection discipline
// as sync-enqueue (01-RESEARCH.md Security Domain V4 Access Control; threat
// T-04-01). Do not add a [functions.sync-worker] verify_jwt=false override
// to supabase/config.toml.
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

Deno.serve(async (_req) => {
  // Phase 1 deliberately uses pgmq_public.pop (delete-on-read, at-most-once)
  // to prove the pipeline mechanism with a placeholder message. Phase 3's
  // real sync worker must switch to pgmq_public.read + explicit archive for
  // crash-safe at-least-once idempotent processing (SYNC-01) — see
  // 01-RESEARCH.md Pitfall 6 / Assumption A4 and this task's <reversibility>
  // note. Do not carry pop-based semantics forward into Phase 3 unchanged.
  const { data, error } = await supabase.schema("pgmq_public").rpc("pop", {
    queue_name: "sync_work",
  });

  if (error) {
    // Log only the RPC error object — never the service-role key or the
    // Supabase client's config (Information Disclosure, threat T-04-02).
    console.error("dequeue failed", error);
    return new Response("dequeue failed", { status: 500 });
  }

  if (!data || data.length === 0) {
    return new Response("queue empty", { status: 200 });
  }

  // Log only the popped message payload — never the service-role key.
  console.log("processed message", data[0]);
  return new Response("processed", { status: 200 });
});
