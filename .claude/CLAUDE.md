<!-- GSD:project-start source:PROJECT.md -->

## Project

**Tiny SaaS Platform**

SaaS multi-tenant que se conecta à conta Tiny ERP (Olist) de cada cliente, sincroniza
clientes, produtos/estoque e pedidos para um banco de dados próprio, e expõe essa
informação via dashboard web (KPIs de vendas, estoque, clientes). Pensado para ser
oferecido a múltiplas empresas que usam Tiny ERP, cada uma conectando sua própria conta.

**Core Value:** Um tenant consegue conectar sua conta Tiny ERP e ver, no dashboard, um recurso
sincronizado corretamente e de forma confiável. Provar que o motor de sincronização
funciona ponta a ponta é o que valida o produto — antes de expandir recursos ou
escalar para múltiplos tenants.

### Constraints

- **Custo**: infraestrutura do MVP deve rodar em camadas gratuitas (Supabase free tier, backend em Render/Fly.io free tier, frontend no Vercel free tier) — é requisito, não só preferência
- **Tech stack**: Python 3.12 + FastAPI + SQLAlchemy 2.0 (async) + Alembic; PostgreSQL gerenciado pelo Supabase; React 18 + TypeScript + Vite no frontend — conforme `docs/01-ARQUITETURA.md`
- **Auth**: Supabase Auth para autenticação de usuários (substitui o JWT customizado original dos docs)
- **Sync engine (MVP)**: sem Celery/Redis — scheduler in-process + endpoint de webhook, para reduzir custo e complexidade
- **Timeline**: sem prazo fixo — prioridade é fazer certo, não rápido
- **Estágio comercial**: especulativo — sem cliente confirmado ainda; construção precede validação

<!-- GSD:project-end -->

<!-- GSD:stack-start source:research/STACK.md -->

## Technology Stack

## Recommended Stack

### Core Technologies

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| Python | 3.12 | Runtime | Unchanged from docs. Current, fast, typing-friendly. |
| FastAPI | 0.14x line (pin latest 0.1xx at install; verified current = 0.140.7) | API framework | Unchanged from docs — async-native, OpenAPI free, fits I/O-bound ERP-polling workload. |
| SQLAlchemy | 2.0.5x (verified current = 2.0.51) | ORM + async engine | Unchanged from docs. 2.0's async engine (`create_async_engine`) is what actually talks to Supabase. |
| Alembic | 1.18.x | Migrations | Unchanged from docs. Runs migrations with a **sync** driver against the same pooler — see Gotcha #1 below. |
| **psycopg (v3), async mode** | 3.3.x | Postgres driver for the async SQLAlchemy engine | **New recommendation, replaces asyncpg as primary driver.** asyncpg has a well-documented, currently-open incompatibility with PgBouncer/Supavisor's transaction-mode prepared-statement handling (see Gotcha #2). psycopg3's async driver works cleanly through Supabase's pooler and is SQLAlchemy 2.0's other first-class async dialect (`postgresql+psycopg://`). Confidence: HIGH (multiple independent 2026 sources converge on this). |
| Supabase (managed Postgres 16 + Supabase Auth) | Platform, N/A | DB + user authentication | Confirmed pivot. Free tier covers a single-tenant MVP; Auth removes the need to hand-roll password storage/reset flows. |
| PyJWT + `PyJWKClient` | PyJWT 2.13.x | Verify Supabase Auth JWTs in FastAPI | Supabase issues asymmetric (ES256, moving off legacy HS256) JWTs with a `kid` header, verifiable locally against Supabase's JWKS endpoint. PyJWT is the actively-maintained library for this (`python-jose` is effectively unmaintained — see What NOT to Use). Confidence: HIGH. |
| APScheduler (`AsyncIOScheduler`) | 3.11.x (stable; v4 is still alpha, do not use) | In-process periodic Tiny ERP polling (15–30 min) | Confirmed pivot away from Celery+beat. Runs an asyncio-native scheduler inside the same FastAPI process — no separate worker, no Redis. Confidence: HIGH. |
| React 18 + TypeScript + Vite | current | Frontend SPA | Unchanged from docs. |

### Supporting Libraries

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `python-dotenv` | current | Local env loading | Dev only; production env vars come from Render/Vercel dashboards. |
| `httpx` (async) | current | Outbound calls to Tiny ERP API | Already implied by "async I/O-bound" framing in docs; use with retry/backoff for 429s. |
| `tenacity` | current | Retry/backoff wrapper | Wrap Tiny ERP calls — respects `Retry-After` per `03-INTEGRACAO-TINY-ERP.md`. |
| `cryptography` (Fernet) | current | Encrypt Tiny OAuth tokens at rest | Unchanged from prior project (`tinysaas`) and current docs — keep this pattern. |
| `alembic` sync driver: `psycopg` (v3, sync mode) or `psycopg2-binary` | 3.3.x / 2.9.x | Alembic migrations | Alembic's `env.py` runs synchronously; reuse psycopg3 in sync mode so you have one driver family, not two. |

### Development Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| `ruff` | Lint | Already referenced in `04-INFRAESTRUTURA-DEPLOY.md` CI plan. |
| `pytest` + `pytest-asyncio` | Tests | Standard for async FastAPI. |
| Supabase CLI (local) | Local Postgres for dev | Optional — a plain local Postgres container also works and avoids depending on Supabase's local stack matching prod exactly. |

## Installation

# Core

# Postgres driver (async, for the app) + sync (for Alembic) — same package

# Auth

# Scheduler

# Tiny ERP client + resiliency

# Dev

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| psycopg3 (async) | asyncpg + `statement_cache_size=0` | Only if you benchmark and need asyncpg's raw throughput edge; you must then disable prepared-statement caching explicitly (`connect_args={"statement_cache_size": 0, "prepared_statement_cache_size": 0}`) and still confirm SQLAlchemy 2.0 actually honors it — GitHub issue supabase/supabase#39227 shows it still leaks prepared statements under burst load even with the flag set. Not worth the risk for an MVP. |
| Supabase **Session Pooler** (port 5432 via pooler host) | Supabase **Transaction Pooler** (port 6543) | Transaction mode is for serverless/edge functions that open/close connections per-invocation. Render/Fly host a single long-lived process — session mode is the documented fit and sidesteps the prepared-statement class of bugs entirely (see Gotcha #2). Only reconsider transaction mode if you later run multiple short-lived worker instances. |
| APScheduler `AsyncIOScheduler` (single process) | APScheduler with `SQLAlchemyJobStore`, or dedicated scheduler process | If you ever run more than one backend instance (e.g., scale Render beyond one dyno), an in-memory `AsyncIOScheduler` inside each web process will run the poll job N times. Not a concern at MVP (1 instance), but flag before scaling backend replicas. |
| PyJWT + JWKS | Supabase Python SDK's built-in `get_user()` | The SDK call round-trips to Supabase's Auth server on every request (extra latency, extra dependency on Auth uptime). Local JWKS verification is faster and is what Supabase's own docs now recommend for backend services. |
| Render free tier | Fly.io free allowance | **Fly.io no longer has a free tier for new accounts as of 2026** (removed in 2024; new signups get a $5 / 7-day trial only, then pay-as-you-go, ~$1.94/mo minimum for a tiny always-on machine). This invalidates the "Fly.io as free alternative" assumption in `PROJECT.md`/original docs — treat Fly.io as a **cheap paid option** (~$2–5/mo), not a free one, if you outgrow Render's free tier. |

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `python-jose` for JWT verification | Effectively unmaintained; more open security advisories than PyJWT (including a JWE decompression-bomb DoS); Supabase docs/community have moved to PyJWT + JWKS. | PyJWT + `PyJWKClient` |
| Building `DATABASE_URL` from separate `DB_HOST` + `DB_PASSWORD` env vars with a hardcoded `postgres` username | **This is the exact class of bug the prior `tinysaas` project hit** (commit `55b0f80`, "suporta DATABASE_URL completa para compatibilidade com Render/Supabase pooler"). Supabase's pooler requires the username `postgres.<project-ref>` (not bare `postgres`), and Render injects its own `DATABASE_URL` with a `postgres://` scheme that neither `psycopg`/`asyncpg`/SQLAlchemy accept directly. Reconstructing the URL from parts silently drops the pooler-specific username and breaks the scheme. | Copy the **full connection string** Supabase gives you for the pooler (Session mode, port 5432) as a single `DATABASE_URL` secret. In code, only do two things to it: (1) if scheme is `postgres://`, rewrite to `postgresql+psycopg://`; (2) if async engine needs `+psycopg` / `+asyncpg` suffix and it's missing, add it. Never reconstruct host+user+password separately. |
| Supabase **direct connection** string (`db.<project-ref>.supabase.co:5432`) on Render | Direct connection is **IPv6-only on the free plan** (the IPv4 add-on is $4/mo and unavailable on Supabase's free tier). Render's free-tier network path is not reliably IPv6, so direct-connection attempts will hang/timeout intermittently — this is a plausible root cause layered under the same prior-project bug. | Always use a **pooler** hostname (`aws-0-<region>.pooler.supabase.com`), which is IPv4-compatible on every Supabase plan. |
| Celery + Redis (re-adding it "just in case") | Explicitly out of scope per `PROJECT.md`; adds a managed-Redis cost and an extra failure-mode (broker connectivity) for a workload that's currently "poll one Tiny ERP account every 15–30 min" — massive overkill pre-first-tenant. | APScheduler in-process, revisit Celery only when sync volume/tenant count genuinely requires distributed workers. |
| Relying on Supabase Auth **Custom Access Token Hooks** to inject `tenant_id` into the JWT for RLS | Auth Hooks are reported as **gated to Supabase's Teams/Enterprise plans** (free/Pro users get "Auth Hooks can only be configured on Teams or Enterprise plans" per current community reports, despite some doc pages suggesting free/Pro availability — this is unresolved/inconsistent as of this research and should not be depended on for an MVP). Even where available, it couples your tenant model to Supabase's own `auth.uid()`-centric RLS design, which doesn't fit "tenant = business account, not Supabase end-user" well. | Keep the **`app.tenant_id` session-GUC + RLS** pattern already scaffolded in the original docs (`01-ARQUITETURA.md` §4): FastAPI verifies the Supabase JWT for *authentication only*, looks up `tenant_id` from your own `tenants`/`memberships` table, then does `SELECT set_config('app.tenant_id', :tenant_id, true)` (transaction-scoped `SET LOCAL`) at the start of each request's DB transaction. RLS policies check `current_setting('app.tenant_id')::uuid = tenant_id`, not `auth.jwt()`/`auth.uid()`. This works identically regardless of Supabase plan and matches the actual tenant model (business, not individual Supabase user). |
| Vercel Hobby plan for a paying/commercial deployment | Vercel's Hobby (free) tier ToS is explicitly **personal, non-commercial use only, single developer**. A SaaS you charge for is commercial use even in early access. | Fine to use Hobby while pre-revenue/validating with the first design-partner tenant, but budget for **Vercel Pro (~$20/mo)** the moment you take payment or need team seats — flag this for the billing-phase roadmap item, not the MVP-sync-engine phase. |

## Stack Patterns by Variant

- Use the **Session Pooler** connection string (IPv4, port 5432, exclusive backend connection per client) — not Transaction Pooler (6543).
- Accept that the free web service **spins down after 15 min of inactivity** and cold-starts take 30–60s. This directly breaks two things at once: (a) inbound Tiny ERP webhooks arriving while asleep will be missed or badly delayed, and (b) the in-process APScheduler stops running entirely while the process is asleep, so your 15–30 min poll cadence silently becomes "whenever something wakes the process up."
- Free Supabase projects **pause after 7 days with no database activity** (not dashboard visits — actual DB queries). Combined with the Render-sleep mitigation above, if the pinger keeps Render awake and APScheduler keeps polling every 15–30 min, the DB activity requirement is satisfied automatically as a side effect. If you ever remove the pinger, add a separate keep-alive for Supabase or accept manual "resume project" clicks during idle dev periods.
- Re-evaluate Transaction Pooler mode + multiple lightweight workers, and re-evaluate Celery/Redis at that point — the "no Celery" decision is explicitly scoped to the MVP, not permanent.

## Version Compatibility

| Package A | Compatible With | Notes |
|-----------|-----------------|-------|
| SQLAlchemy 2.0.5x async engine | `postgresql+psycopg://` (psycopg3, async mode) | This is SQLAlchemy's other first-class async dialect alongside `postgresql+asyncpg://`; both are supported, psycopg3 is recommended here specifically for pooler compatibility. |
| psycopg3 (async) | Supabase Session Pooler (port 5432) | Verified pattern; avoids the PgBouncer/Supavisor prepared-statement failure mode documented against Transaction Pooler (port 6543) in supabase/supabase#39227, #35684, #36618. |
| asyncpg 0.31.x | Supabase Transaction Pooler (port 6543) | Requires `statement_cache_size=0` AND `prepared_statement_cache_size=0` in `connect_args`, and even then has open bug reports under burst load. Avoid unless you specifically need transaction-pooler-style short-lived connections. |
| Alembic 1.18.x | psycopg3 sync mode (`postgresql+psycopg://`, no async) | Alembic's `env.py` should build its own sync engine (or reuse the app's engine via `.execution_options()` as the prior project's fix did) — don't try to run async migrations, it adds complexity for no benefit. |
| PyJWT 2.13.x | Supabase JWKS endpoint (`https://<project-ref>.supabase.co/auth/v1/.well-known/jwks.json`) | Algorithms to accept: `["ES256", "RS256"]` for new asymmetric keys; Supabase is migrating off legacy shared-secret HS256 — do not hardcode HS256 verification. |
| APScheduler 3.11.x | Python 3.12, asyncio | Use `AsyncIOScheduler`, not `BackgroundScheduler`, inside a FastAPI app so jobs share the event loop; start/stop it in FastAPI's lifespan handler, not `@app.on_event` (deprecated). |

## Sources

- Supabase Docs — Connect to your database: https://supabase.com/docs/guides/database/connecting-to-postgres (HIGH — official)
- Supabase Docs — Using SQLAlchemy with Supabase: https://supabase.com/docs/guides/troubleshooting/using-sqlalchemy-with-supabase-FUqebT (HIGH — official)
- Supabase Docs — Supavisor and Connection Terminology Explained: https://supabase.com/docs/guides/troubleshooting/supavisor-and-connection-terminology-explained-9pr_ZO (HIGH — official)
- Supabase Docs — Disabling Prepared Statements: https://supabase.com/docs/guides/troubleshooting/disabling-prepared-statements-qL8lEL (HIGH — official)
- Supabase Docs — IPv4/IPv6 compatibility: https://supabase.com/docs/guides/troubleshooting/supabase--your-network-ipv4-and-ipv6-compatibility-cHe3BP (HIGH — official)
- Supabase Docs — Dedicated IPv4 Address for Ingress: https://supabase.com/docs/guides/platform/ipv4-address (HIGH — official)
- GitHub `supabase/supabase` issue #39227 — asyncpg burst-load prepared statement/timeout failures on both poolers (HIGH — primary source, reproducible bug report)
- GitHub `supabase/supabase` discussion #36618 — `PreparedStatementError` using asyncpg and SQLAlchemy (HIGH — primary source)
- Supabase Docs — JWT Signing Keys / JWKS: https://supabase.com/docs/guides/auth/signing-keys (HIGH — official)
- Supabase Docs — Custom Access Token Hook: https://supabase.com/docs/guides/auth/auth-hooks/custom-access-token-hook (MEDIUM — official docs conflict with community-reported plan gating)
- Community report on Auth Hooks plan gating (Answer Overflow / Supabase Discord mirror): https://www.answeroverflow.com/m/1196599539688280146 (MEDIUM — community-reported, unverified against current billing page at time of writing)
- Render community — free tier spin-down behavior: https://github.com/orgs/community/discussions/197645 (MEDIUM — community, consistent with multiple independent 2026 blog posts)
- Render.com official — "Platforms with a real free tier for developers in 2026": https://render.com/articles/platforms-with-a-real-free-tier-for-developers-in-2026 (HIGH — official)
- Fly.io free tier removal coverage (multiple independent 2026 sources converge): https://expresstech.io/7-fly-io-alternatives-in-2026-real-pricing-after-the-free-tier-died/, https://www.saaspricepulse.com/blog/flyio-free-tier-2026 (MEDIUM — third-party, cross-checked across 3+ sources → treat as HIGH)
- Vercel Hobby plan limits/ToS coverage: https://deploywise.dev/blog/vercel-free-tier-limits-2026, https://blog.vibecoder.me/vercel-pricing-explained-when-free-isnt-enough (MEDIUM — third-party, cross-checked)
- PyPI package metadata (fastapi, asyncpg, PyJWT, psycopg, sqlalchemy, alembic) — fetched directly from `pypi.org/pypi/<pkg>/json` (HIGH — primary source for version numbers)
- Prior-project git history (`tinysaas` repo, commit `55b0f80`) — direct evidence of the DATABASE_URL/pooler-username bug class this document warns against (HIGH — primary source, this exact codebase)

<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->

## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->

## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->

## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, or `.codex/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->

## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:

- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->

<!-- GSD:profile-start -->

## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
