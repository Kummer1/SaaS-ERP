# Tiny SaaS Platform

## What This Is

SaaS multi-tenant que se conecta à conta Tiny ERP (Olist) de cada cliente, sincroniza
clientes, produtos/estoque e pedidos para um banco de dados próprio, e expõe essa
informação via dashboard web (KPIs de vendas, estoque, clientes). Pensado para ser
oferecido a múltiplas empresas que usam Tiny ERP, cada uma conectando sua própria conta.

## Core Value

Um tenant consegue conectar sua conta Tiny ERP e ver, no dashboard, um recurso
sincronizado corretamente e de forma confiável. Provar que o motor de sincronização
funciona ponta a ponta é o que valida o produto — antes de expandir recursos ou
escalar para múltiplos tenants.

## Business Context

- **Customer**: Pequenas/médias empresas que usam Tiny ERP e querem um dashboard próprio de vendas/estoque/clientes
- **Revenue model**: SaaS por assinatura (modelo de cobrança ainda não definido — billing fica fora do MVP)
- **Success metric**: MVP — 1 tenant com sync funcionando ponta a ponta. Pós-MVP — número de tenants ativos com sync saudável (`tiny_credentials.status = connected`)
- **Strategy notes**: —

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] Tenant pode se cadastrar/logar via Supabase Auth
- [ ] Tenant pode conectar sua conta Tiny ERP via OAuth2 (authorize → callback → tokens salvos criptografados)
- [ ] Sistema sincroniza produtos (primeiro recurso) do Tiny ERP para o banco próprio, de forma idempotente
- [ ] Tenant vê os produtos sincronizados no dashboard
- [ ] Isolamento entre tenants garantido via `tenant_id` + RLS no Postgres desde o primeiro tenant

### Out of Scope

- Billing/faturamento do próprio SaaS — adiado para pós-MVP (Fase 6 do roadmap original em `docs/05-ROADMAP.md`)
- Celery + Redis — adiado; MVP usa scheduler simples in-process (ex: APScheduler) + endpoint de webhook, para evitar custo de Redis gerenciado
- Object storage dedicado para payload bruto da Tiny — bronze layer (`raw_tiny_payloads`) mora só em Postgres/JSONB no Supabase
- Sincronização de financeiro (contas a pagar/receber) — fora do escopo do MVP
- Alertas proativos (estoque baixo, pedido parado) — pós-MVP
- Sincronização de clientes e pedidos no primeiro corte — MVP prova o conceito com um único recurso (produtos) antes de expandir

## Context

- **Tentativa anterior**: já existe um projeto anterior (`tinysaas`, em outro diretório) que sincronizava estoque via FastAPI + Supabase + criptografia Fernet para um único recurso. Este projeto (`tiny-saas-platform`) é um recomeço do zero, mais completo — multi-tenant real desde o desenho, mais recursos sincronizados.
- **Redefinição de arquitetura (2026-08-01)**: a arquitetura original em `docs/01-05*.md` (Python/FastAPI + SQLAlchemy + Alembic + Celery + Redis + Docker Compose) foi substituída por Supabase Edge Functions (Deno + TypeScript) + Vercel, sem containers próprios. A Fase 1 do roadmap (infraestrutura) já havia sido implementada e verificada **sobre a nova arquitetura** antes mesmo dessa redefinição formal dos docs ser feita — ou seja, o código já estava à frente da documentação. Todos os `docs/*.md` foram reescritos nesta sessão para refletir o que já está implementado e as decisões confirmadas (ver Key Decisions).
- **Documentação existente**: `docs/01-ARQUITETURA.md`, `02-MODELO-DE-DADOS.md`, `03-INTEGRACAO-TINY-ERP.md`, `04-INFRAESTRUTURA-DEPLOY.md` e `05-ROADMAP.md` cobrem a stack final (Supabase Edge Functions + Vercel), modelo de dados (bronze/silver), fatos da API Tiny v3 (OAuth2, rate limits por plano, padrão webhook+polling), e o roadmap de 4 fases (walking skeleton). Esta documentação é a fonte primária de decisões técnicas.
- **Fase 1 (infraestrutura) já implementada e verificada** — ver `.planning/ROADMAP.md` e `.planning/phases/01-infrastructure-connection-foundation/01-VERIFICATION.md`. Não é mais greenfield: há código real em produção (Supabase project `fctojovbgzxvptyabjhy`) desde a Fase 1.
- **Dívida técnica declarada**: a fila de webhook implementada na Fase 1 usa a extensão `pgmq`. A redefinição de arquitetura confirmou tabela Postgres simples com polling como decisão final — a migração de `pgmq` para tabela simples é pendente, a resolver antes da Fase 3 depender da fila.
- **API Tiny ERP é de terceiro**: detalhes de endpoints/rate limits devem ser revalidados na documentação oficial da Olist antes de codar cada integração (ver `docs/03-INTEGRACAO-TINY-ERP.md`).

## Constraints

- **Custo por fase**: Fase 0 (validação, sem cliente pagando) — Supabase Free + Vercel Hobby, US$0/mês. Fase 1 (primeiro cliente pagante) — Vercel Pro (US$20/mês, obrigatório por ToS assim que há receita) + Supabase Pro (US$25/mês, remove auto-pause de 7 dias que quebraria recebimento de webhook), ~US$45/mês. Fase 2 (se o motor de sync estourar limites de Edge Function em volume real) — worker dedicado (Render ~US$15-20/mês ou AWS Lambda+EventBridge+SQS), banco/Auth/Storage seguem no Supabase sem mudança de schema. Ver `docs/04-INFRAESTRUTURA-DEPLOY.md` §4.
- **Tech stack**: React + TypeScript + Vite (frontend, Vercel) + Supabase Edge Functions (Deno + TypeScript) para todo o compute (callback OAuth2, webhook, sync agendado, API de leitura) + Postgres do Supabase; migrações via Supabase CLI (`supabase/migrations/*.sql` + `supabase db push`), sem Alembic — conforme `docs/01-ARQUITETURA.md`. Substitui o desenho original em Python/FastAPI/SQLAlchemy/Alembic.
- **Auth**: Supabase Auth nativo para autenticação de usuários (decisão confirmada em 2026-08-01, ao redefinir a arquitetura — não há JWT customizado)
- **Multi-tenancy**: `tenant_id` em toda tabela de negócio + RLS fail-closed (`current_setting('app.tenant_id', true)`)
- **Modelo de dados**: bronze (`raw_tiny_payloads`, JSONB imutável) → silver (`customers`, `products`, `orders`, `order_items`) + `sync_watermarks` como cursor de paginação incremental por (tenant, recurso)
- **Conexão Postgres**: porta 5432 (direta) só para migração/DDL via Supabase CLI; porta 6543 (Transaction Pooler, `prepare:false`) para runtime da aplicação — nunca confundir as duas
- **Sync engine (MVP)**: sem Celery/Redis — Supabase Cron (pg_cron + pg_net) dispara Edge Functions agendadas + endpoint de webhook gravando em fila. Fila = tabela Postgres simples com polling (decisão confirmada em 2026-08-01, substitui o `pgmq` já implementado na Fase 1 — migração é dívida técnica pendente, ver Key Decisions)
- **Edge Functions**: teto de 2s CPU / 150s wall-clock por invocação — sync grande processado em pedaços entre múltiplas invocações, usando `sync_watermarks` como cursor de continuação. Rate limit por tenant (a API do Tiny limita por conta do cliente, não por app) precisa de estado persistido em tabela Postgres, já que Edge Functions são stateless entre invocações.
- **Timeline**: sem prazo fixo — prioridade é fazer certo, não rápido
- **Estágio comercial**: especulativo — sem cliente confirmado ainda; construção precede validação

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Backend/compute 100% Supabase Edge Functions (Deno + TypeScript), sem FastAPI/Python | Sem servidor próprio para operar; escala a zero; integra nativamente com Postgres/Auth/Cron/Vault do mesmo projeto Supabase. Substitui o desenho original ao ser formalizado em 2026-08-01, mas a Fase 1 já havia sido construída sobre essa premissa. | ✓ Implementado (Fase 1) |
| Migrações via Supabase CLI (`supabase db push`), sem Alembic | Sem runtime Python para rodar Alembic; CLI é a ferramenta nativa do Supabase | ✓ Implementado (Fase 1) |
| Autenticação da plataforma: Supabase Auth nativo (não JWT customizado) | Confirmado explicitamente em 2026-08-01 ao redefinir a arquitetura; já era a premissa de REQUIREMENTS.md/ROADMAP.md. Sem FastAPI, não há onde hospedar lógica de JWT customizado de forma natural. | — Pending (Fase 2) |
| Mecanismo de fila do webhook: tabela Postgres simples com polling (não `pgmq`) | Confirmado explicitamente em 2026-08-01. A Fase 1 já havia implementado `pgmq` (extensão + wrapper `pgmq_public` + fila `sync_work`), funcional e verificado. Decisão final troca por tabela simples — **dívida técnica**: migração pendente antes da Fase 3 depender da fila. | — Pending migração (antes da Fase 3) |
| Segredos em repouso via Supabase Vault (não Fernet) | Sem runtime Python para Fernet; Vault já em uso desde a Fase 1 para segredos de plataforma (`vault.create_secret`/`vault.decrypted_secrets`); mesmo padrão se aplica aos tokens OAuth do Tiny por tenant | — Pending (Fase 3, tiny_credentials) |
| Plano de custo por fase (Fase 0: $0 → Fase 1: ~$45/mês → Fase 2: worker dedicado se necessário) | Infraestrutura acompanha estágio comercial, não decisão técnica antecipada; Vercel Hobby é ToS-incompatível com uso comercial | — Pending |
| Multi-tenant real no desenho, mas MVP valida com 1 tenant e 1 recurso primeiro | Reduz risco: prova o motor de sync antes de escalar para múltiplos tenants/recursos | — Pending |
| Bronze layer só em Postgres/JSONB (sem object storage dedicado) | Menor custo e complexidade operacional para o MVP | — Pending |
| Multi-tenancy via row-level (`tenant_id` + RLS fail-closed), não schema-per-tenant | Time pequeno, número de tenants crescente e desconhecido; `current_setting('app.tenant_id', true)` nega acesso por padrão quando a sessão não seta o tenant | — Pending (Fase 2) |
| Conexão Postgres: porta 5432 direta só para DDL, porta 6543 (Transaction Pooler, `prepare:false`) para runtime | Edge Functions são o caso serverless/conexões-curtas para o qual o Transaction Pooler é o encaixe correto; evita a classe de bug que já quebrou o projeto anterior (`tinysaas`, commit `55b0f80`) | ✓ Implementado e verificado (Fase 1) |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-08-01 after architecture redefinition (Supabase Edge Functions + Vercel)*
