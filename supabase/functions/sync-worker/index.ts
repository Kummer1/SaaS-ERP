// Queue consumer Edge Function — drains a bounded batch from the sync_work
// pgmq queue that sync-enqueue (and the pg_cron trigger) populate.
//
// verify_jwt stays at Supabase's DEFAULT (true) — same protection discipline
// as sync-enqueue (01-RESEARCH.md Security Domain V4 Access Control; threat
// T-04-01). Do not add a [functions.sync-worker] verify_jwt=false override
// to supabase/config.toml.
//
// Quick task 260802-hvz: real products-sync consumer logic, replacing Phase
// 1's placeholder. Switches from Phase 1's pgmq_public.pop (delete-on-read,
// at-most-once -- silently drops in-flight work on crash) to
// pgmq_public.read + explicit archive (visibility timeout, crash-safe,
// at-least-once), per 01-04-SUMMARY.md's own forward note that Phase 3 must
// not carry pop-based semantics forward unchanged.
//
// TENANT ISOLATION (T-hvz-01, the single highest-consequence boundary in
// this plan): this connection is service-role-equivalent and processes
// MULTIPLE tenants' Vault secrets/data in one invocation -- RLS does NOT
// enforce isolation here. tenant_id/resource_type are destructured FRESH
// from each message INSIDE the loop body, never hoisted to an outer-scope
// variable, and the access token is resolved fresh per message from that
// same tenant's own tiny_credentials row. Never reuse a variable across
// iterations for anything tenant-scoped.
import { createClient } from "@supabase/supabase-js";
import { sql } from "../_shared/db.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const BATCH_SIZE = 15; // capped, inside the 10-20 range
const VISIBILITY_TIMEOUT_SEC = 60; // shorter than the 3-min worker cron cadence

Deno.serve(async (_req) => {
  const tinyApiBaseUrl = Deno.env.get("TINY_API_BASE_URL");
  if (!tinyApiBaseUrl) {
    console.error("sync-worker: TINY_API_BASE_URL is unset");
    return new Response("server_error", { status: 500 });
  }

  const { data, error } = await supabase.schema("pgmq_public").rpc("read", {
    queue_name: "sync_work",
    vt: VISIBILITY_TIMEOUT_SEC,
    qty: BATCH_SIZE,
  });

  if (error) {
    // Log only the RPC error object -- never the service-role key or the
    // Supabase client's config (Information Disclosure, threat T-04-02).
    console.error("dequeue failed", error);
    return new Response("dequeue failed", { status: 500 });
  }

  if (!data || data.length === 0) {
    return new Response(
      JSON.stringify({ processed: 0, message: "queue empty" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  let processed = 0;
  let skipped = 0;
  let failed = 0;

  for (const msg of data) {
    // Destructured fresh from THIS message, inside the loop body -- never
    // hoisted (see file header T-hvz-01 note).
    const { tenant_id: tenantId, resource_type: resourceType } = msg.message as {
      tenant_id: string;
      resource_type: string;
    };

    try {
      if (resourceType !== "products") {
        console.warn("sync-worker: unsupported resource_type, archiving", resourceType);
        await archiveMessage(msg.msg_id);
        skipped++;
        continue;
      }

      const credRows = await sql`
        select status, encrypted_access_token
        from tiny_credentials
        where tenant_id = ${tenantId}
      `;
      const cred = credRows[0];
      if (!cred || cred.status !== "connected") {
        // Tenant disconnected between enqueue and processing -- no point
        // calling Tiny for a dead/absent credential.
        await archiveMessage(msg.msg_id);
        skipped++;
        continue;
      }

      const secretRows = await sql`
        select decrypted_secret
        from vault.decrypted_secrets
        where id = ${cred.encrypted_access_token}::uuid
      `;
      const accessToken = secretRows[0]?.decrypted_secret as string | undefined;
      if (!accessToken) {
        console.error("sync-worker: no decrypted access token for tenant", tenantId);
        failed++;
        continue; // do NOT archive -- let visibility timeout expire, retry
      }

      const response = await fetch(tinyApiBaseUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (response.status === 401) {
        await sql`
          update tiny_credentials set status = 'expired' where tenant_id = ${tenantId}
        `;
        await archiveMessage(msg.msg_id);
        // Never log the access token itself.
        console.warn("sync-worker: 401 from Tiny, marked tenant expired", tenantId);
        skipped++;
        continue;
      }

      if (!response.ok) {
        console.error(
          "sync-worker: Tiny call failed for tenant",
          tenantId,
          response.status,
        );
        failed++;
        continue; // do NOT archive -- let visibility timeout expire, retry
      }

      const body = await response.json() as {
        produtos: Array<{
          id: number;
          sku: string | null;
          nome: string;
          preco: number | null;
          estoqueAtual: number | null;
          atualizadoEm: string | null;
        }>;
      };

      await sql.begin(async (tx) => {
        for (const produto of body.produtos) {
          await tx`
            insert into raw_tiny_payloads (tenant_id, resource_type, resource_id, payload, fetched_at)
            values (${tenantId}, 'products', ${String(produto.id)}, ${tx.json(produto)}, now())
          `;
          await tx`
            insert into products (tenant_id, tiny_id, sku, name, price, stock_quantity, tiny_updated_at, synced_at)
            values (
              ${tenantId}, ${produto.id}, ${produto.sku}, ${produto.nome},
              ${produto.preco}, ${produto.estoqueAtual}, ${produto.atualizadoEm}, now()
            )
            on conflict (tenant_id, tiny_id) do update set
              sku = excluded.sku,
              name = excluded.name,
              price = excluded.price,
              stock_quantity = excluded.stock_quantity,
              tiny_updated_at = excluded.tiny_updated_at,
              synced_at = excluded.synced_at
          `;
        }

        // Watermark only advances after bronze+silver writes for this
        // tenant actually committed -- ordering matters, never before.
        await tx`
          insert into sync_watermarks (tenant_id, resource_type, last_synced_at)
          values (${tenantId}, 'products', now())
          on conflict (tenant_id, resource_type) do update set
            last_synced_at = excluded.last_synced_at
        `;
      });

      try {
        await archiveMessage(msg.msg_id);
      } catch (archiveErr) {
        // Message will become visible again after the visibility timeout
        // and be safely reprocessed (idempotent upsert) -- do not throw.
        console.error("sync-worker: archive failed for msg", msg.msg_id, archiveErr);
      }
      processed++;
    } catch (err) {
      // One tenant's failure must never abort the batch or contaminate the
      // next iteration's state.
      console.error("sync-worker: iteration failed for tenant", tenantId, err);
      failed++;
    }
  }

  return new Response(
    JSON.stringify({ processed, skipped, failed }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
});

async function archiveMessage(msgId: number): Promise<void> {
  const { error } = await supabase.schema("pgmq_public").rpc("archive", {
    queue_name: "sync_work",
    msg_id: msgId,
  });
  if (error) {
    throw error;
  }
}
