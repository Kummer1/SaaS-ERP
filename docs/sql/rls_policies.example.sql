-- Exemplo de Row-Level Security para isolamento multi-tenant.
-- Aplicar via migração Alembic (op.execute(...)) depois que as tabelas
-- existirem — isto NÃO substitui a migração, é referência do padrão a repetir
-- em toda tabela que tenha tenant_id (customers, products, orders, order_items
-- via join, sync_watermarks, tiny_credentials, raw_tiny_payloads, users).

ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers FORCE ROW LEVEL SECURITY;  -- vale até para o dono da tabela

CREATE POLICY tenant_isolation_customers ON customers
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- repetir para products, orders, sync_watermarks, tiny_credentials,
-- raw_tiny_payloads, users:
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE products FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_products ON products
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_orders ON orders
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- IMPORTANTE: a role usada pela aplicação (não o superuser/owner) precisa
-- ser a que roda as queries, senão RLS é ignorada por padrão para o owner
-- da tabela mesmo com FORCE ROW LEVEL SECURITY em alguns cenários de
-- migração — confirme o comportamento na versão do Postgres em uso.
