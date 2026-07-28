# Phase 1: Infrastructure & Connection Foundation - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-07-28
**Phase:** 1-infrastructure-connection-foundation
**Areas discussed:** Backend hosting/runtime, Sync execution model, Scheduler mechanism, Realtime usage

---

## Backend Hosting & Runtime

User opened the discussion with a freeform proposal (not from a menu): use Supabase to host DB + Auth + Backend (noting Supabase's Python/Realtime capabilities), keep Vercel for hosting (frontend). This directly resolves PROJECT.md's `Pending` "Hosting do backend" decision.

| Option | Description | Selected |
|--------|-------------|----------|
| Sim, exatamente isso (Supabase = DB+Auth+Backend, Vercel = frontend only, Render removed) | User's initial framing | ✓ |
| Sim, mas mantenho Render como fallback | Keep Render documented as plan B | |
| Deixa eu explicar melhor | Freeform clarification | |

Follow-up: whether "Functions em Python" on Supabase was confirmed. User's actual answer diverged from the original multiple-choice — user said no problem being JavaScript, as long as it's robust, and asked Claude to verify feasibility.

**Claude researched (WebSearch):** Supabase Edge Functions run on Deno (TS/JS only, no native Python). Free tier: 500k invocations/month, 150s background-task cap, 2s CPU-time cap excluding I/O wait. Also researched the user's follow-up alternative ("host backend on Vercel with Python") — found Vercel Hobby tier caps function execution at 10s and cron at once/day, incompatible with the 15-30 min sync cadence requirement (SYNC-02).

| Option | Description | Selected |
|--------|-------------|----------|
| Render + Python/FastAPI (plano original) | Keeps original stack; Render sleep/cold-start problem remains | |
| Supabase Edge Functions + TypeScript | Eliminates Render sleep problem; full backend rewrite in TS/Deno | ✓ |
| Vercel Functions + Python | Rejected — free tier cron (1x/day) and timeout (10s) break SYNC-02 | |

**User's choice:** Supabase Edge Functions + TypeScript/JavaScript, backend hosted entirely within Supabase; Vercel stays frontend-only.
**Notes:** User's bar was explicitly "robustness" over cost — confirmed comfortable with the language change only after Claude verified execution/timeout/cron limits against the actual sync-cadence requirement.

---

## Sync Execution Model

| Option | Description | Selected |
|--------|-------------|----------|
| Paginar o sync em lotes menores | Batch/paginate each invocation to fit the 150s free-tier ceiling | ✓ |
| Deixa a pesquisa/planejamento decidir o desenho exato | Defer exact design to later phases | |

**User's choice:** Paginate/batch the sync so it fits inside the 150-second background-task limit regardless of catalog size.

---

## Scheduler

| Option | Description | Selected |
|--------|-------------|----------|
| Supabase Cron (pg_cron) disparando a function | Native Postgres-based scheduler, no persistent process | ✓ |
| Deixa a pesquisa validar a melhor opção | Defer exact mechanism to research | |

**User's choice:** Supabase Cron (pg_cron/pg_net) triggers the sync Edge Function on schedule — replaces the originally planned in-process APScheduler.

---

## Realtime (Supabase)

| Option | Description | Selected |
|--------|-------------|----------|
| Só observação, não precisa usar agora | Keep webhook + polling as already decided; Realtime unused in MVP | ✓ |
| Quero registrar como ideia pra Fase 4 | Log as a deferred idea for the Dashboard phase | |

**User's choice:** Not used in MVP — was just an observation, not a request. Logged as a deferred idea anyway (low-cost to preserve).

---

## Claude's Discretion

- Migration tooling to replace Alembic (Python-specific) — candidate: Supabase CLI native migrations, to confirm during research.
- Postgres driver/connection method from Deno Edge Functions, and re-validation of pooler/connection-string risk (same bug class as the prior `tinysaas` production incident, commit `55b0f80`) under the new runtime.
- Exact shape of the "backend health-check" success criterion re-expressed as an Edge Function endpoint.

## Deferred Ideas

- Supabase Realtime for the dashboard (Phase 4) — user only noted awareness, did not request it; would require revisiting REQUIREMENTS.md's Out-of-Scope entry for real-time/websocket if pursued later.
- ROADMAP.md's Phase 1 success criteria still reference Render/Alembic literally — flagged in CONTEXT.md as a recommended `/gsd-phase --edit 1` follow-up (not part of this discussion's scope to change).
