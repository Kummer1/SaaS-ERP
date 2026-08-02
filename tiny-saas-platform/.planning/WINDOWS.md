---
schema_version: 1
open_count: 1
waived_count: 0
fixed_count: 0
total_count: 1
last_updated: 2026-07-29T23:33:37.440Z
---

# Broken Windows Ledger

> Cross-phase defect register. `/gsd-ship` blocks while `open_count > 0`.
> Waive with `gsd-tools windows waive <id> "<reason>"` (reason required).
> Mark fixed with `gsd-tools windows fixed <id>`.

| id | phase | kind | file | line | description | status | reason | recorded_at | resolved_at |
|----|-------|------|------|------|-------------|--------|--------|-------------|-------------|
| 1 | 01 | deviation | supabase/migrations/20260729231615_cron_sync_trigger.sql |  | pg_net's net.http_post call in the sync-enqueue-trigger cron job times out client-side after its default 5000ms wait (net._http_response shows timed_out:true), likely because Edge Function cold-starts occasionally exceed that window; the enqueue itself still appears to succeed server-side (queue depth increased on the same unattended run), but the cron job's own response tracking cannot confirm success. Phase 3 should consider passing a longer timeout_milliseconds to net.http_post or adding cold-start-tolerant retry/monitoring. | open |  | 2026-07-29T23:33:37.440Z |  |

````json
[
  {
    "id": 1,
    "kind": "deviation",
    "phase": "01",
    "file": "supabase/migrations/20260729231615_cron_sync_trigger.sql",
    "line": null,
    "description": "pg_net's net.http_post call in the sync-enqueue-trigger cron job times out client-side after its default 5000ms wait (net._http_response shows timed_out:true), likely because Edge Function cold-starts occasionally exceed that window; the enqueue itself still appears to succeed server-side (queue depth increased on the same unattended run), but the cron job's own response tracking cannot confirm success. Phase 3 should consider passing a longer timeout_milliseconds to net.http_post or adding cold-start-tolerant retry/monitoring.",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-07-29T23:33:37.440Z",
    "resolved_at": null
  }
]
````
