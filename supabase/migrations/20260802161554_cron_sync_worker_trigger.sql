-- Quick task 260802-hvz: second, independent pg_cron job for the real
-- sync-worker consumer, decoupled from the existing 15-min
-- sync-enqueue-trigger (20260729231615_cron_sync_trigger.sql, NOT modified
-- by this migration). Every 3 minutes -- inside the brief's 2-5 min range --
-- so a crashed sync_work message (60s pgmq_public.read visibility timeout,
-- see sync-worker/index.ts) becomes retryable well before the next
-- scheduled tick.
--
-- Reuses the SAME vault.decrypted_secrets lookups by name (project_url,
-- edge_function_key) already created by scripts/setup-vault-secrets.ts and
-- already used by sync-enqueue-trigger -- no new Vault secrets created here.
--
-- Known, informational-only risk carried over unchanged from the sibling
-- enqueue job: pg_net's default net.http_post timeout (5000ms) can fire
-- client-side before a cold-started Edge Function responds, even though the
-- call succeeds server-side -- already logged as an open .planning/WINDOWS.md
-- deviation for sync-enqueue-trigger. Not fixed in this migration, out of
-- this plan's scope.

select cron.schedule(
  'sync-worker-trigger',
  '*/3 * * * *', -- every 3 min; inside SYNC-01's 2-5 min range, independent of sync-enqueue-trigger's 15 min
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/sync-worker',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'edge_function_key')
    ),
    body := '{}'::jsonb
  ) as request_id;
  $$
);
