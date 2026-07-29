// Shared test fixtures for this project's Deno test suite.
//
// getTestSql() mirrors supabase/functions/_shared/db.ts's exact client
// construction (same env var lookup, same { prepare: false } Transaction
// Pooler discipline) so tests exercise the identical connection contract the
// deployed Edge Functions use — not a substitute/simplified client.
import postgres from "npm:postgres@3.4.9";

export function getTestSql() {
  const connectionString =
    Deno.env.get("DATABASE_URL") ?? Deno.env.get("SUPABASE_DB_URL")!;
  return postgres(connectionString, { prepare: false });
}

/** Public URL of the deployed health Edge Function, derived from env vars. */
export function getHealthUrl(): string {
  const explicit = Deno.env.get("HEALTH_URL");
  if (explicit) return explicit;
  const ref = Deno.env.get("SUPABASE_PROJECT_REF");
  if (!ref) {
    throw new Error(
      "Set HEALTH_URL or SUPABASE_PROJECT_REF to locate the deployed health function",
    );
  }
  return `https://${ref}.supabase.co/functions/v1/health`;
}
