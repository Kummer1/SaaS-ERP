// Queue producer Edge Function — the target `pg_cron`'s `sync-enqueue-trigger`
// job (plan 01-03) calls every 15 minutes via `net.http_post`.
//
// verify_jwt stays at Supabase's DEFAULT (true) — unlike the public `health`
// function (plan 01-01), this function must remain protected: it is meant to
// be invoked only by the pg_cron/pg_net pipeline or an authorized manual call,
// never the public (01-RESEARCH.md Security Domain V4 Access Control; threat
// T-04-01). Do not add a [functions.sync-enqueue] verify_jwt=false override
// to supabase/config.toml.
//
// Phase 1 scope note: this enqueues a single placeholder {kind:"ping"}
// work item to prove the pipeline mechanism end-to-end. Phase 3 replaces this
// with real per-page Tiny ERP product-sync chunking (01-CONTEXT.md D-03
// "work-item granularity" discretion note) — not this plan's job.
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

Deno.serve(async (_req) => {
  const { error } = await supabase.schema("pgmq_public").rpc("send", {
    queue_name: "sync_work",
    message: { kind: "ping", enqueued_at: new Date().toISOString() },
  });

  if (error) {
    // Log only the RPC error object — never the service-role key or the
    // Supabase client's config (Information Disclosure, threat T-04-02).
    console.error("enqueue failed", error);
    return new Response("enqueue failed", { status: 500 });
  }

  return new Response("enqueued", { status: 200 });
});
