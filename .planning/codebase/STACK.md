# Technology Stack

**Analysis Date:** 2026-08-01

## Languages

**Primary:**
- TypeScript - Used for both frontend (React SPA) and backend (Supabase Edge Functions/Deno)
- SQL - Postgres database migrations and schema definition

**Secondary:**
- HTML/CSS - Frontend markup and styling (via React/Vite)

## Runtime

**Environment:**
- Deno (Edge Functions backend compute) - TypeScript/JavaScript runtime for serverless functions
- React 18+ (Frontend SPA) - Running in browser via Vercel hosting
- Postgres 16 (Database) - Managed by Supabase

**Package Manager:**
- npm (via `npm:` protocol in Deno) - For managing dependencies in Deno modules
- Deno packages - From JSR (JSR - JavaScript Registry) for standard library
- Lockfile: Present (deno.lock in Deno projects, implied via Deno CLI)

## Frameworks

**Core:**
- React - Frontend SPA framework with TypeScript
- Vite - Frontend build tool and dev server
- Supabase Edge Functions (Deno + TypeScript) - Serverless backend compute for all API endpoints and background tasks

**Testing:**
- Deno.test - Built-in Deno test runner
- jsr:@std/assert@1 - Standard assertion library from JSR

**Build/Dev:**
- Supabase CLI - Local development stack management, migrations, function deployment
- Vercel - Frontend deployment and hosting platform

## Key Dependencies

**Critical:**
- postgres@3.4.9 - Postgres client for Edge Functions (npm package, imported via `npm:postgres` in Deno)
  - Why it matters: Only client library for connecting to Postgres from Deno; used in `supabase/functions/_shared/db.ts`
  - Configuration: Requires `{ prepare: false }` option for Transaction Pooler compatibility

**Infrastructure:**
- Supabase Auth - Native authentication provider for user login/signup/session management
- Supabase Vault - Secret management for platform secrets and per-tenant OAuth2 credentials
- Supabase Cron (pg_cron extension) - Scheduled task execution for sync reconciliation
- pg_net (Postgres extension) - HTTP dispatch from Postgres for triggering Edge Functions
- pgmq (Postgres extension) - Message queue for webhook processing (being migrated to simple polling)

## Configuration

**Environment:**
- `.env` file (contains secrets - not committed)
- Environment variables required: `DATABASE_URL` or `SUPABASE_DB_URL`, `SUPABASE_PROJECT_REF`, `SUPABASE_ACCESS_TOKEN`
- Deno per-function config: `supabase/functions/{function-name}/deno.json` for imports

**Build:**
- `supabase/config.toml` - Supabase project configuration for functions and RLS policies
- Deno.json (implied) - Deno runtime configuration
- Frontend build: Vite configuration (location: implied from `npm run build` mention in docs)

## Platform Requirements

**Development:**
- Supabase CLI (version 2.110.0+ confirmed) - For local Postgres stack, migrations, function serving
- Docker - Required by Supabase CLI for local Postgres stack (fallback: `supabase db push --dry-run --linked`)
- Node.js + npm - For frontend dependency management (implied by Vite and Vercel)
- Deno - For local function development and testing
- Git - For version control

**Production:**
- Deployment target: Vercel (frontend), Supabase (backend/database/auth)
- Supabase project (Free tier for Fase 0, Pro tier for Fase 1+)
- GitHub Actions - CI/CD pipeline (configured but remote not yet connected)

## Connection & Database Access

**Multi-port Postgres access:**
- Port 5432 (Session Pooler/Direct) - DDL/migrations only via Supabase CLI, never for runtime
- Port 6543 (Transaction Pooler) - All Edge Function runtime queries, requires `postgres.<project-ref>` username and `{ prepare: false }` in postgres.js

**Connection pooling:**
- Transaction Pooler mode: Swaps backend connections between statements (required for serverless Edge Functions)
- Uses prepared statements disabled (`prepare: false`) to prevent prepared statement caching issues

## Database Layers

**Bronze Layer:**
- `raw_tiny_payloads` - Unprocessed JSON responses from Tiny ERP API
- Purpose: Data preservation and replay capability if silver layer parsing fails

**Silver Layer:**
- `customers`, `products`, `orders` - Normalized, processed data from Tiny
- Fully isolated by `tenant_id` with RLS fail-closed policies

**Control/State Tables:**
- `sync_watermarks` - Cursor position for polling-based synchronization per tenant
- `webhook_queue` - Simple polling queue for webhook processing
- `rate_limit_state` - Per-tenant rate limit token bucket state
- `tiny_credentials` - Encrypted OAuth2 tokens per tenant (via Supabase Vault)

---

*Stack analysis: 2026-08-01*
