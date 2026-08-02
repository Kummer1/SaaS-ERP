# Requirements: Tiny SaaS Platform

**Defined:** 2026-07-27
**Core Value:** Um tenant consegue conectar sua conta Tiny ERP e ver, no dashboard, um recurso sincronizado corretamente e de forma confiável.

## v1 Requirements

Requirements for initial release (MVP). Each maps to roadmap phases.

### Auth

- [ ] **AUTH-01**: Usuário se cadastra e loga via Supabase Auth
- [ ] **AUTH-02**: Sessão do usuário persiste entre refreshs do navegador

### Integração Tiny

- [ ] **TINY-01**: Tenant conecta sua conta Tiny ERP via OAuth2 (authorize → callback → tokens salvos)
- [ ] **TINY-02**: Tokens Tiny (client_secret, access_token, refresh_token) armazenados criptografados em repouso (Supabase Vault — substitui Fernet do desenho original, sem runtime Python)
- [ ] **TINY-03**: Tenant vê o status da conexão com o Tiny (conectado/expirado/revogado)

### Sincronização

- [x] **SYNC-01**: Sistema sincroniza produtos (SKU, nome, preço, estoque, estoque mínimo) do Tiny ERP de forma idempotente — rodar o mesmo sync duas vezes não duplica nada
- [x] **SYNC-02**: Sync roda em agenda (Supabase Cron — `pg_cron` + `pg_net` — disparando Edge Functions), sem exigir ação manual do tenant
- [ ] **SYNC-03**: Tenant vê "última sincronização" e status de saúde do sync
- [ ] **SYNC-04**: Sistema respeita o rate limit da Tiny por tenant (backoff em `429`, honra `Retry-After`, evita bloqueio de 1h por 5 respostas 429 seguidas)

### Dashboard

- [ ] **DASH-01**: Tenant vê lista de produtos sincronizados com busca por SKU/nome
- [ ] **DASH-02**: Tenant vê valor total de estoque (KPI: `SUM(price * stock_quantity)`)
- [ ] **DASH-03**: Tenant vê indicador de estoque baixo (produtos abaixo do estoque mínimo)

### Multi-tenancy

- [ ] **TENANT-01**: Isolamento de dados entre tenants garantido via `tenant_id` + Postgres RLS desde o primeiro tenant, validado por teste automatizado de acesso cruzado entre dois tenants

## v2 Requirements

Deferred to future release. Tracked but not in current roadmap.

### Recursos adicionais

- **RES-01**: Sincronização de clientes (contatos) do Tiny
- **RES-02**: Sincronização de pedidos e itens de pedido do Tiny

### Analytics

- **ANLY-01**: KPIs de vendas (faturamento por período, ticket médio, contagem de pedidos)
- **ANLY-02**: Curva ABC (ranking de produtos por valor de venda)
- **ANLY-03**: Tendência histórica de valor/quantidade de estoque ao longo do tempo

### Notificações

- **NOTF-01**: Entrega proativa de alerta de estoque baixo por email
- **NOTF-02**: Entrega proativa de alerta de estoque baixo por WhatsApp

### Operação multi-tenant

- **OPS-01**: Múltiplos tenants ativos simultaneamente com monitoramento de saúde de sync agregado

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| Billing/faturamento do próprio SaaS | Ainda especulativo, sem cliente confirmado — cobrar antes de validar valor é prematuro |
| Sincronização bidirecional (escrever de volta no Tiny) | Transforma camada de leitura em problema de conflito de sistema-de-registro; alto risco, baixo valor no MVP |
| Report builder / BI customizado | Compete com a tese do produto (dashboard opinativo, zero-config); custo de suporte escala com cada combinação possível |
| Kits/variações com fidelidade total de estoque | Complexidade real de modelagem; sincronizar como SKU normal é suficiente até um cliente real exigir precisão de kit |
| Quebra por múltiplos depósitos/CDs | Fora do perfil de cliente-alvo (pequena/média empresa); adiciona uma dimensão inteira a cada query |
| Sincronização financeira (contas a pagar/receber) | Erros aqui têm consequência fiscal/legal, não só "número errado na tela" — já excluído no PROJECT.md |
| Board público de votação de features | Sem base de usuários real ainda, expõe um produto vazio e convida scope creep sem filtro |
| Real-time via websocket | Webhook + polling de reconciliação já entrega frescor suficiente para o perfil de uso (poucas checagens por dia), sem custo de infra de streaming |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| AUTH-01 | Phase 2 | Pending |
| AUTH-02 | Phase 2 | Pending |
| TINY-01 | Phase 3 | Pending |
| TINY-02 | Phase 3 | Pending |
| TINY-03 | Phase 3 | Pending |
| SYNC-01 | Phase 3 | Complete |
| SYNC-02 | Phase 3 | Complete |
| SYNC-03 | Phase 4 | Pending |
| SYNC-04 | Phase 3 | Pending |
| DASH-01 | Phase 4 | Pending |
| DASH-02 | Phase 4 | Pending |
| DASH-03 | Phase 4 | Pending |
| TENANT-01 | Phase 2 | Pending |

**Coverage:**

- v1 requirements: 13 total
- Mapped to phases: 13
- Unmapped: 0 ✓

---
*Requirements defined: 2026-07-27*
*Last updated: 2026-08-01 — wording aligned to Supabase Edge Functions architecture (TINY-02: Vault replaces Fernet; SYNC-02: Supabase Cron replaces in-process scheduler). No requirement scope changed, only mechanism wording.*
