-- Creates the `pgmq_public` PostgREST-exposed wrapper schema for the two
-- pgmq operations this plan's Edge Functions need (send, pop).
--
-- Context: 01-RESEARCH.md and this plan's own PATTERNS.md assumed
-- `pgmq_public` already existed as Supabase's standard "Expose Queues via
-- PostgREST" dashboard feature. This project provisioned pgmq via a raw
-- `create extension pgmq` migration (20260729225411, plan 01-02) without
-- ever using that dashboard toggle, so `pgmq_public` never actually existed
-- on this project - confirmed via a direct pg_namespace query returning only
-- `pgmq`, never `pgmq_public`. Calling `supabase.schema("pgmq_public")` from
-- either Edge Function failed with PostgREST error PGRST106 ("Invalid
-- schema: pgmq_public. Only the following schemas are exposed: public,
-- graphql_public").
--
-- This migration reproduces the minimal slice of Supabase's own documented
-- wrapper pattern (SECURITY DEFINER functions delegating to `pgmq.*`,
-- scoped to only `send`/`pop` since that's all this plan's producer/consumer
-- functions and round-trip test exercise). Grants are service_role-only -
-- these Edge Functions authenticate exclusively with the service-role key
-- (never anon/authenticated), matching threat T-04-01/T-04-02's mitigation.
create schema if not exists pgmq_public;

-- PostgREST's `authenticator` role SET ROLEs to `service_role` per-request but
-- still needs explicit schema-level USAGE - EXECUTE grants on the functions
-- alone are not sufficient (confirmed via a direct RPC call returning
-- `42501 permission denied for schema pgmq_public` before this grant existed).
grant usage on schema pgmq_public to service_role;

create or replace function pgmq_public.send(
  queue_name text,
  message jsonb
)
returns setof bigint
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query select * from pgmq.send(queue_name, message);
end;
$$;

create or replace function pgmq_public.pop(
  queue_name text
)
returns setof pgmq.message_record
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query select * from pgmq.pop(queue_name);
end;
$$;

revoke all on function pgmq_public.send(text, jsonb) from public;
revoke all on function pgmq_public.pop(text) from public;
grant execute on function pgmq_public.send(text, jsonb) to service_role;
grant execute on function pgmq_public.pop(text) to service_role;
