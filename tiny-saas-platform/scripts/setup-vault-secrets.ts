// Idempotent, secret-free Supabase Vault setup script.
//
// Run: deno run --allow-net --allow-env scripts/setup-vault-secrets.ts
//
// Populates two Supabase Vault secrets used by the cron_sync_trigger
// migration's net.http_post call:
//   - project_url       -> this project's own base URL
//   - edge_function_key -> the Authorization bearer used to invoke
//                           Edge Functions from pg_net
//
// CRITICAL: this file must never contain a literal secret value, URL, or
// JWT. Both values are read exclusively from Deno.env.get() at runtime
// (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) and are never echoed to
// stdout/logs — per 01-RESEARCH.md Pitfall 4 (never hardcode the Edge
// Function URL/API key in a committed migration or script).
//
// Connection discipline matches supabase/functions/_shared/db.ts: reads
// DATABASE_URL/SUPABASE_DB_URL as one opaque string (Transaction Pooler,
// port 6543), never reconstructed from parts, { prepare: false }.
//
// Idempotency: for each secret name, checks whether a row already exists
// in vault.decrypted_secrets before calling vault.create_secret(), so
// re-running this script sequentially never creates duplicate secrets.
//
// NOT SAFE FOR CONCURRENT EXECUTION: the check-then-insert in ensureSecret()
// below is not atomic (no transaction/locking). If two invocations of this
// script ever run at the same time (e.g. two CI jobs, or a retry racing the
// first attempt), both can pass the "does it exist" check before either
// inserts, producing duplicate project_url/edge_function_key secrets. The
// cron migration's net.http_post call reads
// `(select decrypted_secret from vault.decrypted_secrets where name = ...)`
// with no `limit 1`/ordering, so a duplicate makes which value is picked
// non-deterministic. This is a manual, one-time setup script — run it by
// hand, one invocation at a time, and never wire it into a job that could
// execute it in parallel with itself.
import postgres from "npm:postgres@3.4.9";

const connectionString =
  Deno.env.get("DATABASE_URL") ?? Deno.env.get("SUPABASE_DB_URL");
if (!connectionString) {
  throw new Error(
    "DATABASE_URL or SUPABASE_DB_URL environment variable is required and unset",
  );
}

const projectUrl = Deno.env.get("SUPABASE_URL");
const edgeFunctionKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!projectUrl) {
  throw new Error("SUPABASE_URL environment variable is required and unset");
}
if (!edgeFunctionKey) {
  throw new Error(
    "SUPABASE_SERVICE_ROLE_KEY environment variable is required and unset",
  );
}

const sql = postgres(connectionString, { prepare: false });

// Not atomic — see the "NOT SAFE FOR CONCURRENT EXECUTION" note at the top
// of this file. Do not call this from more than one concurrent process.
async function ensureSecret(name: string, value: string): Promise<void> {
  const existing = await sql`
    select 1 from vault.decrypted_secrets where name = ${name}
  `;
  if (existing.length > 0) {
    console.log(`vault secret "${name}" already exists, skipping`);
    return;
  }
  await sql`select vault.create_secret(${value}, ${name})`;
  console.log(`vault secret "${name}" created`);
}

await ensureSecret("project_url", projectUrl);
await ensureSecret("edge_function_key", edgeFunctionKey);

const rows = await sql`
  select name from vault.decrypted_secrets
  where name in ('project_url', 'edge_function_key')
  order by name
`;
console.log(
  `confirmed ${rows.length} vault secret(s) present: ${
    rows.map((r) => r.name).join(", ")
  }`,
);
if (rows.length !== 2) {
  throw new Error(
    `expected 2 vault secrets (project_url, edge_function_key), found ${rows.length}`,
  );
}

await sql.end();
