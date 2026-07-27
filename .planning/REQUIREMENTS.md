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
- [ ] **TINY-02**: Tokens Tiny (client_secret, access_token, refresh_token) armazenados criptografados em repouso (Fernet)
- [ ] **TINY-03**: Tenant vê o status da conexão com o Tiny (conectado/expirado/revogado)

### Sincronização

- [ ] **SYNC-01**: Sistema sincroniza produtos (SKU, nome, preço, estoque, estoque mínimo) do Tiny ERP de forma idempotente — rodar o mesmo sync duas vezes não duplica nada
- [ ] **SYNC-02**: Sync roda em agenda (scheduler in-process + gatilho de cron externo), sem exigir ação manual do tenant
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
| AUTH-01 | TBD | Pending |
| AUTH-02 | TBD | Pending |
| TINY-01 | TBD | Pending |
| TINY-02 | TBD | Pending |
| TINY-03 | TBD | Pending |
| SYNC-01 | TBD | Pending |
| SYNC-02 | TBD | Pending |
| SYNC-03 | TBD | Pending |
| SYNC-04 | TBD | Pending |
| DASH-01 | TBD | Pending |
| DASH-02 | TBD | Pending |
| DASH-03 | TBD | Pending |
| TENANT-01 | TBD | Pending |

**Coverage:**
- v1 requirements: 13 total
- Mapped to phases: 0 (preenchido pelo roadmapper)
- Unmapped: 13 ⚠️ (esperado antes da criação do roadmap)

---
*Requirements defined: 2026-07-27*
*Last updated: 2026-07-27 after initial definition*
