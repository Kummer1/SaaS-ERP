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
// Quick task 260802-hvz: real products-sync producer logic, replacing Phase
// 1's {kind:"ping"} placeholder. Enqueues one sync_work message per tenant
// that is tiny_credentials.status='connected' AND has a null/stale (>15min)
// products watermark.
//
// Design decision — duplicate enqueue is allowed, not guarded (see this
// quick task's PLAN.md <objective> "Decisão de Design: Enfileiramento
// Duplicado" for the full evaluated rationale): this query does NOT check
// sync_work for an already-in-flight message before sending. The watermark
// already suppresses re-enqueue once a cycle completes; the only race window
// is a still-in-flight message from the current cycle, and the cost of that
// duplicate is small and bounded (idempotent upsert absorbs it). Checking
// first would add a second round-trip per invocation, working against the
// 2s Edge Function CPU budget this function must fit.
import { createClient } from "@supabase/supabase-js";
import { sql } from "../_shared/db.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

Deno.serve(async (_req) => {
  // Single joined query (LEFT JOIN sync_watermarks), not a per-tenant
  // separate query — deliberate, for round-trip speed (see header comment).
  const pendingTenants = await sql`
    select tc.tenant_id
    from tiny_credentials tc
    left join sync_watermarks sw
      on sw.tenant_id = tc.tenant_id and sw.resource_type = 'products'
    where tc.status = 'connected'
      and (sw.last_synced_at is null or sw.last_synced_at < now() - interval '15 minutes')
  `;

  const enqueuedTenantIds: string[] = [];

  for (const row of pendingTenants) {
    const tenantId = row.tenant_id as string;
    try {
      const { error } = await supabase.schema("pgmq_public").rpc("send", {
        queue_name: "sync_work",
        message: { tenant_id: tenantId, resource_type: "products" },
      });
      if (error) {
        // Log only the RPC error object — never the service-role key or the
        // Supabase client's config (Information Disclosure, threat T-04-02).
        console.error("enqueue failed for tenant", tenantId, error);
        continue;
      }
      enqueuedTenantIds.push(tenantId);
    } catch (err) {
      console.error("enqueue threw for tenant", tenantId, err);
    }
  }

  // enqueued: 0 is a valid, successful "nothing pending" outcome, not an error.
  return new Response(
    JSON.stringify({ enqueued: enqueuedTenantIds.length, tenant_ids: enqueuedTenantIds }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
});
