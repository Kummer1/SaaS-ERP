# Phase 1: Infrastructure & Connection Foundation - Context

**Gathered:** 2026-07-28
**Status:** Ready for planning

<domain>
## Phase Boundary

The backend's core infrastructure works end-to-end in production before any feature code exists: backend deployed and reachable, connected to Supabase Postgres through a verified driver/connection method, database schema migrations working, and the periodic sync trigger mechanism configured. This phase resolves the "Hosting do backend" decision that was left `Pending` in PROJECT.md's Key Decisions table.

</domain>

<decisions>
## Implementation Decisions

### Backend Runtime & Hosting (major pivot from original docs)
- **D-01:** Backend is written in **TypeScript/JavaScript running on Supabase Edge Functions (Deno runtime)** — replaces the originally planned Python 3.12 + FastAPI + SQLAlchemy + Alembic stack entirely. — **Reversibility:** one-way — Phases 2-4 (Auth middleware, Tiny OAuth2 + sync engine, dashboard API) all get built as Deno/TS Edge Functions on top of this; reversing after those phases execute means discarding and rewriting the entire backend, not just infra config.
- **D-02:** Hosting split: **Supabase** hosts Postgres + Auth + Backend (Edge Functions). **Vercel** hosts only the frontend (React/Vite) — unchanged from the original plan. **Render is removed from the architecture entirely.** — **Reversibility:** one-way — same rationale as D-01; the two decisions are coupled (Edge Functions only run on Supabase's Deno runtime).
- **User's stated reasoning:** wants to consolidate onto Supabase (DB + Auth + Backend + available Realtime) instead of a separate Render process, to avoid Render free-tier's 15-min sleep / 30-60s cold-start problem. Confirmed comfortable with JavaScript/TypeScript instead of Python for the backend, conditioned on the result being robust — see verification notes below.
- **Verification done during discussion (not a substitute for phase research, but ruled out the Vercel-Python alternative):**
  - Supabase Edge Functions run on **Deno (TypeScript/JavaScript)**, not Python — there is no native Python Edge Function runtime today.
  - Free tier: 500,000 invocations/month (ample for a 15-30 min sync cadence), background tasks capped at **150 seconds** per invocation (400s on paid), CPU time cap (2s) excludes async I/O wait — fine for HTTP-bound Tiny ERP calls.
  - **Vercel Python Functions were considered and rejected**: Hobby (free) tier caps function execution at **10 seconds** and cron jobs at **once per day** — incompatible with `SYNC-02`'s 15-30 min sync cadence requirement. Documented here so research/planning doesn't re-litigate this option.
  - Sources checked: supabase.com/docs/guides/functions/limits, supabase.com/blog/edge-functions-background-tasks-websockets, vercel.com/docs/functions/configuring-functions/duration, vercel.com/docs/cron-jobs.

### Sync Execution Model
- **D-03:** The periodic product sync must be **designed in batches/pages per invocation** (not one long-running loop) so each Edge Function call fits inside the 150-second free-tier background task ceiling, regardless of tenant catalog size. — **Reversibility:** costly — affects the Phase 3 sync engine's core control flow (batch cursor / continuation state); redesigning after Phase 3 ships means reworking the sync loop and its idempotency/resume logic.

### Scheduler
- **D-04:** Use **Supabase Cron (pg_cron/pg_net)**, running inside the Supabase Postgres instance, to invoke the sync Edge Function on a schedule — replaces the originally planned in-process APScheduler (which required a persistent Python process). — **Reversibility:** reversible — swapping the trigger mechanism (e.g., to an external cron service) later doesn't require touching the sync function's own logic, only how it's invoked.

### Realtime (Supabase)
- **D-05:** Supabase Realtime is **not used in this phase or the MVP**. The user noticed it's available but is not requesting it now. `REQUIREMENTS.md`'s existing Out-of-Scope entry ("Real-time via websocket") stays as-is — webhook + polling remains the sync-freshness mechanism.

### Claude's Discretion
- **Migration tooling:** Alembic was Python-specific and no longer fits a TypeScript/Deno backend. Research/planning should choose a replacement (e.g., Supabase CLI's native `supabase migration` SQL-based workflow is the most natural fit for this stack, but confirm during research).
- **Postgres driver/connection method from Deno Edge Functions:** must be re-verified against Supabase's pooler guidance for the new runtime. This is the same bug class that caused a production incident in the prior `tinysaas` project (commit `55b0f80`) — the specific driver changes (no more psycopg3), but the underlying pooler-username/connection-string risk (`docs` warn against reconstructing `DATABASE_URL` from parts) still applies and must be re-validated for whatever Deno Postgres client is chosen.
- **Health-check shape:** the exact form of "backend responds to a health-check request" (ROADMAP success criterion) is unchanged in intent, just needs re-expressing as an Edge Function endpoint instead of a FastAPI route — implementation detail for planning.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Superseded by this discussion (read with caution)
- `docs/01-ARQUITETURA.md` — backend language/framework/hosting sections (Python/FastAPI/Render) are **superseded** by D-01/D-02 above. Data model, multi-tenancy (RLS), and Tiny ERP integration sections remain valid.
- `docs/04-INFRAESTRUTURA-DEPLOY.md` — Render-specific deployment guidance is **superseded**. Supabase/Vercel-specific deployment sections remain relevant where not Render-dependent.
- `.claude/CLAUDE.md` — the "Technology Stack" table (FastAPI, SQLAlchemy, Alembic, psycopg, APScheduler, Render) reflects the **pre-pivot** research and is now stale for the backend runtime. It should be refreshed after Phase 1 research/planning confirms the new stack's specifics (recommended follow-up, not part of this phase's plan itself).

### Still authoritative
- `.planning/PROJECT.md` — Key Decisions table row "Hosting do backend a decidir na fase de infraestrutura" is resolved by D-01/D-02 (was `Pending`).
- `.planning/REQUIREMENTS.md` — `SYNC-02` (15-30 min sync cadence) is the hard constraint that ruled out Vercel Python Functions; "Real-time via websocket" Out-of-Scope entry stays valid per D-05.
- `docs/02-MODELO-DE-DADOS.md`, `docs/03-INTEGRACAO-TINY-ERP.md` — unaffected by this pivot (data model, Tiny API facts).

**No external specs beyond project docs** — all other decisions captured above.

</canonical_refs>

<code_context>
## Existing Code Insights

Greenfield phase — no code exists yet in this repository (confirmed via PROJECT.md: "Nenhum código foi escrito ainda"). No reusable assets, patterns, or integration points to note.

</code_context>

<specifics>
## Specific Ideas

- User explicitly wants the resulting backend to be **robust**, not just cheap — the JS/TS pivot was accepted only after confirming it can meet the sync cadence and reliability bar, not purely for cost reasons.
- **Action item for the user (not part of this phase's plan):** ROADMAP.md's Phase 1 success criteria still literally reference Render ("wakes Render's sleeping free-tier dyno") and implicitly Alembic. Recommend running `/gsd-phase --edit 1` to reword these criteria to match D-01/D-02 before/while planning, so the plan-checker and verifier aren't checking for a Render deployment that no longer exists.
- Model routing note (workflow config, not a project decision): `model_overrides.gsd-planner` was set to `sonnet` in `.planning/config.json` per user request (avoid Opus for planning).

</specifics>

<deferred>
## Deferred Ideas

- **Supabase Realtime for the dashboard** — user mentioned awareness of this feature; not requested for MVP. If wanted later, it belongs in Phase 4 (Dashboard) scope discussion, and would require revisiting `REQUIREMENTS.md`'s current Out-of-Scope entry for real-time/websocket.

### Reviewed Todos (not folded)
None — discussion stayed within phase scope.

</deferred>

---

*Phase: 1-infrastructure-connection-foundation*
*Context gathered: 2026-07-28*
