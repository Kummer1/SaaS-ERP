# Codebase Structure

**Analysis Date:** 2026-08-01

## Directory Layout

```
tiny-saas-platform/
├── supabase/                     # Supabase configuration and backend
│   ├── config.toml               # Supabase local dev and cloud settings
│   ├── functions/                # Deno Edge Functions (serverless compute)
│   │   ├── deno.jsonc            # Root task configuration (test task)
│   │   ├── health/
│   │   │   ├── deno.json         # Function-specific imports
│   │   │   └── index.ts          # Health check endpoint (public)
│   │   ├── sync-enqueue/
│   │   │   ├── deno.json         # Imports @supabase/supabase-js
│   │   │   └── index.ts          # Queue producer (Cron trigger)
│   │   ├── sync-worker/
│   │   │   ├── deno.json         # Imports @supabase/supabase-js
│   │   │   └── index.ts          # Queue consumer (work processor)
│   │   └── _shared/
│   │       └── db.ts             # postgres.js client factory (Transaction Pooler config)
│   ├── migrations/               # SQL schema migrations
│   │   ├── 20260729225411_enable_queue_extensions.sql
│   │   │                         # Enable pg_cron, pg_net, pgmq extensions
│   │   ├── 20260729231615_cron_sync_trigger.sql
│   │   │                         # Define cron job schedule and queue
│   │   └── 20260729232533_pgmq_public_wrappers.sql
│   │                            # Create RPC wrapper functions for pgmq
│   └── .temp/                   # Local Supabase CLI artifacts (git-ignored)
│       ├── linked-project.json  # Remote project reference
│       ├── postgres-version
│       ├── pgdelta/             # Schema diff engine state
│       └── ...
├── tests/                        # Deno test suite
│   ├── conftest.ts              # Test fixtures and helpers
│   ├── health_test.ts           # Health endpoint test
│   ├── db_connection_test.ts    # Database connection test
│   └── sync_pipeline_test.ts    # End-to-end sync pipeline test
├── scripts/                      # Utility scripts (TypeScript/Deno)
│   ├── setup-vault-secrets.ts   # Initialize Vault with platform secrets
│   └── smoke-test-db.ts         # Manual database connectivity check
├── docs/                         # Architecture and reference docs
│   ├── 01-ARQUITETURA.md        # System design, C4 diagram, decisions
│   ├── 02-MODELO-DE-DADOS.md    # Data model (bronze/silver), schema
│   ├── 03-INTEGRACAO-TINY-ERP.md # Tiny ERP API integration details
│   ├── 04-INFRAESTRUTURA-DEPLOY.md # Infrastructure and cost planning
│   ├── 05-ROADMAP.md            # Project roadmap and phases
│   └── sql/
│       └── rls_policies.example.sql # Example RLS policy definitions
├── .github/
│   └── workflows/
│       └── ci.yml               # GitHub Actions CI pipeline
├── .planning/                    # GSD planning artifacts
│   ├── config.json
│   ├── phases/                  # Phase-specific plans
│   │   └── 01-infrastructure-connection-foundation/
│   ├── quick/                   # Quick task logs
│   └── research/                # Spike research caches
├── .claude/                      # Claude Code configuration
│   ├── CLAUDE.md                # Project context for Claude
│   └── settings.local.json      # Local CLI settings
├── .env                         # Environment variables (git-ignored, contains secrets)
├── .mcp.json                    # MCP server configuration
├── .gitignore                   # Git ignore patterns
└── .git/                        # Git repository
```

## Directory Purposes

**`supabase/config.toml`:**
- Purpose: Central configuration for Supabase local dev and cloud deployment
- Key sections: `[api]` (PostgREST schemas exposed), `[db]` (pooler mode, version), `[auth]` (JWT expiry, signup), `[functions]` (JWT verification override for public endpoints)
- Example override: `[functions.health]` has `verify_jwt = false` because health check must be unauthenticated

**`supabase/functions/`:**
- Purpose: All serverless compute (Edge Functions)
- Pattern: Each function in its own directory with `index.ts` as entry point and `deno.json` declaring imports
- Key files:
  - `deno.jsonc`: Root task runner for `deno test --allow-net --allow-env`
  - `_shared/db.ts`: Singleton Postgres client — imported by all functions to ensure consistent Transaction Pooler config

**`supabase/migrations/`:**
- Purpose: Versioned schema changes applied by Supabase CLI
- Naming: `YYYYMMDDHHMMSS_descriptive_name.sql`
- Order: Applied in lexical order (timestamp ensures sequence)
- Idempotence: Each migration uses `if not exists` / `if not` clauses so re-running is safe

**`tests/`:**
- Purpose: Deno test suite covering Edge Function behavior
- Entry point: `conftest.ts` provides helpers like `getTestSql()` (mirrors db.ts connection) and `getHealthUrl()`
- Execution: `deno test` in `supabase/functions/` root (see `deno.jsonc`)
- Examples:
  - `health_test.ts`: Verifies GET /health returns 200 with status ok
  - `db_connection_test.ts`: Verifies Transaction Pooler connectivity
  - `sync_pipeline_test.ts`: End-to-end queue producer → consumer flow

**`scripts/`:**
- Purpose: One-off utility scripts (setup, smoke tests, debugging)
- Examples:
  - `setup-vault-secrets.ts`: Initializes Supabase Vault with platform secrets (project URL, edge function key) — must run before Cron jobs can call sync-enqueue
  - `smoke-test-db.ts`: Manual test for DB connectivity outside Edge Functions

**`docs/`:**
- Purpose: Architecture, integration, and roadmap documentation
- Key docs:
  - `01-ARQUITETURA.md`: C4 diagram, tech stack, decisions, constraints
  - `02-MODELO-DE-DADOS.md`: ER diagram, RLS fail-closed pattern, bronze/silver layers
  - `03-INTEGRACAO-TINY-ERP.md`: Tiny API v3 integration (OAuth2, endpoints, rate limits)
  - `04-INFRAESTRUTURA-DEPLOY.md`: Hosting (Vercel + Supabase), costs by phase
  - `05-ROADMAP.md`: Mirrored from `.planning/ROADMAP.md`, phases and success criteria

**`.github/workflows/ci.yml`:**
- Purpose: GitHub Actions CI pipeline
- Typical jobs: Lint, test, type-check (not yet populated; Phase 2+)

**`.planning/`:**
- Purpose: GSD (Getting Stuff Done) planning artifacts
- Subfolders:
  - `phases/`: Detailed phase plans (e.g., Phase 1: Infrastructure)
  - `quick/`: Quick task logs and decisions
  - `research/`: Research spike outputs and cached decisions

**`.env` (git-ignored):**
- Purpose: Environment variables for local dev
- Contains: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`, etc.
- Never committed to git

## Key File Locations

**Entry Points:**

| Endpoint | File | Trigger |
|----------|------|---------|
| GET `/functions/v1/health` | `supabase/functions/health/index.ts` | HTTP request (public, unauthenticated) |
| POST `/functions/v1/sync-enqueue` | `supabase/functions/sync-enqueue/index.ts` | Supabase Cron job (via Vault Bearer token) |
| POST `/functions/v1/sync-worker` | `supabase/functions/sync-worker/index.ts` | Manual trigger or external monitor (JWT protected) |

**Configuration:**

| Purpose | File |
|---------|------|
| Supabase settings (local dev + cloud) | `supabase/config.toml` |
| Environment secrets | `.env` (git-ignored) |
| Project context for Claude | `.claude/CLAUDE.md` |
| Cron schedule + queue + RPC wrappers | `supabase/migrations/20260729231615_cron_sync_trigger.sql` and `20260729232533_pgmq_public_wrappers.sql` |

**Core Logic:**

| What | File |
|------|------|
| Database connection (Postgres client) | `supabase/functions/_shared/db.ts` |
| Health check implementation | `supabase/functions/health/index.ts` |
| Queue producer (enqueue) | `supabase/functions/sync-enqueue/index.ts` |
| Queue consumer (dequeue + process) | `supabase/functions/sync-worker/index.ts` |

**Testing:**

| Type | Files |
|------|-------|
| Test fixtures | `tests/conftest.ts` |
| Endpoint tests | `tests/health_test.ts`, `tests/db_connection_test.ts` |
| Pipeline tests | `tests/sync_pipeline_test.ts` |
| Test runner config | `supabase/functions/deno.jsonc` |

## Naming Conventions

**Files:**

| Pattern | Example | Scope |
|---------|---------|-------|
| Functions | `sync-enqueue`, `sync-worker`, `health` | Kebab-case for Edge Function directories |
| Migrations | `20260729225411_enable_queue_extensions.sql` | Timestamp prefix (YYYYMMDDHHMMSS) + snake_case |
| Tests | `health_test.ts`, `db_connection_test.ts` | Snake_case with `_test` suffix |
| Scripts | `setup-vault-secrets.ts` | Kebab-case with descriptive action verb |
| Config | `config.toml`, `deno.json`, `deno.jsonc` | Lowercase, standard file names |

**Directories:**

| Pattern | Example | Purpose |
|---------|---------|---------|
| Functional domains | `health/`, `sync-enqueue/`, `sync-worker/` | Each Edge Function in its own directory |
| Shared code | `_shared/` | Leading underscore for internal/shared (not a public endpoint) |
| Database | `migrations/` | All SQL schema changes in one place |
| Tests | `tests/` | All Deno tests colocated, separate from source |
| Documentation | `docs/` | Markdown architecture and decision records |
| Planning | `.planning/` | GSD artifacts (phases, research, config) |

## Where to Add New Code

**New Edge Function:**
1. Create directory: `supabase/functions/{function-name}/`
2. Add `index.ts`: Export `Deno.serve(async (req) => { ... })`
3. Add `deno.json`: Declare any npm imports needed
4. Import shared client: `import { sql } from "../_shared/db.ts"`
5. Authentication: Set `verify_jwt` in `supabase/config.toml` under `[functions.{function-name}]` if public; default is protected
6. Add test: Create `tests/{function-name}_test.ts`

**New Database Table (Silver Layer):**
1. Create migration: `supabase/migrations/{timestamp}_add_${table_name}.sql`
2. Include:
   - `CREATE TABLE` with `tenant_id`, primary key, natural key indices
   - `UNIQUE (tenant_id, tiny_id)` for idempotence
   - RLS policy: `USING (tenant_id = current_setting('app.tenant_id', true)::uuid)`
3. Run: `supabase db push` to apply to local dev and cloud

**New API Endpoint (Bronze/Silver Query):**
1. Create Edge Function following "New Edge Function" above
2. Parse `authorization` header or validate JWT in request
3. Extract `tenant_id` from Supabase Auth user (via supabase-js client)
4. Use database client: `await sql`SELECT ... WHERE tenant_id = ${tenantId}``
5. Return JSON with appropriate status code

**Utility/Helper Shared Code:**
1. Add to `supabase/functions/_shared/`
2. Example: `supabase/functions/_shared/validation.ts` for input checks
3. Import in any Edge Function: `import { validate } from "../_shared/validation.ts"`

**Migration Secrets (Cron Calls, OAuth Credentials):**
1. Store in Supabase Vault using `scripts/setup-vault-secrets.ts`
2. Reference in migrations via `vault.decrypted_secrets` view:
   ```sql
   (select decrypted_secret from vault.decrypted_secrets where name = 'secret_name')
   ```
3. Never hardcode literal values in SQL

**Test:**
1. Add to `tests/` directory
2. Import helpers from `conftest.ts`: `getTestSql()`, `getHealthUrl()`
3. Use Deno.test() with assertions from `jsr:@std/assert`
4. Run: `deno test --allow-net --allow-env` from `supabase/functions/` or `tests/`

## Special Directories

**`.planning/`:**
- Purpose: GSD project management (phases, research, state tracking)
- Generated: Yes (by GSD commands)
- Committed: Yes, tracked in git as project state

**`.env`:**
- Purpose: Local environment secrets
- Generated: No (manually created from `.env.example` or Supabase dashboard)
- Committed: No (in `.gitignore`)
- Contents: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`, etc.

**`supabase/.temp/`:**
- Purpose: Supabase CLI local state (linked project, versions, schema diffs)
- Generated: Yes (by `supabase init`, `supabase link`, `supabase db push`)
- Committed: No (in `.gitignore`)

**`node_modules/` (future):**
- Purpose: npm dependencies (when frontend added)
- Generated: Yes (by `npm install`)
- Committed: No (in `.gitignore`)

---

*Structure analysis: 2026-08-01*
