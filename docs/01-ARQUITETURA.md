# Arquitetura — Tiny SaaS Platform

> **Nota de versão**: este documento foi reescrito para refletir a arquitetura final
> (Supabase Edge Functions + Vercel), que substitui o desenho original baseado em
> FastAPI + Celery + Redis + Docker Compose. A Fase 1 do roadmap (infraestrutura)
> já está implementada e verificada sobre esta nova arquitetura — ver
> `.planning/ROADMAP.md` e `.planning/phases/01-infrastructure-connection-foundation/`.

## 1. Problema e escopo

SaaS multi-tenant que se conecta à conta Tiny ERP (Olist) de cada cliente, extrai
clientes, produtos/estoque e pedidos, persiste em um banco relacional próprio e
expõe essa informação via API para um dashboard front-end (KPIs de vendas, estoque,
clientes).

**Premissa assumida**: por ser chamado de "SaaS", o desenho abaixo é **multi-tenant
desde o dia 1** (múltiplas empresas/clientes, cada uma com sua própria conta Tiny).

## 2. Visão geral (C4 — nível de contêiner)

```
┌─────────────┐        HTTPS/JSON         ┌────────────────────────────────────┐
│   React SPA │ ───────────────────────▶  │   Supabase Edge Functions           │
│  (Vercel)   │ ◀───────────────────────  │   (Deno + TypeScript)               │
└─────────────┘                            │   - OAuth2 callback do Tiny         │
                                            │   - Recebimento de webhook          │
                                            │     (grava em fila)                 │
                                            │   - Funções de sync (chunked,       │
                                            │     cursor = sync_watermarks)       │
                                            │   - API de leitura (dashboard)      │
                                            └──────────────┬───────────────────┘
                                                            │
                                            ┌───────────────▼───────────────────┐
                                            │   Supabase Postgres                 │
                                            │   - bronze: raw_tiny_payloads (JSONB)│
                                            │   - silver: customers/products/orders│
                                            │   - sync_watermarks (cursor)         │
                                            │   - fila de webhook (tabela simples) │
                                            │   - rate-limit state por tenant      │
                                            │   - RLS fail-closed em toda tabela   │
                                            └───────────────▲───────────────────┘
                                                            │
                                   ┌────────────────────────┴────────────────────┐
                                   │  Supabase Cron (pg_cron + pg_net)             │
                                   │  dispara Edge Functions de sync agendadas      │
                                   │  (reconciliação por polling a cada 15-30 min)  │
                                   └────────────────────────┬────────────────────┘
                                                            │ OAuth2 + REST JSON
                                                   ┌────────▼─────────┐
                                                   │  Tiny ERP API v3   │
                                                   │  (por tenant)       │
                                                   └────────────────────┘
```

Sem containers, sem processo de longa duração próprio: tudo roda como serviço
gerenciado (Supabase, Vercel). O único "worker" é a própria Edge Function,
invocada por Cron ou por request HTTP (OAuth callback, webhook, leitura).

## 3. Stack final

| Camada | Escolha | Por quê |
|---|---|---|
| Frontend | **React + TypeScript + Vite**, hospedado no **Vercel** | SPA rápida, tipagem evita bugs de contrato com a API; deploy trivial via `git push` |
| Backend/compute | **Supabase Edge Functions (Deno + TypeScript)** | Sem servidor próprio para operar; escala a zero; integra nativamente com Postgres/Auth/Cron/Vault do mesmo projeto Supabase |
| Banco | **Postgres do Supabase** | Gerenciado, RLS nativo, extensões (`pg_cron`, `pg_net`) prontas |
| Migrações | **Supabase CLI** (`supabase/migrations/*.sql` + `supabase db push`) | Sem Alembic — não há runtime Python; CLI é a ferramenta nativa do Supabase e já está em uso desde a Fase 1 |
| Orquestração de sync | **Supabase Cron (pg_cron + pg_net)** chamando Edge Functions | Substitui Celery beat/workers — não há processo próprio de longa duração para agendar; Cron nativo do Postgres dispara HTTP para a Edge Function via `pg_net` |
| Fila do webhook | **Tabela Postgres simples com polling** (decisão confirmada — ver §7) | Sem dependência de extensão adicional; consumida por uma Edge Function de processamento em pequenos lotes |
| Autenticação da plataforma | **Supabase Auth nativo** (decisão confirmada — ver §7) | Sem JWT customizado para manter; `auth.uid()` + lookup de `tenant_id` na própria base resolve o modelo "tenant = conta de negócio", que não é 1:1 com usuário Supabase |
| Autenticação Tiny | **OAuth2** (`client_id`/`secret` por tenant) | Exigência da API v3 do Tiny — ver `03-INTEGRACAO-TINY-ERP.md` |
| Segredos em repouso | **Supabase Vault** (`vault.create_secret` / `vault.decrypted_secrets`) | Já em uso desde a Fase 1 para segredos de plataforma (URL do projeto, chave de invocação de função); mesmo padrão se aplica aos tokens OAuth do Tiny por tenant, substituindo a criptografia Fernet do desenho original (não há runtime Python para rodar Fernet) |
| Observabilidade | Logs estruturados (Supabase Edge Function logs) + revisitar Sentry se o volume justificar | Suficiente para o MVP; ver `04-INFRAESTRUTURA-DEPLOY.md` |
| Deploy | **Vercel** (frontend) + **Supabase** (banco, Auth, Edge Functions, Cron) — nenhum container próprio | Ver `04-INFRAESTRUTURA-DEPLOY.md` para o plano de custo por fase |

### Por que não...
- **FastAPI/Celery/Redis/Docker Compose (desenho original)**: exigiria hospedar um processo Python de longa duração (Render/Fly/VPS) além do Supabase, com Redis gerenciado só para o broker do Celery. Para o volume do MVP (polling a cada 15-30 min, um sync por vez), isso é overhead operacional e de custo sem benefício — Edge Functions + Cron nativo do Postgres cobrem o mesmo caso de uso com uma peça a menos na infraestrutura.
- **MongoDB**: os dados do Tiny (cliente, produto, pedido, item de pedido) têm schema bem definido e relações claras. A única parte "solta" (payload bruto da API) já fica isolada em uma coluna `JSONB` (bronze), não precisa de um banco de documentos inteiro.
- **Kubernetes**: nunca chega a ser cogitado nesta arquitetura — não há container próprio para orquestrar.

## 4. Multi-tenancy: isolamento de dados

**Decisão: isolamento por linha (`tenant_id` em toda tabela de negócio) + Postgres
Row-Level Security (RLS) fail-closed como camada de defesa.**

| Opção | Quando vence |
|---|---|
| **Row-level + RLS (escolhida)** | Time pequeno, número de tenants desconhecido/crescente, um único pool de conexões, migrações simples (uma só vez, não por tenant) |
| Schema-per-tenant | Poucos tenants (dezenas), exigência forte de isolamento físico/compliance por cliente |
| Banco-por-tenant | Só se cada cliente exigir isolamento físico total — custo operacional alto demais para o estágio atual |

**Padrão fail-closed**: toda policy RLS usa
`USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)`.
O segundo argumento `true` de `current_setting` faz a função retornar `NULL` em vez de
lançar erro quando a configuração de sessão não foi setada — mas sob connection
pooling a GUC de sessão às vezes resolve para string vazia (`''`) em vez de
`NULL` (por exemplo após um `RESET` ou troca de conexão de backend no Transaction
Pooler), e o cast direto `::uuid` de `''` lança erro em vez de negar acesso; por
isso o `NULLIF(..., '')` normaliza `''` para `NULL` antes do cast — e
`tenant_id = NULL` é sempre falso, então **a ausência do `app.tenant_id` nega
acesso por padrão**, em vez de vazar dados de todos os tenants (o oposto do que
aconteceria se a policy assumisse "sem tenant setado = acesso livre"). Cada
Edge Function seta
`SET LOCAL app.tenant_id = '<uuid>'` no início de cada transação, após resolver o
tenant a partir do usuário autenticado.

## 5. Edge Functions: limites e implicações de design

- **Teto de 2s de CPU / 150s de wall-clock por invocação.** Um sync grande (ex.:
  backfill inicial de um tenant com milhares de produtos) não cabe em uma única
  invocação. A solução é processar em pedaços: cada invocação lê o cursor em
  `sync_watermarks`, processa uma página, atualiza o cursor e retorna — a próxima
  invocação (disparada pelo Cron seguinte, ou por auto-reinvocação) continua de onde
  parou.
- **Stateless entre invocações, sem memória compartilhada.** O rate limiter por
  tenant (necessário porque o limite é da conta Tiny do cliente, não do app — ver
  `03-INTEGRACAO-TINY-ERP.md`) não pode viver em memória de processo. O estado
  (contagem de requisições na janela atual, timestamp do último 429, etc.) fica em
  uma tabela Postgres, lida e atualizada a cada invocação.

## 6. Outros pontos de risco reais deste domínio

- **Rate limit da API Tiny é por conta (não por app)** — trate 429 com backoff
  respeitando o header `Retry-After`; nunca insista além de 5 respostas 429
  seguidas (risco de bloqueio de 1h do token).
- **Webhook não é garantia de entrega** — sempre tenha um polling de reconciliação
  (a cada 15-30 min, via Supabase Cron) como rede de segurança.
- **Vazamento entre tenants é o pior bug possível em um SaaS B2B** — daí a escolha
  de RLS fail-closed em vez de confiar 100% em `WHERE` manual em cada query.
- **Fuso horário**: armazene tudo em UTC; conversão só na camada de apresentação.
- **Token OAuth expira** — implemente refresh automático e alerta se um tenant
  ficar com a integração "quebrada" (token revogado, app desconectado no Tiny).

## 7. Decisões de arquitetura resolvidas nesta sessão

| Decisão | Opções consideradas | Escolha | Racional |
|---|---|---|---|
| Autenticação da plataforma | Supabase Auth nativo vs. JWT customizado em Edge Function | **Supabase Auth nativo** | Já era a premissa de `PROJECT.md`/`REQUIREMENTS.md`/`ROADMAP.md`; confirmado explicitamente ao redefinir a arquitetura. Sem FastAPI, não há onde hospedar lógica de emissão/verificação de JWT customizado de forma natural — Supabase Auth resolve login/sessão prontos. |
| Mecanismo de fila do webhook/sync | Tabela Postgres simples com polling vs. extensão `pgmq` | **`pgmq` (revertido para permanente em 2026-08-02)** | A Fase 1 implementou `pgmq` (extensão + schema wrapper `pgmq_public` + fila `sync_work`, funcionando ponta a ponta e verificado). Em 2026-08-01 a decisão havia trocado para tabela simples, mas essa troca nunca foi implementada. Em vez disso, a quick task 260802-hvz construiu o pipeline real `sync-enqueue`/`sync-worker` diretamente sobre `pgmq` (adicionando `pgmq_public.read`/`archive` para consumo crash-safe at-least-once) e provou-o ponta a ponta com dois tenants sem cross-contamination. A decisão de trocar por tabela simples foi **revertida** com o usuário: `pgmq` é a escolha definitiva, sem migração pendente. Ver `.planning/quick/260802-hvz-.../260802-hvz-SUMMARY.md`. |

## 8. Próximo passo concreto

A Fase 1 (infraestrutura: Edge Function de health-check, conexão Postgres via
Transaction Pooler, migrações via Supabase CLI, pipeline Cron→Fila→Worker) **já
está implementada e verificada** — ver
`.planning/phases/01-infrastructure-connection-foundation/01-VERIFICATION.md`.

Próximos passos, na ordem do roadmap (`.planning/ROADMAP.md`):

1. Fase 2: Supabase Auth (signup/login) + RLS fail-closed testado com tenants
   fake (cross-tenant access test) antes de qualquer dado real existir.
2. Fase 3: fluxo OAuth2 completo de conexão com o Tiny + `sync_products` como
   primeiro recurso sincronizado, idempotente e resiliente a rate limit — o
   pipeline `sync-enqueue`/`sync-worker` sobre `pgmq` já está implementado e
   provado localmente (quick-260802-hvz); falta validar contra a API real do
   Tiny.
4. Fase 4: dashboard consumindo a API de leitura — só depois de ter dado real
   sincronizado, para não desenhar UI no escuro.

Veja `05-ROADMAP.md` (mirror deste plano) e `.planning/ROADMAP.md` (fonte de
verdade, com progresso e critérios de sucesso por fase) para o roadmap completo.
