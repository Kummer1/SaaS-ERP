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

- **Custo por fase**: Fase 0 (validação, sem cliente pagando) roda em camadas gratuitas — Supabase Free + Vercel Hobby, US$0/mês. Fase 1 (primeiro cliente pagante) sobe para Vercel Pro (US$20/mês, obrigatório por ToS assim que há receita) + Supabase Pro (US$25/mês, remove auto-pause de 7 dias), ~US$45/mês. Ver `docs/04-INFRAESTRUTURA-DEPLOY.md` §4.
- **Tech stack**: React + TypeScript + Vite (frontend, Vercel) + Supabase Edge Functions (Deno + TypeScript) para compute + Postgres do Supabase (banco); migrações via Supabase CLI — conforme `docs/01-ARQUITETURA.md`. Substitui o desenho original em Python/FastAPI/SQLAlchemy/Alembic.
- **Auth**: Supabase Auth nativo para autenticação de usuários (decisão confirmada — não há JWT customizado)
- **Sync engine (MVP)**: sem Celery/Redis — Supabase Cron (pg_cron + pg_net) dispara Edge Functions agendadas + Edge Function de recebimento de webhook, gravando em fila (tabela Postgres simples com polling — decisão confirmada, substitui o `pgmq` implementado na Fase 1; migração é dívida técnica pendente)
- **Multi-tenancy**: `tenant_id` em toda tabela de negócio + RLS fail-closed (`current_setting('app.tenant_id', true)`)
- **Conexão Postgres**: porta 5432 (direta) só para migração/DDL; porta 6543 (Transaction Pooler, `prepare:false`) para runtime da aplicação — nunca confundir as duas
- **Timeline**: sem prazo fixo — prioridade é fazer certo, não rápido
- **Estágio comercial**: especulativo — sem cliente confirmado ainda; construção precede validação

<!-- GSD:project-end -->

<!-- GSD:stack-start source:research/STACK.md -->

## Technology Stack

> **Nota de versão**: esta seção foi reescrita na redefinição de arquitetura
> (2026-08-01) para refletir a stack final (Supabase Edge Functions), que
> substitui a stack Python/FastAPI abaixo. O source original desta seção
> (`.planning/research/STACK.md`) segue com o conteúdo Python antigo por ser um
> artefato de pesquisa histórico da inicialização do projeto — não é regenerado
> automaticamente a partir daqui; esta edição é a fonte viva.

## Stack Final

### Core

| Technology | Purpose | Why |
|------------|---------|-----|
| React + TypeScript + Vite | Frontend SPA, hospedado no Vercel | Já validado desde a inicialização do projeto; tipagem evita bugs de contrato com a API |
| **Deno + TypeScript** (Supabase Edge Functions) | Todo o compute do backend: callback OAuth2 do Tiny, endpoint de webhook, funções de sync agendadas, API de leitura | Runtime nativo do Supabase para Edge Functions — sem servidor próprio para operar, escala a zero. Substitui Python/FastAPI. |
| `postgres.js` (via `npm:postgres` no Deno) | Cliente Postgres nas Edge Functions | Já em uso e verificado na Fase 1 (`supabase/functions/_shared/db.ts`) — conectado via Transaction Pooler (porta 6543) com `{ prepare: false }`, evitando o bug de prepared statements sob pooler em modo transação. |
| Supabase (Postgres 16 gerenciado + Auth + Edge Functions + Cron + Vault) | Plataforma inteira do backend | Um único projeto cobre banco, autenticação, compute e agendamento — sem peças de infra adicionais para operar. |
| Supabase CLI | Migrações (`supabase/migrations/*.sql` + `supabase db push`), deploy de Edge Functions, dev local | Substitui Alembic — não há runtime Python. Já em uso desde a Fase 1 (versão confirmada em produção: 2.110.0 no momento da Fase 1; confirme a versão atual ao instalar). |
| Supabase Cron (`pg_cron` + `pg_net`) | Agendamento de sync (polling de reconciliação a cada 15-30 min) | Substitui Celery beat — nativo do Postgres, dispara HTTP para Edge Functions via `pg_net`. Já implementado e verificado na Fase 1 (`sync-enqueue-trigger`, `*/15 * * * *`). |
| Supabase Auth | Autenticação de usuários (signup/login/sessão) | Decisão confirmada na redefinição de arquitetura — sem JWT customizado. |
| Supabase Vault (`vault.create_secret` / `vault.decrypted_secrets`) | Segredos em repouso (chaves de plataforma; tokens OAuth do Tiny por tenant) | Substitui `cryptography`/Fernet (biblioteca Python) — já em uso desde a Fase 1 para segredos de plataforma (`scripts/setup-vault-secrets.ts`). |
| `Deno.test` | Testes das Edge Functions | Já em uso desde a Fase 1 (`tests/health_test.ts`, `tests/db_connection_test.ts`, `tests/sync_pipeline_test.ts`). |

### O que muda em relação à pesquisa original (`research/STACK.md`)

A pesquisa de stack feita na inicialização do projeto (2026-07-27) recomendava
Python 3.12 + FastAPI + SQLAlchemy 2.0 + Alembic + psycopg3 + APScheduler + PyJWT.
Essa recomendação foi **descartada** ao redefinir a arquitetura para Supabase
Edge Functions — não há mais processo Python de longa duração para hospedar
FastAPI/APScheduler, nem SQLAlchemy/Alembic (sem ORM Python), nem PyJWT (Supabase
Auth nativo cobre emissão/verificação de sessão). Pontos da pesquisa original que
**seguem válidos** porque descrevem comportamento do Supabase/Postgres, não do
runtime da aplicação:
- A distinção Session Pooler (5432) vs. Transaction Pooler (6543) e o risco de
  prepared statements vazando sob pooler em modo transação — mas a conclusão
  **inverte**: Edge Functions são exatamente o caso "serverless, conexões
  curtas" que a pesquisa original atribuía à Transaction Pooler, então **6543 com
  `prepare:false` é a escolha correta aqui** (confirmado em produção na Fase 1),
  ao contrário da recomendação de Session Pooler feita para um processo Python de
  longa duração.
- O alerta sobre reconstruir `DATABASE_URL`/`SUPABASE_DB_URL` a partir de partes
  separadas em vez de copiar a connection string completa — mesma classe de bug
  que já quebrou o projeto anterior (`tinysaas`, commit `55b0f80`); `_shared/db.ts`
  lê a string completa de uma única env var, nunca reconstrói.
- O aviso sobre Vercel Hobby ser ToS-incompatível com uso comercial — segue
  válido, refletido no plano de custo por fase (`docs/04-INFRAESTRUTURA-DEPLOY.md` §4).
- O aviso sobre Auth Hooks customizados do Supabase serem potencialmente gated a
  planos Teams/Enterprise — segue relevante: a decisão desta redefinição foi por
  Supabase Auth nativo sem depender de Custom Access Token Hooks; o padrão
  `SET LOCAL app.tenant_id` + RLS (ver `docs/01-ARQUITETURA.md` §4) resolve o
  isolamento sem precisar injetar `tenant_id` no JWT.

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| FastAPI/SQLAlchemy/Alembic/Celery/Redis (stack original) | Exige hospedar um processo Python de longa duração além do Supabase; overhead de custo/operação sem benefício para o volume do MVP. | Supabase Edge Functions (Deno/TypeScript) + Supabase Cron — ver tabela acima. |
| Reconstruir `DATABASE_URL` a partir de host/usuário/senha separados | Classe exata de bug que já quebrou o projeto anterior (`tinysaas`, commit `55b0f80`) — o usuário do pooler precisa ser `postgres.<project-ref>`, não `postgres` puro. | Copiar a connection string completa fornecida pelo Supabase para cada porta/modo; nunca montar a partir de partes. |
| Porta 5432 (direta) para runtime da aplicação | Reservada para migração/DDL via Supabase CLI. | Porta 6543 (Transaction Pooler, `{ prepare: false }`) para toda conexão em runtime — já o padrão em `_shared/db.ts`. |
| `pgmq` como mecanismo de fila (implementado na Fase 1) | Decisão confirmada na redefinição de arquitetura: substituir por tabela Postgres simples com polling. A implementação `pgmq` segue funcional no banco, mas é dívida técnica a migrar antes da Fase 3 — ver `.planning/STATE.md`. | Tabela `webhook_queue` (ver `docs/02-MODELO-DE-DADOS.md` §5), consumida via `SELECT ... FOR UPDATE SKIP LOCKED`. |
| Vercel Hobby plan para deploy comercial/pago | ToS do Hobby é explicitamente uso pessoal não-comercial. Uma SaaS cobrada é uso comercial mesmo em early access. | Vercel Pro (~US$20/mês) a partir da Fase 1 (primeiro cliente pagante) — ver `docs/04-INFRAESTRUTURA-DEPLOY.md` §4. |

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
