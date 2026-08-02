# Modelo de Dados

> **Nota de versão**: modelo bronze/silver e `sync_watermarks` permanecem como
> desenhados originalmente — validado e mantido na redefinição de arquitetura para
> Supabase Edge Functions. Ver `01-ARQUITETURA.md` para a arquitetura de execução.
> Ajustes desta revisão: sintaxe RLS fail-closed explícita (§3), tabela de fila do
> webhook (§5, nova) e observação sobre segredos via Supabase Vault em vez de
> Fernet (§3).

## 1. Estratégia: bronze/silver simplificado

Não é um data warehouse, mas vale roubar a ideia do padrão medallion em miniatura:

- **Bronze (`raw_tiny_payloads`)**: cópia exata do JSON que a API do Tiny devolveu,
  imutável, append-only, com `tenant_id`, `resource_type`, `resource_id`,
  `payload JSONB`, `fetched_at`. Serve para **replay** (se um bug de parsing for
  descoberto, você reprocessa sem chamar a API de novo) e para **auditoria**.
- **Silver (tabelas normalizadas abaixo)**: o que a API e o dashboard realmente
  consultam. Nunca transforme direto no bronze — só nele acrescenta.

## 2. Diagrama ER (silver)

```mermaid
erDiagram
    TENANTS ||--o{ USERS : has
    TENANTS ||--o{ TINY_CREDENTIALS : has
    TENANTS ||--o{ CUSTOMERS : owns
    TENANTS ||--o{ PRODUCTS : owns
    TENANTS ||--o{ ORDERS : owns
    TENANTS ||--o{ SYNC_WATERMARKS : tracks

    CUSTOMERS ||--o{ ORDERS : places
    PRODUCTS ||--o{ ORDER_ITEMS : "referenced in"
    ORDERS ||--o{ ORDER_ITEMS : contains
    PRODUCTS ||--o{ INVENTORY_MOVEMENTS : has

    TENANTS {
        uuid id PK
        text name
        text plan
        timestamptz created_at
    }
    TINY_CREDENTIALS {
        uuid id PK
        uuid tenant_id FK
        text client_id
        text encrypted_client_secret
        text encrypted_refresh_token
        text encrypted_access_token
        timestamptz token_expires_at
        text status "connected|expired|revoked"
    }
    CUSTOMERS {
        uuid id PK
        uuid tenant_id FK
        bigint tiny_id "id do contato no Tiny"
        text name
        text document "CPF/CNPJ"
        text email
        jsonb address
        timestamptz tiny_updated_at
        timestamptz synced_at
    }
    PRODUCTS {
        uuid id PK
        uuid tenant_id FK
        bigint tiny_id
        text sku
        text name
        numeric price
        int stock_quantity
        timestamptz tiny_updated_at
        timestamptz synced_at
    }
    ORDERS {
        uuid id PK
        uuid tenant_id FK
        bigint tiny_id
        uuid customer_id FK
        text status
        numeric total_amount
        timestamptz placed_at
        timestamptz synced_at
    }
    ORDER_ITEMS {
        uuid id PK
        uuid order_id FK
        uuid product_id FK
        int quantity
        numeric unit_price
    }
    INVENTORY_MOVEMENTS {
        uuid id PK
        uuid product_id FK
        text movement_type "in|out|adjustment"
        int quantity
        timestamptz occurred_at
    }
    SYNC_WATERMARKS {
        uuid id PK
        uuid tenant_id FK
        text resource_type "customers|products|orders|stock"
        timestamptz last_synced_at
        text last_cursor
    }
```

## 3. Regras de modelagem que importam

- **Chave natural + tenant**: toda tabela sincronizada do Tiny tem
  `UNIQUE (tenant_id, tiny_id)`. É essa constraint que viabiliza
  `INSERT ... ON CONFLICT DO UPDATE` idempotente — rodar o mesmo sync duas vezes
  não duplica nada.
- **`sync_watermarks`**: uma linha por `(tenant, tipo de recurso)` guardando o
  timestamp do último registro processado com sucesso. Todo job de sync lê esse
  watermark, busca "atualizados desde X menos uma margem de segurança (ex.: 10 min)"
  e nunca "desde sempre" — evita reprocessar o histórico inteiro a cada rodada.
- **Segredos nunca em texto puro**: `client_secret`, `access_token` e
  `refresh_token` do Tiny ficam criptografados em repouso via **Supabase Vault**
  (`vault.create_secret` / `vault.decrypted_secrets`), nunca em log, nunca
  retornados por nenhum endpoint da API. Substitui a criptografia Fernet do
  desenho original — não há runtime Python para rodar Fernet, e o padrão Vault já
  está em uso desde a Fase 1 para segredos de plataforma.
- **RLS fail-closed**: cada tabela de negócio tem uma policy
  `USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)`.
  O `true` em `current_setting` faz retornar `NULL` (em vez de erro) quando a
  sessão não setou `app.tenant_id` — mas sob connection pooling a GUC também
  pode resolver para string vazia (`''`), não só ficar totalmente ausente, e
  o cast direto de `''` para `uuid` lança erro; por isso o cast é envolto em
  `NULLIF(..., '')`, que normaliza `''` para `NULL` antes de comparar — e
  `tenant_id = NULL` é sempre falso, então a ausência da configuração **nega**
  acesso por padrão. Cada Edge Function faz
  `SET LOCAL app.tenant_id = '<uuid>'` no início da transação, após resolver o
  tenant do usuário autenticado via Supabase Auth.

## 4. Índices mínimos do dia 1

```sql
CREATE UNIQUE INDEX ux_customers_tenant_tiny ON customers (tenant_id, tiny_id);
CREATE UNIQUE INDEX ux_products_tenant_tiny  ON products  (tenant_id, tiny_id);
CREATE UNIQUE INDEX ux_orders_tenant_tiny    ON orders    (tenant_id, tiny_id);
CREATE INDEX ix_orders_tenant_placed_at      ON orders    (tenant_id, placed_at DESC);
CREATE INDEX ix_products_tenant_sku          ON products  (tenant_id, sku);
```

Quando alguma tabela passar de ~50M linhas (não é o caso no MVP), considere
particionamento por `tenant_id` (hash) ou por data (`placed_at`, range mensal).

## 5. Fila de sync (`pgmq`)

Decisão confirmada (revertida em 2026-08-02 — ver histórico abaixo): a fila que
recebe trabalho de sincronização (produtos, e futuramente outros recursos) usa
a extensão `pgmq` via o schema wrapper `pgmq_public`, não uma tabela Postgres
simples.

- `pgmq.q_sync_work` — fila física, provisionada pela extensão `pgmq`.
- `pgmq_public.send`/`pop` — wrappers `SECURITY DEFINER`, `service_role`-only, criados na Fase 1.
- `pgmq_public.read`/`archive` — wrappers adicionados na quick task 260802-hvz para consumo crash-safe (visibility timeout + archive explícito), substituindo `pop` (delete-on-read, sem retry) nos consumidores reais.

Um produtor (`sync-enqueue`) decide quem precisa sincronizar (via `sync_watermarks`) e chama `pgmq_public.send`. Um consumidor (`sync-worker`) chama `pgmq_public.read` em lotes limitados, processa cada mensagem (busca o recurso na API do Tiny, grava bronze + faz upsert idempotente em silver + avança o watermark) e só então chama `pgmq_public.archive` — se o worker cair no meio, a mensagem volta a ficar visível após o timeout e é reprocessada com segurança (upsert idempotente).

**Histórico da decisão**: a Fase 1 implementou e verificou o pipeline Cron→Fila→Worker usando `pgmq`. Em 2026-08-01, a redefinição de arquitetura trocou essa escolha por uma tabela Postgres simples (`webhook_queue`), declarando `pgmq` como dívida técnica a migrar antes da Fase 3 depender da fila. Essa migração nunca foi feita; em vez disso, a quick task 260802-hvz (2026-08-02) construiu o pipeline real `sync-enqueue`/`sync-worker` diretamente sobre `pgmq` e provou-o ponta a ponta (dois tenants, enqueue, supressão por watermark, isolamento entre tenants, tratamento de 401 — zero cross-contamination). Diante da evidência, a decisão de trocar para tabela simples foi **revertida**: `pgmq` é a escolha definitiva, sem migração pendente. Ver `.planning/quick/260802-hvz-.../260802-hvz-SUMMARY.md`.
