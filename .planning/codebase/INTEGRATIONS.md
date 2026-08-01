# External Integrations

**Analysis Date:** 2026-08-01

## APIs & External Services

**Tiny ERP (Olist):**
- Tiny ERP API v3 - Core business data (customers, products, orders, inventory)
  - SDK/Client: Custom HTTP via Deno (fetch API), no official Deno SDK
  - Auth: OAuth2 (client_id + client_secret per tenant, managed in Supabase Vault)
  - Rate limits: 60-240 requests/min depending on customer plan tier (Basic/Essencial/Grande)
  - Endpoints: `/contatos` (customers), `/produtos` (products), `/estoque` (inventory), `/pedidos` (orders)
  - Webhook support: Incoming webhooks for order/customer/product events, posted to Edge Function
  - Details: See `docs/03-INTEGRACAO-TINY-ERP.md` for API specifics, rate limiting strategy, and error handling

**n8n:**
- Integration tool used for operational automations (notifications, manual onboarding)
- Not core to product sync engine — sync motor uses Edge Functions instead
- Community node exists for Tiny ERP v3 integration

## Data Storage

**Databases:**
- Supabase Postgres (Postgres 16) - Primary operational database
  - Connection: Port 5432 (DDL/migrations via Supabase CLI), Port 6543 (runtime via Transaction Pooler)
  - Client: postgres.js v3.4.9 (npm package, imported in Deno via `npm:postgres`)
  - Schema: Bronze/silver/control layers (see STACK.md)

**File Storage:**
- Local filesystem only - No S3, GCS, or managed storage integration
- Raw payloads stored as JSONB in `raw_tiny_payloads` table

**Caching:**
- None - In-memory caching not applicable to serverless Edge Functions (stateless between invocations)
- Rate limit state stored in Postgres table (per-tenant token bucket)

## Authentication & Identity

**Auth Provider:**
- Supabase Auth (native) - User authentication for platform (login/signup/session)
  - Implementation: Native Supabase Auth without custom JWT hooks
  - Session model: Supabase `auth.uid()` + lookup to find tenant from user
  - Not used for Tiny API auth (see OAuth2 below)

**OAuth2 (Tiny Integration):**
- Each tenant authorizes their own Tiny account via OAuth2 flow
- Edge Function handles redirect callback at `/functions/v1/oauth-callback` (implicit, not shown in current code)
- Tokens (access + refresh) stored encrypted in `tiny_credentials` table via Supabase Vault

## Secrets & Credential Management

**Secrets Storage:**
- Supabase Vault - Encrypted key-value storage for platform secrets and per-tenant credentials
  - Platform secrets: Database URL, function invocation keys (set up via `scripts/setup-vault-secrets.ts`)
  - Per-tenant secrets: OAuth2 `client_secret`, `access_token`, `refresh_token` (decision: store encrypted in Vault, not plaintext in DB)

**Environment Variables:**
- GitHub Actions secrets: `DATABASE_URL`, `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_ID`, `SUPABASE_DB_PASSWORD`
- Vercel env vars: Frontend-required variables (implicit, Vercel auto-propagates from GitHub/manual config)
- Never commit `.env` file or `.env.*` files

## Monitoring & Observability

**Error Tracking:**
- Supabase Edge Function native logs - Structured logging of function execution, included in Supabase dashboard
- Sentry - Not yet integrated; flagged for evaluation when tenant volume justifies cost

**Logs:**
- Approach: Structured logging from Edge Functions (include `tenant_id` in all sync logs for filtering by customer)
- Accessible via: Supabase dashboard → Functions → Logs tab
- No central log aggregation tool (Datadog, New Relic, etc.) currently in use

**Health Monitoring:**
- Health-check endpoint: `GET /functions/v1/health` - Returns `{ status: "ok" }` HTTP 200
  - No authentication required; public endpoint
  - Implemented in `supabase/functions/health/index.ts`
- Sync status metric: Count of tenants with healthy sync vs. broken (via `tiny_credentials.status` field)

## CI/CD & Deployment

**Hosting:**
- Frontend: Vercel - React SPA auto-deploys on git push
- Backend: Supabase Edge Functions - Deployed via `supabase functions deploy` in CI/CD
- Database: Supabase managed Postgres - Migrations applied via `supabase db push` in CI/CD

**CI Pipeline:**
- GitHub Actions (configured but remote not yet connected per docs)
- Workflow: `.github/workflows/ci.yml`
  - Step 1: Smoke test - `scripts/smoke-test-db.ts` validates Postgres connection via Transaction Pooler
  - Step 2: Deno tests - `deno test` for Edge Function unit tests
  - Step 3: Frontend tests - `npm run build` and `vitest` for React tests
  - Step 4: Deploy - `supabase functions deploy` + Vercel auto-deploy (via Git integration)
- Secrets required in GitHub: `DATABASE_URL`, `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_ID`, `SUPABASE_DB_PASSWORD`

## Webhook Integration

**Incoming Webhooks:**
- Endpoint: `/functions/v1/webhook` (implicit Edge Function for Tiny events)
- Triggers: Customer created/updated, product created/updated, order created/updated
- Payload: Tiny ERP JSON webhook format (see `docs/03-INTEGRACAO-TINY-ERP.md`)
- Processing: Written to `webhook_queue` table immediately, consumed by polling Edge Function
- Retry: No retry of webhook itself; queue-based processing with polling handles missed events

**Outgoing Webhooks:**
- None to external services
- Internal use: Supabase Cron (`pg_cron` + `pg_net`) dispatches HTTP to Edge Functions for scheduled sync

## Scheduled Tasks & Queueing

**Supabase Cron (pg_cron + pg_net):**
- Triggers scheduled sync Edge Functions every 15-30 minutes
- HTTP dispatch via `pg_net` extension (native Postgres extension)
- Schedule: `*/15 * * * *` (every 15 minutes) for reconciliation polling

**Queue Mechanism:**
- Current: Simple Postgres table polling (`webhook_queue` with `SELECT ... FOR UPDATE SKIP LOCKED`)
- Planned migration: Remove `pgmq` extension (implemented in Phase 1, marked as technical debt)
- No external queue service (RabbitMQ, SQS, etc.)

## API Rate Limiting

**Tiny ERP Rate Limit Strategy:**
- Per-tenant rate limiting (not per-application) — each tenant's Tiny account has independent quota
- Implementation: Token bucket state stored in `rate_limit_state` Postgres table, updated per request
- Handling: Respect `Retry-After` header; 5 consecutive 429s can trigger 1-hour token block
- Backoff: Exponential backoff for retries (not aggressive polling on 429)

## OAuth2 Flow (Tenant Onboarding)

**Authorization Flow:**
1. Tenant initiates connection in dashboard
2. Frontend redirects to Tiny OAuth authorize URL (built via platform's `client_id`)
3. Tenant logs in and authorizes at Tiny
4. Tiny redirects to Edge Function callback with `code`
5. Edge Function exchanges `code` for `access_token` + `refresh_token`
6. Tokens stored encrypted in `tiny_credentials` table (per tenant)
7. Full sync begins (backfill)

**Token Refresh:**
- Automatic refresh via `refresh_token` when `access_token` expires (401 response)
- Failed refresh marks tenant as `status=expired` and alerts operator
- Manual reconnection required if token revoked by tenant

## Data Pipeline

**Ingest Patterns:**
- Webhook (low latency) → queue in Postgres
- Polling reconciliation (15-30 min via Cron) → catch missed events, reconcile state
- Full sync on first connection → backfill historical data in chunks

**Transform:**
- Bronze layer: Raw Tiny JSON preserved as-is in `raw_tiny_payloads` (JSONB)
- Silver layer: Parsed, normalized, and upserted via Edge Function logic (idempotent via `ON CONFLICT`)

**Data Isolation:**
- Every table has `tenant_id` column
- Row-Level Security (RLS) enforces fail-closed isolation: `USING (tenant_id = current_setting('app.tenant_id', true)::uuid)`
- Each Edge Function must set `SET LOCAL app.tenant_id = '<uuid>'` at start of transaction

## Environment & Feature Flags

**Phase 0 (Validation):**
- Supabase Free tier (auto-pause after 7 days, acceptable for dev)
- Vercel Hobby plan (free, ToS allows personal use only)
- Cost: $0/month

**Phase 1+ (First Commercial Customer):**
- Supabase Pro tier (removes auto-pause, PITR available)
- Vercel Pro plan (required by ToS once revenue exists)
- Cost: ~$45/month (Vercel $20 + Supabase $25)

---

*Integration audit: 2026-08-01*
