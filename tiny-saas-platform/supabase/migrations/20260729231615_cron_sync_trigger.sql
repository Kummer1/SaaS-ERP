-- Wires the trigger + queue halves of the Cron + Queue + Edge Function sync
-- pipeline (01-CONTEXT.md D-03/D-04). Creates the `sync_work` pgmq queue and
-- schedules a pg_cron job that invokes the (not-yet-built) `sync-enqueue`
-- Edge Function every 15 minutes.
--
-- CRITICAL: the net.http_post call below sources its URL and Authorization
-- header EXCLUSIVELY from vault.decrypted_secrets lookups (project_url,
-- edge_function_key — populated by scripts/setup-vault-secrets.ts). No
-- literal URL or key value appears anywhere in this file — see
-- 01-RESEARCH.md Pitfall 4 (hardcoding secrets in a committed migration).

select pgmq.create('sync_work');

select cron.schedule(
  'sync-enqueue-trigger',
  '*/15 * * * *', -- every 15 min; low end of SYNC-02's 15-30 min range
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/sync-enqueue',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'edge_function_key')
    ),
    body := '{}'::jsonb
  ) as request_id;
  $$
);
