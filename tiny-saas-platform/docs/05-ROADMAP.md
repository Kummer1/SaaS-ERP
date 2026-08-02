# Roadmap

> **Nota de versão**: este documento é um resumo de alto nível. A fonte de
> verdade sobre progresso, critérios de sucesso e planos executados por fase é
> `.planning/ROADMAP.md` (gerenciado pelo workflow GSD) — consulte-o para
> detalhes e status atualizado. O roadmap original de 6 fases (baseado em
> FastAPI/Celery) foi substituído pela sequência "walking skeleton" abaixo,
> alinhada à arquitetura Supabase Edge Functions descrita em `01-ARQUITETURA.md`.

## Ordem "walking skeleton"

Prova de RLS com tenants fake → OAuth2 do Tiny → primeiro sync (produtos) →
endpoint de leitura → dashboard → deploy.

## Fase 1 — Infraestrutura & Conexão ✅ concluída

- [x] Edge Function de health-check deployada em produção
- [x] Conexão Postgres via Transaction Pooler (6543), verificada contra a classe
      de bug que já quebrou o projeto anterior (`tinysaas`, commit `55b0f80`)
- [x] Migrações via Supabase CLI, aplicadas em produção
- [x] Pipeline Cron → Fila → Worker (Edge Functions) provado ponta a ponta

Ver `.planning/phases/01-infrastructure-connection-foundation/01-VERIFICATION.md`
para o relatório completo de verificação.

**Fila de sync**: implementada na Fase 1 sobre a extensão `pgmq`. Uma decisão
anterior (2026-08-01) havia optado por trocar para uma tabela Postgres simples
com polling, mas essa troca foi **revertida em 2026-08-02** depois que a quick
task 260802-hvz construiu e provou ponta a ponta o pipeline real
`sync-enqueue`/`sync-worker` sobre `pgmq` (ver `01-ARQUITETURA.md` §7 e
`02-MODELO-DE-DADOS.md` §5). `pgmq` é a escolha definitiva; não há migração
pendente.

## Fase 2 — Auth & Multi-Tenant Foundation

- [ ] Signup/login via Supabase Auth
- [ ] RLS fail-closed (`current_setting('app.tenant_id', true)`) em toda tabela
      de negócio
- [ ] Teste automatizado de acesso cruzado entre dois tenants fake, antes de
      qualquer dado real existir

## Fase 3 — Tiny OAuth2 Connect + Sync Engine (Produtos)

- [x] Fluxo OAuth2 completo (authorize → callback → tokens salvos, criptografados
      via Supabase Vault) — mockado e provado localmente (quick-260802-oam); falta validar contra o Tiny real
- [x] `sync_products` idempotente, via pipeline `sync-enqueue`/`sync-worker` sobre `pgmq`
      (cursor `sync_watermarks`, teto de 2s CPU / 150s wall-clock por invocação de Edge Function)
      — provado localmente com dois tenants (quick-260802-hvz); falta validar contra o Tiny real
- [ ] Rate limiter por tenant com estado persistido em tabela Postgres (Edge
      Function é stateless entre invocações)
- [ ] Tratamento de 429/401 conforme `03-INTEGRACAO-TINY-ERP.md`

## Fase 4 — Dashboard

- [ ] API de leitura para o dashboard (Edge Function)
- [ ] Lista de produtos sincronizados, com busca por SKU/nome
- [ ] KPI de valor total de estoque, indicador de estoque baixo
- [ ] Última sincronização + status de saúde

## Pós-MVP (fora do escopo atual)

- Sincronização de clientes e pedidos (só produtos no MVP)
- Financeiro (contas a pagar/receber via API do Tiny)
- Alertas proativos (estoque baixo, pedido parado)
- Faturamento do próprio SaaS (billing dos seus clientes)
- Reavaliar isolamento de tenant (schema-per-tenant) se algum cliente enterprise
  exigir
- Fase 2 de infraestrutura (worker dedicado) — apenas se o motor de sync estourar
  os limites de Edge Function em volume real (ver `04-INFRAESTRUTURA-DEPLOY.md` §4)
