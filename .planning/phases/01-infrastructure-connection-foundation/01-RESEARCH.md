# Phase 1: Infrastructure & Connection Foundation - Research

**Researched:** 2026-07-27
**Domain:** FastAPI backend deployment mechanics on Render, Supabase Postgres connection (driver/pooler), Alembic migrations, CI smoke testing, external keep-alive scheduling
**Confidence:** HIGH for connection/pooler mechanics and package versions (verified against `pip index` + prior project-level research); MEDIUM for exact Render/GitHub Actions/Supabase UI mechanics (web-search verified, not hands-on tested this session); LOW-MEDIUM for the specific Alembic-env.py-simplification claim (synthesized from official docs + training knowledge, not found verbatim in any single source)

## Summary

This phase has already been substantially de-risked by the project-level research (`STACK.md`, `ARCHITECTURE.md`, `PITFALLS.md`, `SUMMARY.md`) — the driver (psycopg3, not asyncpg), the pooler mode (Session Pooler, port 5432, for both the app and Alembic), and the core `DATABASE_URL` bug class (already caused a real incident in the prior `tinysaas` project, commit `55b0f80`) are all settled decisions. What this phase-level research adds is the concrete, step-by-step mechanics needed to actually execute those decisions: the exact `render.yaml` shape for a free-tier FastAPI web service, the (simpler-than-most-tutorials) Alembic `env.py` pattern that psycopg3's dual sync/async support enables, the GitHub Actions CI smoke-test pattern that must hit the *real* Supabase pooler (not a local Postgres service container, which would silently pass while missing the exact bug this phase exists to prevent), and a reliability comparison between GitHub Actions scheduled workflows and `cron-job.org` for the external keep-alive requirement.

The single most important synthesis finding of this research: **psycopg3's `postgresql+psycopg://` dialect supports both sync and async natively from the same package**, which means Alembic's `env.py` does NOT need the `async_engine_from_config` + `connection.run_sync()` bridging pattern that nearly all current Alembic-async tutorials show (that pattern exists specifically to work around asyncpg having no sync counterpart). Using the async bridge pattern here would be needless complexity carried over from asyncpg-oriented tutorials that don't apply to this project's driver choice — Alembic's `env.py` can use a plain synchronous `create_engine(DATABASE_URL)` with the same `postgresql+psycopg://` URL the app's async engine uses (just without `+asyncio`/`create_async_engine`).

The second key finding: the CI smoke test (success criterion 3) must NOT use the common "spin up a `postgres:16` service container" GitHub Actions pattern found in most tutorials — that pattern tests generic Postgres connectivity, not the actual `DATABASE_URL` shape/pooler/scheme this phase exists to validate. The smoke test must connect to the real Supabase project (via a `DATABASE_URL` repository secret holding the actual Session Pooler connection string) and run `SELECT 1` through the exact same URL-rewrite code path the app uses.

**Primary recommendation:** Scaffold a minimal FastAPI app with `/health`, wire the DB engine through a single `app/db/session.py` module that only ever rewrites the `DATABASE_URL` scheme (never reconstructs it from parts), point both the app's async engine and Alembic's sync engine at Supabase's **Session Pooler** (port 5432, username `postgres.<project-ref>`), deploy via a `render.yaml` blueprint on Render's free plan, and validate everything with a GitHub Actions workflow that runs `SELECT 1` against the real (secret-injected) production-shape `DATABASE_URL` — then add `cron-job.org` (not GitHub Actions scheduling) as the keep-alive pinger, since GitHub Actions scheduled workflows have a documented 5–30+ minute delay risk that undermines their fitness for time-sensitive keep-alive pinging specifically.

## Project Constraints (from CLAUDE.md)

The following are locked decisions from the project's `.claude/CLAUDE.md` (itself derived from `STACK.md`) — this research does not re-litigate them, only operationalizes them for Phase 1:

- **Python 3.12** exactly (not whatever `python`/`python3` defaults to on the dev machine — see Environment Availability below).
- **FastAPI + SQLAlchemy 2.0 async + Alembic** — unchanged core stack.
- **psycopg (v3), async mode** is the primary driver, replacing asyncpg — asyncpg has an open, documented incompatibility with Supabase's transaction-mode pooler's prepared-statement handling.
- **Supabase Session Pooler (port 5432)**, not Transaction Pooler (6543) — Render/Fly host a single long-lived process, session mode is the documented fit and sidesteps the prepared-statement bug class entirely.
- **Never reconstruct `DATABASE_URL` from parts** (`DB_HOST` + `DB_PASSWORD` env vars) — this is the exact bug class that broke the prior `tinysaas` project (commit `55b0f80`). Only ever rewrite the scheme on the platform-provided full connection string.
- **Never use Supabase's direct-connection string** (`db.<ref>.supabase.co:5432`) on Render — IPv6-only on the free plan, Render's network path is not reliably IPv6.
- **No Celery/Redis** — not relevant to Phase 1 directly, but the scheduler placeholder (`app/scheduler.py`) should not be built out yet; Phase 1 only needs the external keep-alive cron, not the in-process APScheduler (that's wired in Phase 3 alongside the sync engine).
- **`ruff` for lint, `pytest` + `pytest-asyncio` for tests** — development tooling standard.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|-----------------|-----------|
| Health-check endpoint (`GET /health`) | API / Backend | — | Simple FastAPI route; Render's health-check mechanism polls this from outside the tier boundary |
| `DATABASE_URL` scheme rewrite + engine construction | API / Backend | Database / Storage | The rewrite logic lives in app code (`app/db/session.py`), but it exists entirely to satisfy the Database tier's connection contract (pooler, driver, username shape) |
| Alembic migrations | Database / Storage | API / Backend (invokes) | Migrations define/own schema state; Alembic itself runs as a CLI invoked from CI/deploy, not from the running API process |
| Render web service (deployment target) | API / Backend | — | Hosts the FastAPI process; not a distinct architectural tier itself but the concrete instantiation of the "API/Backend" tier for this project |
| CI smoke test (`SELECT 1` via prod-shape URL) | Database / Storage (validates) | API / Backend (executes) | Validates the connection contract between backend and database before any feature code depends on it |
| External keep-alive cron | External / Infra | API / Backend (receiver) | Lives entirely outside the app's own process boundary by design — its value is precisely that it's an external actor making inbound HTTP calls |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|---------------|
| Python | 3.12.x (confirmed `3.12.5` available via `py -3.12` launcher on this machine) | Runtime | Project-locked version; `python`/`python3` on PATH may resolve to a different version — always target 3.12 explicitly when creating the venv [VERIFIED: py launcher, local machine] |
| FastAPI | 0.140.7 (latest on PyPI as of this research) | API framework | [VERIFIED: pip index versions fastapi] |
| SQLAlchemy | 2.0.51 (latest) | ORM + async engine | [VERIFIED: pip index versions sqlalchemy] |
| Alembic | 1.18.5 (latest) | Migrations | [VERIFIED: pip index versions alembic] |
| psycopg (v3), with `binary` and `pool` extras | 3.3.4 (latest) | Postgres driver, both async (app) and sync (Alembic) modes from the same package | [VERIFIED: pip index versions psycopg] |
| uvicorn | current, ASGI server | Runs the FastAPI app in production (`startCommand` on Render) | Standard FastAPI production server |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `python-dotenv` | current | Local `.env` loading | Dev only; Render injects env vars directly in production |
| `pytest`, `pytest-asyncio` | current | Test framework | CI smoke test (`SELECT 1`) and future async route/DB tests |
| `ruff` | current | Lint | CI lint step |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `render.yaml` blueprint (infra-as-code) | Manual Render Dashboard configuration | Blueprint is reproducible and version-controlled; manual dashboard setup is faster for a one-off but not repeatable/reviewable. Recommend `render.yaml` since this phase is explicitly about proving repeatable infra. |
| `cron-job.org` for keep-alive | GitHub Actions scheduled workflow | GH Actions is free and needs no third-party account, but has a **documented 5–30+ minute delay risk** on scheduled runs (see Pitfalls) that can itself cause the exact spin-down this mechanism exists to prevent. `cron-job.org` has tighter, more predictable timing for this specific narrow role. |
| GitHub Actions `postgres:` service container for CI smoke test | Real Supabase project via secret `DATABASE_URL` | A service container tests generic Postgres connectivity, not the actual pooler/scheme/driver combination this phase exists to validate — using it would make the CI smoke test pass even if the real `DATABASE_URL` handling is broken, defeating success criterion 3. |
| `psycopg[binary,pool]` (recommended) | `psycopg2-binary` for Alembic only | Prior project convention; would introduce a second driver family just for migrations. Since psycopg3 already supports sync mode, there's no reason to add psycopg2 — one driver family for both async app and sync migrations. |

**Installation:**
```bash
py -3.12 -m venv .venv
.venv\Scripts\activate   # Windows

pip install "fastapi[standard]" "sqlalchemy[asyncio]>=2.0" alembic
pip install "psycopg[binary,pool]"
pip install python-dotenv
pip install pytest pytest-asyncio ruff
```

**Version verification:** Confirmed directly against PyPI via `pip index versions <pkg>` on 2026-07-27 — `fastapi==0.140.7`, `sqlalchemy==2.0.51`, `alembic==1.18.5`, `psycopg==3.3.4`. These match (and are current point-releases of) the version lines already recommended in `STACK.md`.

## Package Legitimacy Audit

The `package-legitimacy check` seam's PyPI signal source returns `weeklyDownloads: null` for every package checked (a known ecosystem gap — the seam's download-count source does not currently cover PyPI), which drives a mechanical `unknown-downloads` reason on every result, and its `publishedAt` field reflects the **latest release date**, not package origin, which drove a spurious `too-new` reason on `fastapi`, `uvicorn`, and `ruff` (all of which shipped a routine point release within the lookback window used by the heuristic — not because the package itself is new). None of these are genuine legitimacy signals for this batch: every package below is a long-established, widely-known project (verified via `pip index versions`, which confirms real PyPI presence and a long version history, and via each package's listed `repoUrl` matching its actual well-known official repository).

| Package | Registry | Version history | Downloads | Source Repo | Verdict (raw) | Disposition |
|---------|----------|-------------------|-----------|--------------|--------|-------------|
| fastapi | PyPI | 250+ releases back to 0.1.0 | tool returned null (PyPI gap) | github.com/fastapi/fastapi | SUS (too-new, unknown-downloads) | **Approved** — false positive, well-known official package |
| sqlalchemy | PyPI | 200+ releases back to 0.1.0 | tool returned null | sqlalchemy.org | SUS (unknown-downloads) | **Approved** — false positive |
| alembic | PyPI | 100+ releases back to 0.1.0 | tool returned null | github.com/sqlalchemy/alembic | SUS (unknown-downloads) | **Approved** — false positive |
| psycopg | PyPI | psycopg3 line back to 3.0 (successor to long-standing psycopg2) | tool returned null | psycopg.org | SUS (unknown-downloads) | **Approved** — false positive |
| uvicorn | PyPI | 80+ releases | tool returned null | github.com/Kludex/uvicorn (current maintainer) | SUS (too-new, unknown-downloads) | **Approved** — false positive |
| pytest | PyPI | 100+ releases back to 2004-era project | tool returned null | github.com/pytest-dev/pytest | SUS (unknown-downloads) | **Approved** — false positive |
| pytest-asyncio | PyPI | established plugin, pytest-dev org | tool returned null | github.com/pytest-dev/pytest-asyncio | SUS (unknown-downloads) | **Approved** — false positive |
| ruff | PyPI | Astral's actively-shipped tool, frequent releases | tool returned null | docs.astral.sh/ruff | SUS (too-new, unknown-downloads) | **Approved** — false positive (frequent shipping cadence, not newness) |
| python-dotenv | PyPI | established since 2014 | tool returned null | github.com/theskumar/python-dotenv | SUS (unknown-downloads) | **Approved** — false positive |

**Packages removed due to `[SLOP]` verdict:** none.
**Packages flagged as suspicious `[SUS]`:** none carried forward as genuinely suspicious — all 9 raw `SUS` verdicts above are attributed to a documented PyPI-ecosystem gap in the legitimacy-check seam (no download-count source, and a `publishedAt`-based "too-new" heuristic that doesn't distinguish "package is new" from "package shipped a routine point release recently"). The planner does **not** need to add `checkpoint:human-verify` gates before these installs — cross-verified via `pip index versions` (confirms deep version history / registry presence) and each package's well-known, matching source repository.

## Architecture Patterns

### System Architecture Diagram (Phase 1 scope only)

```
┌─────────────────────────────────────────────────────────────┐
│  GitHub repo (this project)                                  │
│                                                                │
│  render.yaml  ──push/blueprint sync──▶  Render (build+deploy) │
│                                                                │
│  .github/workflows/ci.yml                                     │
│    on: push/PR                                                │
│    → checkout → pip install → ruff → pytest                  │
│         → smoke test: connect via DATABASE_URL secret         │
│           (Supabase Session Pooler, same shape as prod)       │
│           → SELECT 1 → pass/fail                              │
└──────────────────────────┬─────────────────────────────────────┘
                            │ deploy (git push / blueprint sync)
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  Render — Web Service (free plan)                             │
│                                                                │
│  uvicorn main:app --host 0.0.0.0 --port $PORT                 │
│    GET /health  ──────────────────▶  DB ping (SELECT 1)       │
│                                                                │
│  env vars (Render dashboard secrets):                         │
│    DATABASE_URL  (Supabase Session Pooler conn string)        │
└──────────────────────────┬─────────────────────────────────────┘
                            │ postgresql+psycopg://postgres.<ref>@...
                            │ :5432 (Session Pooler, IPv4-safe)
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  Supabase — Managed Postgres 16                                │
│    Supavisor Session Pooler (port 5432)                       │
│    Alembic migrations run against this same pooler             │
└─────────────────────────────────────────────────────────────┘

External keep-alive:
  cron-job.org  ──every 10 min, HTTP GET──▶  https://<app>.onrender.com/health
    (wakes the sleeping free-tier dyno; does NOT rely on GitHub Actions
     scheduling due to its documented delay risk — see Pitfalls)
```

### Recommended Project Structure (Phase 1 subset)

This is the minimal slice of the full target structure documented in `ARCHITECTURE.md` — only what Phase 1 actually needs. Later phases (2–4) add `app/api/routes/`, `app/sync/`, `app/scheduler.py`, `app/core/security.py`, `app/core/crypto.py` on top of this.

```
backend/
├── app/
│   ├── main.py              # FastAPI app instance, GET /health route
│   └── db/
│       ├── __init__.py
│       └── session.py       # DATABASE_URL rewrite + async engine + sync engine (for Alembic)
├── alembic/
│   ├── env.py                # sync engine via psycopg3, no async bridge needed
│   └── versions/
├── alembic.ini
├── requirements.txt          # or pyproject.toml
├── render.yaml
├── tests/
│   ├── conftest.py
│   ├── test_health.py
│   └── test_db_connection.py # the CI smoke test: SELECT 1 via prod-shape DATABASE_URL
└── .github/
    └── workflows/
        ├── ci.yml             # lint + tests + smoke test
        └── keepalive.yml      # OPTIONAL backup pinger; cron-job.org is primary
```

### Pattern 1: Centralized `DATABASE_URL` rewrite, never reconstruction

**What:** One function, called once at import time, that reads `DATABASE_URL` as a single environment variable and only ever rewrites the scheme — never rebuilds host/user/password from separate parts.
**When to use:** Always, in `app/db/session.py`, imported by both the app's async engine setup and Alembic's `env.py`.
**Why this matters here specifically:** This is the exact fix pattern for the bug that broke the prior `tinysaas` project (commit `55b0f80`) — but the fix target differs this time because the driver is psycopg3, not asyncpg or psycopg2. The rewrite target must be `postgresql+psycopg://`, not `postgresql+asyncpg://` or `postgresql+psycopg2://`.

**Example:**
```python
# app/db/session.py
import os
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker

def get_database_url() -> str:
    url = os.environ["DATABASE_URL"]
    # Supabase/Render may hand you postgres:// or postgresql://; psycopg3 needs
    # the postgresql+psycopg:// dialect prefix. Never reconstruct from parts —
    # only rewrite the scheme on the full string.
    if url.startswith("postgres://"):
        url = url.replace("postgres://", "postgresql+psycopg://", 1)
    elif url.startswith("postgresql://") and "+psycopg" not in url:
        url = url.replace("postgresql://", "postgresql+psycopg://", 1)
    return url

# Async engine — used by the running FastAPI app
async_engine = create_async_engine(
    get_database_url(),
    pool_pre_ping=True,
)
async_session_factory = async_sessionmaker(async_engine, expire_on_commit=False)

def get_sync_database_url() -> str:
    # Same rewrite, reused by Alembic's env.py. psycopg3 supports sync mode
    # natively via the same postgresql+psycopg:// dialect — create_engine (sync)
    # instead of create_async_engine, no other driver needed.
    return get_database_url()
```

### Pattern 2: Alembic `env.py` using psycopg3's native sync mode (no async bridge)

**What:** Because psycopg3 supports both sync and async from one package, Alembic's `env.py` uses a plain synchronous `create_engine()` — not the `async_engine_from_config` + `connection.run_sync()` bridge that asyncpg-based projects require.
**When to use:** This project's Alembic setup, given the psycopg3 driver choice.
**Trade-offs:** None — this is strictly simpler than the async-bridge pattern most current tutorials show (that pattern exists to work around asyncpg specifically having no sync API, which does not apply here). [LOW-MEDIUM confidence: synthesized from official SQLAlchemy/Alembic docs plus training knowledge of psycopg3's dual-mode design — not found written out verbatim as "psycopg3 lets you skip the async bridge" in any single fetched source this session; verify with a working local migration run before trusting in CI.]

**Example:**
```python
# alembic/env.py
from logging.config import fileConfig
from sqlalchemy import create_engine, pool
from alembic import context
from app.db.session import get_sync_database_url
from app.db.models import Base  # once models exist

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata

def run_migrations_offline() -> None:
    context.configure(
        url=get_sync_database_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()

def run_migrations_online() -> None:
    connectable = create_engine(get_sync_database_url(), poolclass=pool.NullPool)
    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()

if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
```
`poolclass=pool.NullPool` is deliberate: Alembic runs a handful of DDL statements once per deploy, not a persistent pool of connections — no reason to hold a Session Pooler slot open longer than necessary.

### Pattern 3: `render.yaml` blueprint for the free-tier FastAPI web service

**What:** Infra-as-code deployment definition committed to the repo, so Render's exact build/start/health-check configuration is version-controlled and reviewable, not click-configured once in a dashboard and forgotten.
**When to use:** Immediately — this phase's success criterion 1 depends on this being right the first time (a working health check at a public URL).

**Example:**
```yaml
# render.yaml
services:
  - type: web
    name: tiny-saas-backend
    runtime: python
    plan: free
    region: oregon               # match Supabase project region for latency
    buildCommand: pip install -r requirements.txt
    startCommand: uvicorn app.main:app --host 0.0.0.0 --port $PORT
    healthCheckPath: /health
    envVars:
      - key: DATABASE_URL
        sync: false               # prompted for value at first deploy, never committed
```
`sync: false` on `DATABASE_URL` means Render prompts for the actual Supabase Session Pooler connection string during blueprint setup instead of expecting it in the YAML — the secret itself still never touches git.

### Pattern 4: CI smoke test against the real production-shape `DATABASE_URL` (not a service container)

**What:** A GitHub Actions job that connects using the **actual** Supabase Session Pooler connection string (stored as a `DATABASE_URL` repository secret) and runs `SELECT 1` through the exact same rewrite code path (`get_sync_database_url()`) the app and Alembic use — not a generic `postgres:16` service container.
**When to use:** Every push/PR, as the load-bearing regression test for success criterion 3.
**Why not the common service-container pattern:** The typical GitHub Actions Postgres tutorial spins up a `postgres:` service container and connects via `127.0.0.1:5432` with test credentials — that validates "can this code talk to *some* Postgres," not "does the actual Supabase pooler/scheme/driver combination work." A service container would pass even if the scheme rewrite were broken or pointed at the wrong pooler port, which is precisely the failure mode this phase exists to catch.

**Example:**
```yaml
# .github/workflows/ci.yml
name: CI
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
      - run: pip install -r requirements.txt -r requirements-dev.txt
      - run: ruff check .
      - name: DB connectivity smoke test (real Supabase pooler)
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
        run: pytest tests/test_db_connection.py -v
      - run: pytest -x
```
```python
# tests/test_db_connection.py
import pytest
from sqlalchemy import text
from app.db.session import async_engine

@pytest.mark.asyncio
async def test_select_1_via_production_shape_url():
    async with async_engine.connect() as conn:
        result = await conn.execute(text("SELECT 1"))
        assert result.scalar() == 1
```
The `DATABASE_URL` secret should be a Supabase project's Session Pooler string (a dedicated dev/staging Supabase project is safer than pointing CI at the eventual production project, though for a pre-revenue MVP with a single Supabase free project this may be the same project — document that choice explicitly rather than leaving it implicit).

### Anti-Patterns to Avoid

- **Reconstructing `DATABASE_URL` from `DB_HOST`/`DB_PASSWORD` parts:** the exact bug that broke the prior project — always read and rewrite the full string.
- **Using Supabase's direct-connection host** (`db.<ref>.supabase.co`) instead of the pooler host — IPv6-only on free tier, hangs/times out from Render.
- **Using the Alembic async-bridge (`run_sync`) pattern** when psycopg3 already supports sync mode natively — needless complexity carried over from asyncpg tutorials.
- **Testing DB connectivity in CI via a generic `postgres:` service container** — passes even when the real pooler/scheme handling is broken; defeats the point of the smoke test.
- **Relying on GitHub Actions scheduled workflows alone for the keep-alive ping** — documented 5–30+ minute delay risk can itself cause the spin-down the mechanism exists to prevent.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|---------------|-----|
| Async-to-sync migration bridging for Alembic | Custom `asyncio.run()` wrapper around Alembic's migration runner | Plain synchronous `create_engine()` with `postgresql+psycopg://` | psycopg3 already supports sync mode; a custom async bridge would be solving a problem that doesn't exist for this driver choice |
| Keep-alive scheduling | A custom self-pinging background thread inside the FastAPI app | External pinger (`cron-job.org`) hitting `/health` | A self-ping from inside a process that might itself be asleep/spinning down is a contradiction — the ping must originate externally to actually wake the dyno |
| `DATABASE_URL` parsing/validation | Custom URL parser splitting host/user/password | `urllib.parse` only if inspection is needed for logging (never for reconstruction); otherwise treat the string as opaque and only do prefix replacement | Reduces the surface area for the exact bug class this phase exists to prevent |

**Key insight:** Every "don't hand-roll" item in this phase traces back to the same root cause as the prior project's incident — treating a platform-provided opaque connection string as something safe to decompose and reassemble. The fix in every case is to do less, not more, to the string Render/Supabase hand you.

## Common Pitfalls

### Pitfall 1: `DATABASE_URL` scheme mismatch for psycopg3 specifically (not asyncpg)
**What goes wrong:** Copying the "rewrite `postgres://` to `postgresql+asyncpg://`" fix pattern from generic tutorials (or from the prior project's own fix) without updating the target scheme for psycopg3.
**Why it happens:** The prior project's fix (commit `55b0f80`) targeted psycopg2; most current online guidance targets asyncpg. Neither matches this project's actual driver.
**How to avoid:** The rewrite target must be exactly `postgresql+psycopg://` (psycopg3's dialect string, note: NOT `postgresql+psycopg3://`, which is not a valid dialect name).
**Warning signs:** `sqlalchemy.exc.NoSuchModuleError` mentioning a driver name on boot.

### Pitfall 2: Using the wrong Supabase pooler port for Alembic
**What goes wrong:** Pointing Alembic's `env.py` at the Transaction Pooler (6543) "because that's what the app uses" — but this project's app also uses the Session Pooler (5432), so there is no port split to get wrong *if the Session Pooler decision is followed consistently*. The pitfall is inconsistency: using different ports/URLs for the app vs. Alembic without a documented reason.
**Why it happens:** Many Supabase+SQLAlchemy tutorials show transaction-pooler-for-app + session-pooler-for-migrations as a default pattern (relevant when asyncpg is the driver, which cannot tolerate the transaction pooler's prepared-statement behavior at all). This project's psycopg3 choice sidesteps that split entirely — one pooler, one port, for both.
**How to avoid:** Use the Session Pooler connection string (port 5432, `postgres.<project-ref>` username) for both the app's async engine and Alembic's sync engine. Verify by grepping for `6543` anywhere in the codebase before considering this phase done — it should not appear.
**Warning signs:** Two different `DATABASE_URL`-shaped values needed for the app to run vs. migrations to run — this is itself the warning sign, since this project's design should need only one.

### Pitfall 3: CI smoke test using a service container instead of the real Supabase pooler
**What goes wrong:** Following the most common GitHub Actions + Postgres tutorial pattern (spin up `postgres:16` as a service container, connect via `127.0.0.1`) for the smoke test — this passes CI even when the actual Supabase pooler connection is broken.
**Why it happens:** It's the default, well-documented pattern for "test against Postgres in CI," and looks correct at a glance.
**How to avoid:** The smoke test must use a `DATABASE_URL` **repository secret** holding the real Supabase Session Pooler string, and must go through the same `get_sync_database_url()` / `get_database_url()` rewrite function the app uses — not a hardcoded local test connection string.
**Warning signs:** CI is green, but the same code fails to connect once deployed to Render — the clearest possible sign the smoke test isn't actually testing the production-shape URL.

### Pitfall 4: Relying solely on GitHub Actions cron for the keep-alive requirement
**What goes wrong:** Using a GitHub Actions `schedule:` trigger as the sole keep-alive mechanism, assuming "every 10 minutes" means the ping reliably lands every 10 minutes.
**Why it happens:** GitHub Actions scheduled workflows are free and don't require a third-party account, so they look like the simplest choice.
**How to avoid:** GitHub's own documentation warns runs "can be delayed at busy times," with community reports of 5–30+ minute delays being common, especially near the top of the hour. Against a 15-minute Render free-tier spin-down window, a single delayed run can let the dyno sleep anyway. Use `cron-job.org` (or a similar dedicated pinger service) as the primary keep-alive mechanism instead; GitHub Actions scheduling is acceptable for less time-sensitive triggers (e.g., Phase 3's sync-poll trigger, where staleness of a few hours is a tolerable degradation, not a failure) but not for this phase's keep-alive success criterion.
**Warning signs:** Render logs show gaps longer than 15 minutes between requests despite a configured "every 10 min" scheduled workflow.

### Pitfall 5: Region mismatch between Render and Supabase adding avoidable latency
**What goes wrong:** Leaving Supabase's region at its default/first-listed option without matching it to Render's deployment region, adding cross-region network latency to every single DB query.
**Why it happens:** Supabase's project wizard requires an explicit region selection, but it's easy to click through without considering Render's region.
**How to avoid:** Render's free-tier default region is Oregon (US West); select the geographically closest Supabase region at project creation (Postgres projects cannot be moved cross-region later — only exported and reimported into a new project).
**Warning signs:** Every DB-touching request has noticeably higher latency than expected even with no other explanation.

## Code Examples

Additional verified pattern beyond the ones embedded in Architecture Patterns above:

### Health check with DB connectivity (Render best practice)
```python
# app/main.py
from fastapi import FastAPI
from sqlalchemy import text
from app.db.session import async_engine

app = FastAPI()

@app.get("/health")
async def health():
    async with async_engine.connect() as conn:
        await conn.execute(text("SELECT 1"))
    return {"status": "ok"}
```
Render's own health-check docs recommend performing an operation-critical check (e.g., a DB query) rather than a bare 200 OK — this also means the health check doubles as manual verification of DB connectivity in production, and as the keep-alive pinger's actual wake target (a successful `/health` response confirms the DB path is alive too, not just the process).

### `cron-job.org` keep-alive setup (no code — dashboard configuration)
Configure a job at cron-job.org: URL = `https://<app-name>.onrender.com/health`, schedule = every 10 minutes, method = GET. No authentication needed for a `/health` endpoint with no sensitive data in its response. Enable cron-job.org's failure notification so a broken keep-alive is visible before it causes a failed demo (per `PITFALLS.md` Pitfall 6).

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|---------------|--------------------|-----------------|--------|
| Supabase Transaction Pooler port 6543 supporting both session and transaction modes | Port 6543 is transaction-mode-only; session mode is 5432-only | Feb 28 2025 (Supabase changelog) | Older tutorials/StackOverflow answers referencing "session mode on 6543" are now wrong — always cross-check against current Supabase docs, not older search results |
| asyncpg as the default async Postgres driver for SQLAlchemy 2.0 | psycopg3 preferred for Supabase-pooler-fronted deployments specifically | Ongoing as of 2025/2026 (multiple open asyncpg+pooler GitHub issues) | Most existing FastAPI+SQLAlchemy+Alembic tutorials online still default to asyncpg and its async-bridge Alembic pattern — do not copy that pattern here |
| `autoDeploy: true/false` boolean in `render.yaml` | `autoDeployTrigger: commit \| checksPass \| off` | Render platform update (exact date not confirmed this session — verify current field name against `render.com/docs/blueprint-spec` at implementation time) | Using the deprecated boolean field may still work but is worth confirming against current docs before writing the final `render.yaml` |

**Deprecated/outdated:**
- `autoDeploy` boolean field in `render.yaml` — superseded by `autoDeployTrigger`; verify current syntax at implementation time since Render's blueprint spec evolves.
- Session-mode connections on Supabase pooler port 6543 — no longer valid since Feb 2025; any pre-2025 tutorial referencing this is outdated.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|-----------------|
| A1 | Alembic's `env.py` can use a plain sync `create_engine()` with psycopg3 without any async-bridge pattern, with no functional downside | Architecture Patterns, Pattern 2 | LOW-MEDIUM — if wrong, migrations could fail to run in CI/production; mitigated by testing a real `alembic upgrade head` locally against the actual Supabase Session Pooler before considering this phase done, per the phase's own success criterion 2 |
| A2 | `render.yaml`'s `autoDeployTrigger` field name and `region: oregon` value are current as of this research | Code Examples / Pattern 3, State of the Art | LOW — if the field name has changed, `render.yaml` will fail blueprint validation with a clear error at deploy time, not silently; low-cost to fix |
| A3 | GitHub Actions scheduled workflow delays (5–30+ min) are severe enough to disqualify GH Actions as the *sole* keep-alive mechanism, specifically for this phase's success criterion 4 | Pitfalls, Pitfall 4 | MEDIUM — if GH Actions delays are milder in practice than documented worst-case, using it alone might work most of the time; the cost of being wrong is intermittent, hard-to-reproduce spin-down during demos (exactly the failure mode `PITFALLS.md` Pitfall 6 already flags as high-cost around investor/demo moments) — recommend `cron-job.org` regardless since it removes this risk entirely at zero cost |
| A4 | A dedicated dev/staging Supabase project (vs. reusing the single production-bound free project) for the CI `DATABASE_URL` secret is the safer choice | Code Examples / Pattern 4 | LOW — this project has one free Supabase project for the whole MVP per `PROJECT.md`'s cost constraint; CI running `SELECT 1` (read-only, no schema mutation) against the same project is low-risk either way, but should be a deliberate choice documented in the plan, not left implicit |

**If this table is empty:** N/A — see entries above.

## Open Questions

1. **Exact current `render.yaml` field names for auto-deploy and region-latency tuning**
   - What we know: `type`, `name`, `runtime`, `plan`, `buildCommand`, `startCommand`, `healthCheckPath`, `region`, `envVars` (with `sync: false` for secrets) are confirmed current fields.
   - What's unclear: Whether `autoDeployTrigger` vs. the older `autoDeploy` boolean is the currently-required field, and whether Render's region list has changed.
   - Recommendation: Confirm directly against `render.com/docs/blueprint-spec` at implementation time (a live docs fetch, not this session's cached search summary) before finalizing `render.yaml` — this is a fast, cheap check to do right before writing the file.

2. **Whether to point the CI smoke test at the production Supabase project or a separate dev/staging one**
   - What we know: The smoke test must use the real pooler shape, not a service container.
   - What's unclear: Given the project's single-free-Supabase-project cost constraint, whether CI should share that project or whether creating a second free Supabase project (2 allowed on free tier) specifically for CI is worth the added setup.
   - Recommendation: Start by sharing the one project (read-only `SELECT 1`, negligible risk) and document this choice explicitly in the plan; revisit only if CI runs start meaningfully contributing to the 500MB/5GB free-tier limits.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|--------------|-------------|---------|-----------|
| Python 3.12 | Project-locked runtime (`CLAUDE.md`) | ✓ (via `py -3.12` launcher) | 3.12.5 | Default `python`/`python3` on this machine resolves to 3.14.4 — must explicitly invoke `py -3.12` when creating the venv, do not rely on bare `python` |
| Node.js | GSD tooling only, not part of the app stack | ✓ | v24.15.0 | — |
| git | Version control | ✓ | 2.49.0 | — |
| Docker | Local Postgres alternative to Supabase CLI (optional per `STACK.md`) | ✗ (not found on this machine) | — | Use a local Postgres install, or skip local Postgres entirely and develop against a real (free) Supabase project directly — acceptable at MVP scale per `STACK.md`'s own "optional" framing |
| Supabase CLI | Optional local dev stack matching prod | ✗ (not found) | — | Not required — `STACK.md` already flags this as optional in favor of developing directly against Supabase's hosted free tier |
| Render CLI | Optional; blueprint deploys work via git push / dashboard without it | ✗ (not found) | — | Not required — `render.yaml` + git push (or Render dashboard "New Blueprint") does not need the CLI |
| GitHub CLI (`gh`) | Convenience only, not required for CI workflow authoring | ✗ (not found) | — | Not required — GitHub Actions workflows are plain YAML files committed to `.github/workflows/`, no CLI needed to author them |
| PostgreSQL client (`psql`) | Convenience for manual DB inspection | ✗ (not found) | — | Not required — Supabase's dashboard SQL editor, or a Python one-liner via psycopg3, covers manual inspection needs |

**Missing dependencies with no fallback:**
- None — every missing tool above has a documented, low-cost fallback or is genuinely optional per the project's own prior research.

**Missing dependencies with fallback:**
- Docker, Supabase CLI, Render CLI, `gh`, `psql` — all optional conveniences; the plan should not assume any of them are installed on the execution machine and should use `pip`/`py -3.12`/plain HTTP or git-based workflows instead.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | pytest + pytest-asyncio (not yet installed — greenfield project) |
| Config file | none yet — create `pyproject.toml` `[tool.pytest.ini_options]` or `pytest.ini` in Wave 0 |
| Quick run command | `pytest -x` |
| Full suite command | `pytest -v` |

### Phase Requirements → Test Map

Phase 1 has no formal `REQ-XX` IDs (per `REQUIREMENTS.md` traceability table — Phase 1 carries zero direct requirement mappings by design). Mapping instead to this phase's four success criteria (`ROADMAP.md`):

| Success Criterion | Behavior | Test Type | Automated Command | File Exists? |
|--------------------|-----------|-----------|----------------------|---------------|
| SC-1: Health-check responds at public Render URL | `GET /health` returns 200 with DB connectivity confirmed | integration (manual post-deploy check + automated local/CI test) | `pytest tests/test_health.py -x` | ❌ Wave 0 |
| SC-2: Alembic migrations run against Supabase (local + prod) | `alembic upgrade head` succeeds via Session Pooler | manual (run once locally, once via CI/deploy step) | `alembic upgrade head` | N/A — CLI command, not a pytest test |
| SC-3: CI smoke test runs `SELECT 1` via prod-shape `DATABASE_URL` | `SELECT 1` succeeds through the real rewrite path | integration, automated in CI | `pytest tests/test_db_connection.py -v` | ❌ Wave 0 |
| SC-4: External keep-alive wakes the sleeping dyno | cron-job.org ping receives a successful `/health` response after a sleep window | manual (check cron-job.org's request history/logs after configuring) | N/A — external service, verified via dashboard, not an automated test | N/A |

### Sampling Rate
- **Per task commit:** `pytest -x` (fast subset)
- **Per wave merge:** `pytest -v` (full suite, currently 2 tests)
- **Phase gate:** Full suite green, plus a manual confirmation that `render.yaml` deploys successfully and `/health` responds at the public URL, before `/gsd-verify-work`.

### Wave 0 Gaps
- [ ] `pyproject.toml` (or `pytest.ini`) — pytest configuration, `asyncio_mode = auto` for pytest-asyncio
- [ ] `tests/conftest.py` — shared fixtures (if any needed beyond direct engine import)
- [ ] `tests/test_health.py` — covers SC-1
- [ ] `tests/test_db_connection.py` — covers SC-3, must use `DATABASE_URL` secret in CI, not a hardcoded local string
- [ ] Framework install: `pip install pytest pytest-asyncio` — no existing test infrastructure at all (greenfield project, per `PROJECT.md`: "Nenhum código foi escrito ainda")

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|-----------------|---------|---------------------|
| V2 Authentication | No | Not built until Phase 2 — Phase 1 has no user-facing auth surface |
| V3 Session Management | No | Same as above |
| V4 Access Control | No | Same as above — `/health` is intentionally public/unauthenticated |
| V5 Input Validation | Minimal | `/health` takes no user input; not a meaningful attack surface yet. Revisit once Phase 3's `/internal/sync/poll` endpoint (shared-secret protected) is built |
| V6 Cryptography | No | Fernet token encryption is a Phase 3 concern (Tiny OAuth tokens); nothing to encrypt in Phase 1 |
| V9 Communications Security | Yes | Render terminates TLS automatically for `.onrender.com` domains and any custom domain added later — no manual TLS configuration needed, but confirm HTTPS (not HTTP) is what `render.yaml`/health checks and the keep-alive pinger actually target |
| V14 Configuration | Yes | `DATABASE_URL` and any future secrets must be stored via Render's dashboard env vars (`sync: false` in `render.yaml`) and Supabase's own secret handling — never committed to git, never logged in plaintext (watch for accidental `print(DATABASE_URL)`-style debugging that leaks the password into Render's log stream, which is a real, easy-to-make mistake) |

### Known Threat Patterns for this stack (Phase 1 scope)

| Pattern | STRIDE | Standard Mitigation |
|----------|--------|------------------------|
| Credential leakage via connection-string logging | Information Disclosure | Never log the raw `DATABASE_URL` (it embeds the DB password); if logging connection info for debugging, log only the host/port/scheme with the credential portion redacted |
| Health-check endpoint information disclosure | Information Disclosure | Keep `/health`'s response minimal (`{"status": "ok"}`) — do not return stack traces, connection strings, or internal error detail on failure; a 500 with a generic message is sufficient for Render's health-check polling to detect failure |
| Unencrypted secrets in `render.yaml` | Tampering / Information Disclosure | Use `sync: false` for every secret `envVar` so the value is never committed to the blueprint file itself |

## Sources

### Primary (HIGH confidence)
- `pip index versions fastapi/sqlalchemy/alembic/psycopg` — direct PyPI registry query, run this session (2026-07-27) — HIGH, primary source for version numbers
- Prior project-level research (`STACK.md`, `ARCHITECTURE.md`, `PITFALLS.md`, `SUMMARY.md`) — already cites Supabase official docs, GitHub issue trackers, and the prior `tinysaas` project's own git history (`55b0f80`) directly

### Secondary (MEDIUM confidence)
- Render Docs — Blueprint YAML Reference (`render.com/docs/blueprint-spec`) — web-search-summarized this session, not directly fetched via a curated-docs provider; verify exact current field names before finalizing `render.yaml`
- Render Docs — Health Checks, Environment Variables, Web Services (`render.com/docs/*`) — web-search-summarized
- `render-examples/fastapi` repo `render.yaml` — GitHub example, web-fetched this session
- GitHub Docs — scheduled workflow cron syntax, 5-minute floor, delay warnings — web-search-summarized, consistent across multiple independent sources
- Supabase Docs — Supavisor and Connection Terminology, session/transaction pooler port split (changelog Feb 28 2025) — web-search-summarized, consistent with prior project-level research already citing the same official docs directly
- Alembic official docs (`alembic.sqlalchemy.org/en/latest/cookbook.html`) — web-fetched this session for the async-bridge pattern; the "psycopg3 doesn't need this bridge" conclusion is this research's own synthesis, not stated verbatim in Alembic's docs

### Tertiary (LOW confidence)
- Various Medium/blog posts on `cron-job.org` + Render keep-alive patterns — cross-checked across multiple independent posts converging on the same "ping every 10 min" recommendation, but no single authoritative source
- Community-written Alembic+psycopg3 env.py examples — did not locate a single complete, current, working example combining psycopg3 sync mode + Alembic env.py verbatim; the Pattern 2 code example in this document is synthesized from the async-bridge pattern (verified) plus training knowledge of psycopg3's sync API (not independently verified against a working example this session) — flagged as Assumption A1 above

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — package versions verified directly against PyPI this session; driver/pooler choice already HIGH-confidence from prior project-level research
- Architecture: MEDIUM — Render/GitHub Actions mechanics web-search-verified but not hands-on tested this session; the psycopg3-Alembic-simplification claim (Pattern 2) is the single lowest-confidence architectural claim in this document (see Assumption A1)
- Pitfalls: MEDIUM-HIGH — pitfalls 1, 2, 5 carry forward HIGH-confidence findings from `PITFALLS.md`; pitfalls 3 and 4 are this session's own synthesis based on cross-referencing GitHub Actions' own documented delay behavior against Render's 15-minute spin-down window, and the observation that generic CI DB tutorials don't match this phase's actual validation goal

**Research date:** 2026-07-27
**Valid until:** ~30 days for Render/Supabase platform mechanics (stable-ish but both platforms update pricing/docs pages periodically); ~7 days for anything involving exact `render.yaml` field names specifically, since Render's blueprint spec has changed at least once recently (`autoDeploy` → `autoDeployTrigger`) — re-verify against live docs immediately before writing the final `render.yaml`, not from this document alone.
