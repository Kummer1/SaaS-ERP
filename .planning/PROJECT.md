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

- **Tentativa anterior**: já existe um projeto anterior (`tinysaas`, em outro diretório) que sincronizava estoque via FastAPI + Supabase + criptografia Fernet para um único recurso. Este projeto (`tiny-saas-platform`) é um recomeço do zero, mais completo — multi-tenant real desde o desenho, mais recursos sincronizados, e documentação de arquitetura já elaborada antes de qualquer código.
- **Documentação existente**: `docs/01-ARQUITETURA.md`, `02-MODELO-DE-DADOS.md`, `03-INTEGRACAO-TINY-ERP.md`, `04-INFRAESTRUTURA-DEPLOY.md` e `05-ROADMAP.md` já cobrem stack, modelo de dados (bronze/silver), fatos da API Tiny v3 (OAuth2, rate limits por plano, padrão webhook+polling), e um roadmap de 6 fases. Essa documentação é a fonte primária de decisões técnicas e deve ser respeitada nas fases de planejamento, exceto onde as decisões abaixo (Supabase, sem Celery/Redis no MVP) a substituem explicitamente.
- **Nenhum código foi escrito ainda** — este é um projeto greenfield partindo dos docs de planejamento.
- **API Tiny ERP é de terceiro**: detalhes de endpoints/rate limits devem ser revalidados na documentação oficial da Olist antes de codar cada integração (ver `docs/03-INTEGRACAO-TINY-ERP.md`).

## Constraints

- **Custo**: infraestrutura do MVP deve rodar em camadas gratuitas (Supabase free tier, backend em Render/Fly.io free tier, frontend no Vercel free tier) — é requisito, não só preferência
- **Tech stack**: Python 3.12 + FastAPI + SQLAlchemy 2.0 (async) + Alembic; PostgreSQL gerenciado pelo Supabase; React 18 + TypeScript + Vite no frontend — conforme `docs/01-ARQUITETURA.md`
- **Auth**: Supabase Auth para autenticação de usuários (substitui o JWT customizado original dos docs)
- **Sync engine (MVP)**: sem Celery/Redis — scheduler in-process + endpoint de webhook, para reduzir custo e complexidade
- **Timeline**: sem prazo fixo — prioridade é fazer certo, não rápido
- **Estágio comercial**: especulativo — sem cliente confirmado ainda; construção precede validação

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Supabase para Postgres gerenciado + Auth | Free tier cobre banco e autenticação; menos código de auth para manter | — Pending |
| Sem Celery/Redis no MVP | Redis gerenciado tem custo; scheduler in-process é suficiente para validar o conceito com poucos tenants | — Pending |
| Hosting do backend a decidir na fase de infraestrutura (Render free tier como favorito) | Supabase não hospeda backend Python; prioridade é custo zero/mínimo | — Pending |
| Frontend no Vercel free tier | Deploy gratuito, integra bem com Vite/React | — Pending |
| Multi-tenant real no desenho, mas MVP valida com 1 tenant e 1 recurso primeiro | Reduz risco: prova o motor de sync antes de escalar para múltiplos tenants/recursos | — Pending |
| Bronze layer só em Postgres/JSONB (sem object storage dedicado) | Menor custo e complexidade operacional para o MVP | — Pending |
| Multi-tenancy via row-level (`tenant_id` + RLS), não schema-per-tenant | Mantido dos docs originais — time pequeno, número de tenants crescente e desconhecido | — Pending |

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
*Last updated: 2026-07-27 after initialization*
