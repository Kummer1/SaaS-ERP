---
phase: 1
slug: infrastructure-connection-foundation
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-07-27
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | pytest + pytest-asyncio (not yet installed — greenfield project) |
| **Config file** | none yet — create `pyproject.toml` `[tool.pytest.ini_options]` in Wave 0 |
| **Quick run command** | `pytest -x` |
| **Full suite command** | `pytest -v` |
| **Estimated runtime** | ~10 seconds (2 tests at Wave 0) |

---

## Sampling Rate

- **After every task commit:** Run `pytest -x`
- **After every plan wave:** Run `pytest -v`
- **Before `/gsd-verify-work`:** Full suite must be green, plus manual confirmation that `render.yaml` deploys successfully and `/health` responds at the public URL
- **Max feedback latency:** ~10 seconds

---

## Per-Task Verification Map

Phase 1 has no formal `REQ-XX` IDs (per `REQUIREMENTS.md` traceability table — Phase 1 carries zero direct requirement mappings by design; it de-risks the DATABASE_URL/pooler bug class for every later phase). Mapped to this phase's four success criteria (`ROADMAP.md`) instead:

| Success Criterion | Behavior | Test Type | Automated Command | File Exists | Status |
|--------------------|-----------|-----------|----------------------|---------------|--------|
| SC-1: Health-check responds at public Render URL | `GET /health` returns 200 with DB connectivity confirmed | integration | `pytest tests/test_health.py -x` | ❌ W0 | ⬜ pending |
| SC-2: Alembic migrations run against Supabase (local + prod) | `alembic upgrade head` succeeds via Session Pooler | manual (run once locally, once via CI/deploy step) | `alembic upgrade head` | N/A — CLI command | ⬜ pending |
| SC-3: CI smoke test runs `SELECT 1` via prod-shape `DATABASE_URL` | `SELECT 1` succeeds through the real scheme-rewrite path | integration, automated in CI | `pytest tests/test_db_connection.py -v` | ❌ W0 | ⬜ pending |
| SC-4: External keep-alive wakes the sleeping dyno | cron-job.org ping receives a successful `/health` response after a sleep window | manual (check cron-job.org's request history/logs) | N/A — external service, verified via dashboard | N/A | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `pyproject.toml` (or `pytest.ini`) — pytest configuration, `asyncio_mode = auto` for pytest-asyncio
- [ ] `tests/conftest.py` — shared fixtures (if any needed beyond direct engine import)
- [ ] `tests/test_health.py` — stub covering SC-1
- [ ] `tests/test_db_connection.py` — stub covering SC-3, must use `DATABASE_URL` secret in CI, not a hardcoded local string
- [ ] Framework install: `pip install pytest pytest-asyncio` — no existing test infrastructure at all (greenfield project)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Alembic migrations succeed against Supabase (SC-2) | ROADMAP Phase 1 SC-2 | Migration execution is a CLI/operational step, not a unit-testable behavior; must be confirmed once locally and once in the deploy pipeline | Run `alembic upgrade head` locally against the Session Pooler `DATABASE_URL`, then confirm the same command succeeds as part of the Render deploy/build step |
| External keep-alive cron wakes the sleeping dyno (SC-4) | ROADMAP Phase 1 SC-4 | Depends on an external third-party service (cron-job.org) and real elapsed time (15+ min of inactivity) — not automatable in CI | Configure the cron-job.org job against `/health`, wait for Render's free dyno to sleep, then confirm in cron-job.org's request log that a subsequent ping returns 200 after a cold start |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 10s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
