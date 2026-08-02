// Local-only end-to-end proof of the real products sync pipeline
// (quick-260802-hvz): sync-enqueue (producer) -> pgmq sync_work queue ->
// sync-worker (consumer) -> bronze (raw_tiny_payloads) + silver (products) +
// sync_watermarks, against tiny-mock-produtos instead of the real Tiny API.
//
// Proves, in order:
//   1. Tenant A (connected, null watermark) gets enqueued, processed, and
//      has bronze/silver/watermark all written, traceable to Tenant A's own
//      mock access token.
//   2. An immediate re-run of sync-enqueue does NOT re-enqueue Tenant A
//      (watermark suppression) -- proven, not assumed.
//   3. Tenant B goes through the same cycle with zero cross-tenant
//      contamination in either direction (the isolation tripwire).
//
// Connection discipline matches scripts/test-oauth-mock-flow.ts and
// scripts/verify-rls-local-isolation.ts: hardcoded to the local stack only,
// never reads DATABASE_URL/SUPABASE_DB_URL from the environment (that var
// holds the LIVE project's connection string in this repo's .env) -- guarded
// so this script is structurally incapable of touching production. The
// service-role key is fetched dynamically via `supabase status -o env`
// (never hardcoded), with the same 127.0.0.1-only guard extended to it.
//
// Run: deno run --allow-net --allow-env --allow-run=supabase scripts/test-products-sync-pipeline.ts
// Precondition: `supabase start` running locally, migrations applied
// (`supabase db reset`), sync-enqueue/sync-worker/tiny-mock-produtos deployed
// (hot-reloaded locally).
import postgres from "npm:postgres@3.4.9";

const LOCAL_CONNECTION_STRING =
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
if (!LOCAL_CONNECTION_STRING.includes("127.0.0.1:54322")) {
  throw new Error(
    "Refusing to connect: LOCAL_CONNECTION_STRING does not contain '127.0.0.1:54322'. " +
      "This script must never connect to anything other than the local Supabase stack.",
  );
}

const FUNCTIONS_BASE = "http://127.0.0.1:54321/functions/v1";
if (!FUNCTIONS_BASE.startsWith("http://127.0.0.1:54321")) {
  throw new Error(
    "Refusing to run: FUNCTIONS_BASE does not point at the local stack.",
  );
}

const sql = postgres(LOCAL_CONNECTION_STRING, { prepare: false });

// --- Fetch the local service-role key dynamically, never hardcoded ---

async function getLocalServiceRoleKey(): Promise<string> {
  const cmd = new Deno.Command("supabase", {
    args: ["status", "-o", "env"],
    stdout: "piped",
    stderr: "piped",
  });
  const { stdout } = await cmd.output();
  const out = new TextDecoder().decode(stdout);

  const parsed: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const match = line.match(/^(\w+)="?(.*?)"?$/);
    if (match) {
      parsed[match[1]] = match[2];
    }
  }

  const apiUrl = parsed["API_URL"];
  if (!apiUrl || !apiUrl.includes("127.0.0.1:54321")) {
    throw new Error(
      `Refusing to proceed: 'supabase status -o env' API_URL ('${apiUrl}') does not contain ` +
        "'127.0.0.1:54321'. This script must never touch anything but the local stack.",
    );
  }

  const serviceRoleKey = parsed["SERVICE_ROLE_KEY"];
  if (!serviceRoleKey) {
    throw new Error(
      "Could not parse SERVICE_ROLE_KEY out of 'supabase status -o env' output.",
    );
  }
  return serviceRoleKey;
}

const SERVICE_ROLE_KEY = await getLocalServiceRoleKey();
const AUTH_HEADERS = { Authorization: `Bearer ${SERVICE_ROLE_KEY}` };

// --- Setup helper: disposable tenant + connected tiny_credentials row ---

async function setupTenant(
  label: string,
): Promise<{ tenantId: string; accessToken: string }> {
  const [tenant] = await sql`
    insert into tenants (name)
    values (${"Products Sync Test Tenant " + label + " - quick-260802-hvz"})
    returning id
  `;
  const tenantId = tenant.id as string;

  const accessToken = `mock_at_${label}_${crypto.randomUUID()}`;

  const [{ id: clientSecretId }] = await sql`
    select vault.create_secret(
      ${"placeholder-client-secret-" + label},
      null,
      ${"quick-260802-hvz test client_secret, tenant=" + label}
    ) as id
  `;
  const [{ id: accessTokenId }] = await sql`
    select vault.create_secret(
      ${accessToken},
      null,
      ${"quick-260802-hvz test access_token, tenant=" + label}
    ) as id
  `;

  await sql`
    insert into tiny_credentials
      (tenant_id, client_id, encrypted_client_secret, encrypted_access_token,
       token_expires_at, status)
    values
      (${tenantId}, ${"mock-client-" + label}, ${clientSecretId}, ${accessTokenId},
       ${new Date(Date.now() + 3600 * 1000).toISOString()}, 'connected')
  `;

  return { tenantId, accessToken };
}

function tokenTag(accessToken: string): string {
  return accessToken.slice(-8);
}

async function callSyncEnqueue(): Promise<{ enqueued: number; tenant_ids: string[] }> {
  const res = await fetch(`${FUNCTIONS_BASE}/sync-enqueue`, {
    method: "POST",
    headers: AUTH_HEADERS,
  });
  const body = await res.json();
  if (res.status !== 200) {
    throw new Error(`sync-enqueue expected 200, got ${res.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function callSyncWorker(): Promise<{ processed: number; skipped: number; failed: number } | { processed: number; message: string }> {
  const res = await fetch(`${FUNCTIONS_BASE}/sync-worker`, {
    method: "POST",
    headers: AUTH_HEADERS,
  });
  const body = await res.json();
  if (res.status !== 200) {
    throw new Error(`sync-worker expected 200, got ${res.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function pendingQueueCountForTenant(tenantId: string): Promise<number> {
  const rows = await sql`
    select count(*)::int as n from pgmq.q_sync_work where message->>'tenant_id' = ${tenantId}
  `;
  return rows[0].n as number;
}

const testTenantIds: string[] = [];

try {
  // ============================================================
  // Step 1 — Tenant A, happy path
  // ============================================================
  console.log("\n--- Step 1: Tenant A happy path ---");

  const tenantA = await setupTenant("A");
  testTenantIds.push(tenantA.tenantId);
  const tagA = tokenTag(tenantA.accessToken);
  console.log("Created Tenant A:", tenantA.tenantId, "token tag:", tagA);

  const enqueueRes1 = await callSyncEnqueue();
  console.log("sync-enqueue response:", enqueueRes1);
  if (!enqueueRes1.tenant_ids.includes(tenantA.tenantId)) {
    throw new Error(
      `Expected Tenant A (${tenantA.tenantId}) to be enqueued (null watermark makes it pending), ` +
        `but tenant_ids was: ${JSON.stringify(enqueueRes1.tenant_ids)}`,
    );
  }
  console.log("PASSED: Tenant A was enqueued by sync-enqueue.");

  const queueCountA1 = await pendingQueueCountForTenant(tenantA.tenantId);
  if (queueCountA1 !== 1) {
    throw new Error(
      `Expected exactly 1 pending sync_work message for Tenant A, found ${queueCountA1}`,
    );
  }
  const [queuedMsgA] = await sql`
    select message->>'resource_type' as resource_type
    from pgmq.q_sync_work where message->>'tenant_id' = ${tenantA.tenantId}
  `;
  if (queuedMsgA.resource_type !== "products") {
    throw new Error(
      `Expected queued message resource_type='products', got '${queuedMsgA.resource_type}'`,
    );
  }
  console.log("PASSED: exactly one 'products' sync_work message queued for Tenant A.");

  const workerRes1 = await callSyncWorker();
  console.log("sync-worker response:", workerRes1);

  const queueCountA2 = await pendingQueueCountForTenant(tenantA.tenantId);
  if (queueCountA2 !== 0) {
    throw new Error(
      `Expected 0 remaining sync_work messages for Tenant A after sync-worker (archived, not just invisible), found ${queueCountA2}`,
    );
  }
  console.log("PASSED: Tenant A's message was archived (zero remain), not just made invisible.");

  const bronzeA = await sql`
    select payload->>'nome' as nome from raw_tiny_payloads
    where tenant_id = ${tenantA.tenantId} and resource_type = 'products'
  `;
  if (bronzeA.length === 0) {
    throw new Error("Expected at least one raw_tiny_payloads row for Tenant A, found none.");
  }
  if (!bronzeA.every((r) => String(r.nome).includes(tagA))) {
    throw new Error(
      `Expected every Tenant A bronze row's payload.nome to contain tag '${tagA}': ${JSON.stringify(bronzeA)}`,
    );
  }
  console.log(`PASSED: ${bronzeA.length} raw_tiny_payloads row(s) for Tenant A, all traceable to its own token tag.`);

  const productsA = await sql`
    select tenant_id, name from products where tenant_id = ${tenantA.tenantId}
  `;
  if (productsA.length === 0) {
    throw new Error("Expected at least one products row for Tenant A, found none.");
  }
  if (!productsA.every((r) => r.tenant_id === tenantA.tenantId && String(r.name).includes(tagA))) {
    throw new Error(
      `Expected every Tenant A products row to have tenant_id=${tenantA.tenantId} and name containing '${tagA}': ${JSON.stringify(productsA)}`,
    );
  }
  console.log(`PASSED: ${productsA.length} products row(s) for Tenant A, correct tenant_id and token tag.`);

  const [watermarkA] = await sql`
    select last_synced_at, (now() - last_synced_at) as age
    from sync_watermarks where tenant_id = ${tenantA.tenantId} and resource_type = 'products'
  `;
  if (!watermarkA || !watermarkA.last_synced_at) {
    throw new Error("Expected a non-null sync_watermarks.last_synced_at for Tenant A.");
  }
  const ageMsA = Date.now() - new Date(watermarkA.last_synced_at).getTime();
  if (ageMsA > 30 * 1000 || ageMsA < 0) {
    throw new Error(
      `Expected Tenant A's watermark to be within the last 30 seconds, age was ${ageMsA}ms`,
    );
  }
  console.log("PASSED: Tenant A's sync_watermarks.last_synced_at is non-null and fresh (<30s old).");

  // ============================================================
  // Step 2 — watermark suppression
  // ============================================================
  console.log("\n--- Step 2: watermark suppression on immediate re-enqueue ---");

  const enqueueRes2 = await callSyncEnqueue();
  console.log("sync-enqueue response (immediate re-run):", enqueueRes2);
  if (enqueueRes2.tenant_ids.includes(tenantA.tenantId)) {
    throw new Error(
      `Expected Tenant A to NOT be re-enqueued (freshly-synced watermark should suppress it), ` +
        `but tenant_ids was: ${JSON.stringify(enqueueRes2.tenant_ids)}`,
    );
  }
  console.log("PASSED: Tenant A was NOT re-enqueued (response body).");

  const queueCountA3 = await pendingQueueCountForTenant(tenantA.tenantId);
  if (queueCountA3 !== 0) {
    throw new Error(
      `Expected 0 pending sync_work messages for Tenant A after the suppressed re-enqueue, found ${queueCountA3}`,
    );
  }
  console.log("PASSED: zero sync_work messages for Tenant A in the queue, corroborating the response body.");

  // ============================================================
  // Step 3 — Tenant B, cross-tenant isolation tripwire
  // ============================================================
  console.log("\n--- Step 3: Tenant B, cross-tenant isolation tripwire ---");

  const tenantB = await setupTenant("B");
  testTenantIds.push(tenantB.tenantId);
  const tagB = tokenTag(tenantB.accessToken);
  console.log("Created Tenant B:", tenantB.tenantId, "token tag:", tagB);

  const enqueueRes3 = await callSyncEnqueue();
  console.log("sync-enqueue response:", enqueueRes3);
  if (!enqueueRes3.tenant_ids.includes(tenantB.tenantId)) {
    throw new Error(
      `Expected Tenant B to be enqueued, but tenant_ids was: ${JSON.stringify(enqueueRes3.tenant_ids)}`,
    );
  }
  if (enqueueRes3.tenant_ids.includes(tenantA.tenantId)) {
    throw new Error(
      `Expected Tenant A to still be suppressed while Tenant B enters the cycle, ` +
        `but tenant_ids was: ${JSON.stringify(enqueueRes3.tenant_ids)}`,
    );
  }
  console.log("PASSED: Tenant B was enqueued; Tenant A's suppression persisted correctly.");

  const workerRes2 = await callSyncWorker();
  console.log("sync-worker response:", workerRes2);

  // Critical isolation assertions: query BOTH tenants' products/bronze and
  // cross-check for the WRONG tag appearing anywhere.
  const productsB = await sql`
    select tenant_id, name from products where tenant_id = ${tenantB.tenantId}
  `;
  if (productsB.length === 0) {
    throw new Error("Expected at least one products row for Tenant B, found none.");
  }
  for (const row of productsB) {
    if (!String(row.name).includes(tagB)) {
      throw new Error(
        `ISOLATION FAILURE: Tenant B's products row does not contain Tenant B's own tag '${tagB}': ${JSON.stringify(row)}`,
      );
    }
    if (String(row.name).includes(tagA)) {
      throw new Error(
        `ISOLATION FAILURE: Tenant B's products row contains Tenant A's tag '${tagA}': ${JSON.stringify(row)}`,
      );
    }
  }
  console.log(`PASSED: ${productsB.length} products row(s) for Tenant B, all tagged with B's own token, none with A's.`);

  const productsARecheck = await sql`
    select tenant_id, name from products where tenant_id = ${tenantA.tenantId}
  `;
  for (const row of productsARecheck) {
    if (!String(row.name).includes(tagA)) {
      throw new Error(
        `ISOLATION FAILURE: Tenant A's products row (re-check) does not contain Tenant A's own tag '${tagA}': ${JSON.stringify(row)}`,
      );
    }
    if (String(row.name).includes(tagB)) {
      throw new Error(
        `ISOLATION FAILURE: Tenant A's products row (re-check) contains Tenant B's tag '${tagB}': ${JSON.stringify(row)}`,
      );
    }
  }
  console.log(`PASSED: Tenant A's products (re-checked) still only contain A's own tag, never B's.`);

  const bronzeB = await sql`
    select payload->>'nome' as nome from raw_tiny_payloads
    where tenant_id = ${tenantB.tenantId} and resource_type = 'products'
  `;
  if (bronzeB.length === 0) {
    throw new Error("Expected at least one raw_tiny_payloads row for Tenant B, found none.");
  }
  for (const row of bronzeB) {
    if (!String(row.nome).includes(tagB)) {
      throw new Error(
        `ISOLATION FAILURE: Tenant B's raw_tiny_payloads row does not contain Tenant B's own tag '${tagB}': ${JSON.stringify(row)}`,
      );
    }
    if (String(row.nome).includes(tagA)) {
      throw new Error(
        `ISOLATION FAILURE: Tenant B's raw_tiny_payloads row contains Tenant A's tag '${tagA}': ${JSON.stringify(row)}`,
      );
    }
  }
  console.log(`PASSED: ${bronzeB.length} raw_tiny_payloads row(s) for Tenant B, all tagged with B's own token, none with A's.`);

  const bronzeARecheck = await sql`
    select payload->>'nome' as nome from raw_tiny_payloads
    where tenant_id = ${tenantA.tenantId} and resource_type = 'products'
  `;
  for (const row of bronzeARecheck) {
    if (String(row.nome).includes(tagB)) {
      throw new Error(
        `ISOLATION FAILURE: Tenant A's raw_tiny_payloads row (re-check) contains Tenant B's tag '${tagB}': ${JSON.stringify(row)}`,
      );
    }
  }
  console.log("PASSED: Tenant A's raw_tiny_payloads (re-checked) contain no trace of Tenant B's tag.");

  console.log(
    "\nALL CHECKS PASSED: products sync pipeline proven end-to-end -- " +
      "Tenant A enqueue -> queue -> worker -> bronze/silver/watermark, " +
      "watermark suppression on immediate re-enqueue, and zero cross-tenant " +
      "contamination between Tenant A and Tenant B in either direction.",
  );
} finally {
  // --- Cleanup: remove both test tenants (cascades tiny_credentials; ---
  // --- products/sync_watermarks/raw_tiny_payloads cascade too, per Task 1) ---
  for (const tenantId of testTenantIds) {
    await sql`delete from tenants where id = ${tenantId}`;
  }
  console.log(`\nCleanup: removed ${testTenantIds.length} test tenant(s) and associated rows.`);
  await sql.end();
}
