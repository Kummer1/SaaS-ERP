-- Quick task 260802-hvz: the Phase 3 pgmq_public.read + archive swap that
-- 01-04-SUMMARY.md explicitly flagged as required (crash-safe, at-least-once
-- processing for SYNC-01). Phase 1's sync-worker used pgmq_public.pop
-- (delete-on-read, at-most-once) to prove the pipeline mechanism with a
-- placeholder message; a crashed worker mid-batch would silently drop
-- in-flight work under pop. read + explicit archive keeps a message claimable
-- (behind a visibility timeout) until this worker explicitly archives it,
-- so a crash before archiving lets the next invocation safely retry.
--
-- Adds to the EXISTING pgmq_public schema (created in
-- 20260729232533_pgmq_public_wrappers.sql) -- does not recreate the schema
-- or its `grant usage`. pgmq_public's existing PostgREST exposure
-- (supabase/config.toml [api] schemas) needs no further change since the
-- schema is already listed there.
create or replace function pgmq_public.read(
  queue_name text,
  vt integer,
  qty integer
)
returns setof pgmq.message_record
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query select * from pgmq.read(queue_name, vt, qty);
end;
$$;

create or replace function pgmq_public.archive(
  queue_name text,
  msg_id bigint
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  return pgmq.archive(queue_name, msg_id);
end;
$$;

revoke all on function pgmq_public.read(text, integer, integer) from public;
revoke all on function pgmq_public.archive(text, bigint) from public;
grant execute on function pgmq_public.read(text, integer, integer) to service_role;
grant execute on function pgmq_public.archive(text, bigint) to service_role;
