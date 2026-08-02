# Walking Skeleton — Tiny SaaS Platform

**Phase:** 1
**Generated:** 2026-07-28

## Capability Proven End-to-End

A publicly reachable Supabase Edge Function confirms live Postgres connectivity via the exact
Transaction Pooler configuration production will use, and a scheduled `pg_cron` job drives a
message through an Edge-Function-produced Supabase Queue to an Edge-Function-consumed worker —
proving the full infrastructure pipeline (routing, DB, and background-job orchestration) works
end-to-end before any feature code exists.

## Architectural Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Backend runtime | TypeScript/JavaScript on Supabase Edge Functions (Deno) | D-01 — no native Python Edge Function runtime exists; free tier (500k invocations/mo, 150s bg-task cap) fits the sync cadence; Vercel Python Functions rejected (10s exec cap, once-daily cron) |
| Hosting split | Supabase hosts Postgres + Auth + Backend; Vercel hosts frontend only (Phase 4); Render removed entirely | D-02 — consolidates onto one platform to avoid Render free-tier's 15-min sleep / 30-60s cold start |
| Postgres connection | Transaction Pooler (port 6543, `postgres.<project-ref>` user) + `postgres.js` (`npm:postgres@3.4.9`) constructed with `{ prepare: false }` | Edge Functions are short-lived/serverless — Supabase's own docs recommend Transaction Pooler for this workload shape; this *reverses* the old Session-Pooler-for-Render research (01-RESEARCH.md Pitfall 1). `prepare:false` avoids the prepared-statement/pooler bug class that broke the prior `tinysaas` project (commit `55b0f80`) |
| Auth | Deferred to Phase 2 (Supabase Auth) | Phase 1 is infra-only; the one public endpoint (`/health`) is intentionally unauthenticated (`verify_jwt=false`), everything else stays JWT-protected by default |
| Migration tooling | Supabase CLI native SQL migrations (`supabase migration new` / `supabase db push`) | Alembic was Python-specific and no longer fits; the CLI-native workflow needs zero extra dependencies and matches a project with no ORM in this runtime |
| Scheduler | Supabase Cron (`pg_cron` + `pg_net`) | D-04 — replaces the originally planned in-process APScheduler; runs inside Postgres itself, no persistent process required |
| Work queue | Supabase Queues (`pgmq`) | D-03 — Supabase's own documented reference architecture (Cron + Edge Function + Queue) for chunked background jobs under the 2s CPU / 150-400s wall-clock caps |
| Directory layout | `supabase/functions/*`, `supabase/migrations/*`, `tests/*`, `scripts/*`, `.github/workflows/*` | Supabase CLI's native project layout; plain SQL migrations, no ORM |

## Stack Touched in Phase 1

> Adapted for this project: Phase 1 is deliberately backend-infrastructure-only. There is no UI
> checkbox here — see "Out of Scope" below for why that is by design, not an oversight.

- [ ] Project scaffold — Supabase CLI init, Deno runtime, root `deno.jsonc` test/lint task config
- [ ] Routing — `health` Edge Function reachable at its public URL (`GET /functions/v1/health`, `verify_jwt=false`)
- [ ] Database — one real read (`select 1` health ping + CI smoke test) AND one real write (schema migration DDL: extensions + `pgmq` queue table, applied via `supabase db push`)
- [ ] Cron → Queue → Worker pipeline — `pg_cron` triggers `sync-enqueue` (producer), which publishes to a `pgmq` queue drained by `sync-worker` (consumer), proven with a real message round-trip
- [ ] Deployment — functions deployed to the real Supabase project via `supabase functions deploy`; migrations pushed via `supabase db push`; a GitHub Actions CI smoke test validates the same production-shape connection path

## Out of Scope (Deferred to Later Slices)

- **UI / dashboard** — deliberately deferred to Phase 4 by roadmap design (see `STATE.md`: "Phase 1 (Infrastructure) carries zero direct requirement mappings by design"). This phase is backend-infrastructure-only; there is no frontend code, route, or interactive element in Phase 1.
- **User authentication / Supabase Auth wiring** — Phase 2.
- **Tenant isolation / Postgres RLS** — Phase 2 (no tenant-scoped tables exist yet; `docs/sql/rls_policies.example.sql` is a convention reference only, not applied this phase).
- **Tiny ERP OAuth2 + real product sync logic** — Phase 3. This phase's `sync-enqueue`/`sync-worker` carry only a placeholder `{kind:"ping"}` message proving the pipeline mechanism, per D-03.
- **Supabase Realtime** — explicitly deferred per D-05; not requested for the MVP.
- **Vercel frontend deployment** — Phase 4 scaffolds the frontend; Phase 1 touches Supabase only.

## Subsequent Slice Plan

- Phase 2: Users sign up/log in via Supabase Auth; `tenant_id` + Postgres RLS enforced and validated by a cross-tenant access test.
- Phase 3: Tenant connects their Tiny ERP account via OAuth2; real product-sync logic replaces the placeholder ping message inside the Cron/Queue pipeline built here.
- Phase 4: Dashboard renders synced products, total stock value, low-stock indicator, and sync health.
