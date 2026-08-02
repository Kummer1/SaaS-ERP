# Feature Research

**Domain:** Tiny ERP integration / "ERP data → dashboard" SaaS for small/medium Brazilian businesses
**Researched:** 2026-07-27
**Confidence:** MEDIUM (cross-checked complaint patterns and existing BI-vendor offerings on top of Tiny; generic inventory-dashboard feature lists are LOW-confidence industry boilerplate, not Tiny-specific)

## Feature Landscape

### Table Stakes (Users Expect These)

Features users assume exist. Missing these = product feels incomplete, or the product isn't better than what Tiny already offers for free.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Reliable, idempotent sync of the connected resource | This is the entire value proposition — if sync silently drops/duplicates records, the product is worse than Tiny's own screens | MEDIUM | Already designed into the data model (`UNIQUE(tenant_id, tiny_id)` + upsert). Non-negotiable for even the narrowest MVP. |
| Visible sync status ("last synced at", success/error) | Users on ReclameAqui already distrust Tiny's own stock/order reliability after the Olist acquisition; a black-box sync with no status feedback reproduces that same trust problem | LOW | A `sync_watermarks` row per tenant/resource already gives you `last_synced_at` — surface it in the UI as the very first "trust" signal. |
| SKU / product search and filter | Every generic inventory-dashboard reference and Tiny's own product module treat name/SKU search as baseline; without it a product list is unusable past ~30 rows | LOW | Simple `ILIKE` on `sku`/`name` scoped by `tenant_id`. Works with products-only data — MVP-eligible. |
| Low-stock indicator/alert (view, not necessarily push notification) | Tiny only ships a "products below minimum stock" report as of a fairly late version (3.43) and gates most new features behind a public feature-voting backlog; a competing dashboard that makes this a first-class, always-on view is a direct answer to a documented gap | LOW–MEDIUM | Requires a `min_stock` or reorder-point concept. Tiny's product record has a minimum-stock field synced from the API — pull it in with `stock_quantity` and flag `stock_quantity <= min_stock`. In-app badge is LOW; push notification (email/webhook) is MEDIUM and belongs post-MVP per PROJECT.md's explicit "alertas proativos" exclusion. |
| Total inventory value ("quanto tenho parado em estoque") | Universally the #1 KPI on every inventory-dashboard reference found (Bold BI, Klipfolio, Knack); it's the single number a small-business owner checks most often | LOW | `SUM(price * stock_quantity)` per tenant. Trivial with products-only data — MVP-eligible and high perceived value for low effort. |
| Multi-tenant data isolation (invisible to the user, but a trust table-stake) | A SaaS selling to multiple independent Brazilian businesses cannot leak data across tenants even by accident — this is assumed, not requested | MEDIUM | Already covered by RLS + `tenant_id` in the data model; call out as table stakes because getting this wrong is the one mistake that ends the product, not just annoys a user. |
| Simple, working OAuth2 connect flow to Tiny | Any "connect your ERP" product lives or dies on whether the connect step works smoothly; Tiny users already report friction and unreliable behavior with the platform post-Olist, so the integration step needs to feel more solid than Tiny itself | MEDIUM | Already scoped in PROJECT.md active requirements (authorize → callback → encrypted token storage). |

### Differentiators (Competitive Advantage)

Features that set the product apart from Tiny's native dashboard and from generic "connect to Power BI" alternatives (Kondado, Irroba, Integrai) already serving this niche.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Zero-setup, opinionated dashboard (vs. "bring your own Power BI") | Existing Tiny+BI offerings (Kondado, Integrai) require the customer to already own/configure Power BI, Looker Studio, or Google Sheets and build their own report. A ready-made dashboard that "just works" after OAuth connect removes that entire setup burden — this is the core wedge against the status quo | MEDIUM | This is effectively the whole product thesis; don't under-invest in the "5 minutes to first useful screen" experience once sync is proven. |
| Curva ABC (product-level sales/value ranking) done simply | Tiny has Curva ABC but it's a native report users have to know exists and configure; presenting it automatically as a dashboard widget once order data is synced is a natural differentiator | MEDIUM | Requires order + order_item data, so it is explicitly a **post-products-MVP** feature — depends on the Orders resource being synced (out of scope for the current milestone). |
| Cross-channel / cross-resource unified view (estoque + vendas + clientes in one place) | The BI-vendor pages found (Kondado's Tiny dashboard) sell exactly this: one screen instead of jumping between Tiny modules or exporting to spreadsheets | MEDIUM–HIGH | Depends on all three resources (products, customers, orders) being synced — explicitly out of scope for this milestone; log as the natural "v1.x" expansion once products-only sync is validated. |
| Historical trend / time-series on stock value or stock-level changes | Tiny's native UI is largely "current state" screens; a competitor advantage is showing stock value or count *over time*, something the bronze `raw_tiny_payloads` + periodic sync naturally enables if you snapshot rather than only overwrite | MEDIUM | Needs either periodic snapshotting or use of `inventory_movements`. Real differentiator, but requires more than the "just show current state" MVP — flag as v1.x. |
| Alert delivery via WhatsApp/email (not just in-app) | Small Brazilian business owners frequently aren't logged into a dashboard daily; proactive push (especially WhatsApp, which is near-universal in this market) has outsized perceived value relative to build cost once the alert *logic* already exists | MEDIUM | Explicitly excluded from MVP per PROJECT.md ("Alertas proativos — pós-MVP"). Correctly deferred: the alert *computation* (low stock flag) is cheap and MVP-eligible: the *delivery channel* is what's expensive and should wait. |
| Faster/more transparent sync status than Tiny's own integrations panel | Tiny/Olist's own integration status reporting is a common complaint source (duplicated orders, "manual stock reconciliation" reported on ReclameAqui); a dashboard that is honest and specific about sync health (per-resource, per-tenant, with error detail) is a trust differentiator, not just a nice-to-have | LOW–MEDIUM | Builds directly on the table-stakes "last synced at" — the differentiator is exposing *why* something failed (e.g., token expired vs. rate-limited vs. API error) rather than a generic red dot. |

### Anti-Features (Commonly Requested, Often Problematic)

Features that seem like obvious next steps but create disproportionate support/complexity burden for this niche and this MVP stage.

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|------------------|-------------|
| Two-way sync / editing data back into Tiny | Users will eventually ask "can I update stock/price here and push it to Tiny?" because it feels natural for a "dashboard" | Turns a read-only reporting layer into a system-of-record conflict problem: write conflicts, validation rules duplicated from Tiny, and the product now owns data integrity for actions that happen in Tiny too. Massively increases support burden and blast radius of bugs | Stay strictly read-only (sync FROM Tiny only) for the entire MVP and likely v1.x. If write-back is ever justified, scope it as a narrow, explicit, opt-in action (e.g., "acknowledge low stock") — never generic field editing. |
| Full custom report builder / drag-and-drop BI | Power users compare the product to Power BI/Looker Studio (which Tiny data already flows into via existing vendors) and ask for the same flexibility | Rebuilding a general-purpose BI tool is a different, much larger product than "opinionated dashboard for Tiny data." It competes with the exact tools (Kondado+PowerBI) this product is meant to replace with something simpler, and support cost scales with every possible report combination | Ship a small number of fixed, opinionated views (stock value, low stock, SKU search) that require zero configuration. If flexibility is truly demanded later, export to CSV/Google Sheets is a much cheaper escape valve than a builder. |
| Supporting product kits/variações/grade with full structural fidelity from day one | Tiny's own docs describe kits and variant grades as commonly used and "unanimously" liked by users, so it looks like table stakes | Kits (bundle stock derived from component products) and variant grades (parent/child SKU relationships) are real modeling complexity — getting the stock math wrong (e.g., counting a kit's stock independently of its components) produces visibly wrong numbers, which is worse than not showing the feature at all | For the products-MVP, sync and display products as Tiny returns them (including kit/variant records as normal SKUs) without trying to compute derived kit availability. Explicitly flag "kit stock accuracy" as a known gap, and address it only once single-SKU products (majority case) are proven reliable. |
| Real-time (sub-minute/websocket) stock updates everywhere | "Real-time" is the term most inventory-dashboard marketing pages lead with, so it reads as a checkbox requirement | For a small/medium business checking a dashboard a few times a day, near-real-time (webhook-driven, arriving within seconds-to-minutes) delivers the same practical value as true real-time, at a fraction of the infra cost (no websocket/streaming layer, no Celery/Redis — which PROJECT.md already explicitly excludes from the MVP) | Use Tiny's documented stock-update webhook + a periodic polling fallback/reconciliation job on the in-process scheduler already chosen. This is "fresh enough," not "instant," and that distinction should be stated in the UI (e.g., "atualizado há 2 min"), not hidden. |
| Financial / accounts-payable-receivable sync and reporting | Tiny users specifically complain about broken financial reports, which makes "let's just fix that" tempting as a wedge | PROJECT.md already excludes this explicitly, and for good reason: financial data (contas a pagar/receber, fiscal documents) carries compliance/accuracy stakes far higher than stock counts — errors there have tax and legal consequences, not just "wrong number on a screen" | Stay in the operational-KPI lane (stock, sales, customers) where being "a little stale" is annoying but not dangerous. Revisit financial reporting only as a distinct, carefully-scoped future product line, not an incremental add-on. |
| Multi-warehouse / multi-CD (centro de distribuição) stock breakdown | Tiny supports multiple company/branch (matriz/filial) setups and multi-CD is a known pain point for larger sellers, so it can feel like an obvious "complete" feature | Adds a whole dimension (location) to every product/stock query and UI, for a segment of users (multi-warehouse sellers) that is not the target "small/medium business" persona for an MVP proving single-tenant, single-resource sync | Model `stock_quantity` as a single tenant-level total for MVP (matches the current `products` table design — no location field). Add location/warehouse breakdown only if/when a cohort of real paying customers with multiple CDs asks for it. |
| Feature-request voting board / open backlog exposed to users | Tempting to imitate Tiny's own "ideas" channel as a way to manage scope pressure early | With zero confirmed paying customers (per PROJECT.md: "estágio comercial: especulativo"), an open voting board just broadcasts an empty/thin product and invites unfiltered scope creep before there's any real user base to prioritize against | Collect feedback directly (email/conversation) from the first handful of design-partner tenants instead; defer any public roadmap/voting mechanism until there's an actual community large enough to make voting meaningful. |

## Feature Dependencies

```
Auth (Supabase Auth signup/login)
    └──requires──> nothing (foundational)

Tiny OAuth2 connect (authorize → callback → encrypted tokens)
    └──requires──> Auth
    └──enables──> Product sync

Product sync (idempotent, tenant-scoped)
    └──requires──> Tiny OAuth2 connect
    └──enables──> Product list/search view
    └──enables──> Stock value total
    └──enables──> Low-stock indicator
    └──enables──> Sync status display

Product list/search view (SKU search) ──requires──> Product sync
Stock value total ──requires──> Product sync (price + stock_quantity fields only)
Low-stock indicator ──requires──> Product sync + a min_stock concept (Tiny field or tenant-configured threshold)
Sync status display ("last synced at") ──requires──> sync_watermarks table (already in data model)

Curva ABC / sales-ranked products ──requires──> Order + Order_Item sync (NOT in current MVP scope)
Customer-level views (LTV, top customers) ──requires──> Customer sync (NOT in current MVP scope)
Cross-resource unified dashboard ──requires──> Product sync + Customer sync + Order sync (all three)
Historical stock trend chart ──requires──> Product sync (repeated over time) OR Inventory_movements sync
Proactive alert delivery (email/WhatsApp) ──requires──> Low-stock indicator (compute first, deliver later)
Kit/variant-aware stock accuracy ──enhances──> Product sync (not a hard dependency, a refinement)

Multi-tenant isolation (RLS + tenant_id) ──conflicts-if-skipped-with──> everything (must exist from day one, not bolted on later)
```

### Dependency Notes

- **Product list/search, stock value total, low-stock indicator, and sync status display all require only Product sync.** These four are exactly the features that work end-to-end with the MVP's deliberately narrow "1 tenant, 1 resource" slice — see MVP Definition below.
- **Curva ABC, customer-level views, and any cross-resource dashboard require Order and/or Customer sync**, both explicitly out of scope for this milestone (per PROJECT.md). They should not be attempted until those resources are added in a later phase — attempting them now would mean building on top of data that doesn't exist yet.
- **Proactive alert delivery enhances but does not gate the low-stock indicator.** The indicator (a flag/badge in the UI) is cheap and valuable now; the delivery mechanism (push/email/WhatsApp) is the expensive, deferred part. Splitting these two apart is what makes "alertas proativos — pós-MVP" (per PROJECT.md Out of Scope) compatible with still shipping a useful low-stock *signal* in the MVP dashboard.
- **Multi-tenant isolation is a day-one dependency for every other feature**, not something layered in later — the data model (RLS + `tenant_id` + `UNIQUE(tenant_id, tiny_id)`) already reflects this correctly and should not be revisited as an afterthought.
- **Kit/variant stock accuracy enhances product sync but is explicitly not a blocking dependency** — plain product rows sync and display correctly without it; treat kit-aware math as a quality improvement to layer on later, not a precondition for shipping.

## MVP Definition

### Launch With (v1) — matches PROJECT.md's "1 tenant, 1 resource (products)" slice

Minimum viable product — what's needed to validate the sync engine AND be genuinely useful to a real business owner, not just "data synced":

- [ ] Signup/login (Supabase Auth) — required to have a tenant at all
- [ ] Connect Tiny ERP account via OAuth2, tokens encrypted at rest — the core integration promise
- [ ] Idempotent product sync (create/update, never duplicate) — the thing being validated
- [ ] Product list view with SKU/name search — makes synced data actually navigable, not just "present"
- [ ] Total inventory value (stock value KPI) — the single highest-value, lowest-cost number to surface; turns a product table into a "dashboard"
- [ ] Low-stock indicator (in-view flag/badge, threshold from Tiny's min-stock field or a simple tenant-set default) — directly answers a documented gap in Tiny's own native reporting, and is cheap with products-only data
- [ ] Visible "last synced at" / sync status per tenant — the trust signal that differentiates this from Tiny's own inconsistent integration status reporting
- [ ] Tenant isolation via RLS from the first tenant — non-negotiable, must not be retrofitted

### Add After Validation (v1.x)

Features to add once the products-only sync engine is proven and the milestone expands to customers/orders (per PROJECT.md's stated post-MVP direction):

- [ ] Customer sync + basic customer list/search — trigger: sync engine validated, ready to expand resources
- [ ] Order sync + basic sales KPIs (revenue over time, orders count, average ticket) — trigger: same as above; this is where "dashboard" starts meaning sales analytics, not just inventory
- [ ] Curva ABC (product ranking by sales) — trigger: order + order_item data exists
- [ ] Historical stock trend (value/quantity over time) — trigger: enough sync history accumulated to make a trend meaningful (weeks, not days)
- [ ] Proactive alert delivery (email at minimum; WhatsApp as a differentiator) — trigger: in-app low-stock indicator validated as useful by real usage, not just presence
- [ ] Multiple tenants live simultaneously with monitored sync health — trigger: first design-partner tenant's flow is stable end-to-end

### Future Consideration (v2+)

Features to defer until there's a paying customer base large enough to justify the investment:

- [ ] Kit/variant-aware stock math — defer until single-SKU product accuracy is proven and a real customer's catalog actually needs kit accuracy
- [ ] Multi-warehouse/CD stock breakdown — defer until a customer segment with multiple CDs is actually part of the paying base
- [ ] Cross-resource unified dashboard (estoque + vendas + clientes in one screen) — defer until all three resources are independently solid; combining early risks shipping something broad but shallow
- [ ] Billing/subscription management for the SaaS itself — already explicitly out of scope in PROJECT.md
- [ ] Custom/configurable report builder — defer indefinitely; conflicts with the "opinionated, zero-setup dashboard" differentiation strategy unless overwhelming demand emerges
- [ ] Two-way sync / write-back to Tiny — defer indefinitely; treat as a fundamentally different (and riskier) product decision, not a roadmap increment

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| Idempotent product sync | HIGH | MEDIUM | P1 |
| OAuth2 connect flow | HIGH | MEDIUM | P1 |
| Product list + SKU search | HIGH | LOW | P1 |
| Total inventory value KPI | HIGH | LOW | P1 |
| Low-stock indicator (in-view) | HIGH | LOW–MEDIUM | P1 |
| Sync status / last-synced display | MEDIUM–HIGH | LOW | P1 |
| Tenant isolation (RLS) | HIGH (invisible but critical) | MEDIUM | P1 |
| Customer sync + list | MEDIUM | MEDIUM | P2 |
| Order sync + sales KPIs | HIGH | MEDIUM–HIGH | P2 |
| Curva ABC | MEDIUM | MEDIUM | P2 |
| Proactive alert delivery (email/WhatsApp) | MEDIUM–HIGH | MEDIUM | P2 |
| Historical stock trend | MEDIUM | MEDIUM | P2 |
| Kit/variant-aware stock accuracy | LOW–MEDIUM | MEDIUM–HIGH | P3 |
| Multi-warehouse breakdown | LOW (for target persona) | HIGH | P3 |
| Cross-resource unified dashboard | MEDIUM | HIGH | P3 |
| Custom report builder | LOW (competes with product thesis) | HIGH | P3 (avoid) |
| Two-way sync | LOW (high risk) | HIGH | P3 (avoid) |

**Priority key:**
- P1: Must have for launch (the products-only MVP slice)
- P2: Should have, add when the milestone expands to customers/orders
- P3: Nice to have or explicitly to avoid — future consideration only, several marked "avoid" per Anti-Features above

## Competitor Feature Analysis

| Feature | Tiny ERP (native) | Kondado/Integrai-style BI-on-Tiny | Our Approach |
|---------|--------------------|--------------------------------------|--------------|
| Stock/product reporting | Present but reportedly limited; low-stock report only added in a fairly recent version (3.43); reporting broadly cited as a weak point in user complaints | Depends entirely on customer already owning/configuring Power BI, Looker Studio, or Google Sheets — real setup burden | Ship a low-stock + stock-value view as a zero-config default the moment a tenant connects, ahead of both alternatives on time-to-value |
| Sales/Curva ABC analysis | Has a native Curva ABC report (since ~2018), but requires knowing it exists and configuring it | Explicitly offered as a pre-built Power BI page | Defer to v1.x (needs order data); when built, present automatically rather than as an opt-in report |
| Feature requests / roadmap input | Public "ideas" voting board with 4,300+ open items, seen by users as a way to defer rather than ship | N/A (third-party tool, not the ERP) | Handle informally via direct conversations with early design-partner tenants; do not replicate a public backlog at this stage |
| Setup effort for a working dashboard | N/A — native, no setup, but limited scope | Requires configuring an external BI tool and building reports manually | OAuth connect → working dashboard in minutes, no external tool required — this is the core wedge |
| Sync/integration reliability transparency | Users report duplicated orders and manual stock reconciliation needed post-Olist acquisition — reliability itself is a stated complaint | Not directly comparable (BI tools consume already-synced data, don't manage the sync/integration layer themselves) | Make sync status and errors visible and specific (per-resource, per-tenant) as a trust differentiator from day one |

## Sources

- [Tiny ERP / Olist complaint threads — ReclameAqui](https://www.reclameaqui.com.br/empresa/tiny-erp/lista-reclamacoes/) — MEDIUM confidence (multiple independent complaint threads, consistent pattern across reporting/support/stock issues)
- [Insatisfação com o serviço e suporte do Tiny ERP após aquisição pela Olist](https://www.reclameaqui.com.br/olist-oficial/insatisfacao-com-o-servico-e-suporte-do-tiny-erp-apos-aquisicao-pela-olist-problemas-de-notas-fiscais-pedidos-duplicados-controle-de-estoque-manual-e-mudanca-unilateral-de-planos_2_dcAkSHE7RPE3sO/) — MEDIUM confidence
- [Kondado — Dashboard Olist Tiny (Power BI)](https://kondado.com.br/wiki/a/dashboard-tiny-power-bi) — MEDIUM confidence (describes an existing, shipped competitor-adjacent product)
- [Kondado — Como criar um dashboard do Tiny ERP no Power BI](https://kondado.com.br/blog/blog/2024/02/29/como-criar-um-dashboard-do-tiny-erp-no-power-bi/) — MEDIUM confidence
- [Olist Blog — Novidades da versão 3.43 do Tiny (low-stock report added)](https://olist.com/blog/pt/olist/tiny-news/tiny-versao-343/) — MEDIUM confidence (official changelog)
- [Olist Blog — Curva ABC para empresas](https://olist.com/blog/pt/olist/tiny-news/curva-abc-para-empresas/) — MEDIUM confidence (official)
- [Ajuda Olist — Aplicativos API V3 - Configurações e Utilização](https://ajuda.olist.com/hubs-e-plataformas-via-api/aplicativos-api-v3-configuracoes-e-utilizacao) — MEDIUM confidence (official docs, confirms rate limits + account usage endpoint)
- [Tiny API docs — Webhooks atualizações de estoque](https://tiny.com.br/api-docs/api2-webhooks-atualizacao-estoque) — MEDIUM confidence (official docs; note this reference is the v2 API webhook doc — v3-specific webhook behavior should be reverified before implementation per PROJECT.md's own caveat)
- [Marketfacil — Como criar kits de produtos no Tiny ERP](https://marketfacil.com.br/martketplaces/como-criar-kits-de-produtos-no-tiny-erp/) — LOW confidence (single third-party source, but consistent with general kit/variant modeling complexity)
- [Bold BI — Retail Inventory Management Dashboard](https://www.boldbi.com/dashboard-examples/retail/retail-inventory-management-dashboard/) — LOW confidence (generic industry marketing content, not Tiny-specific)
- [Klipfolio — Inventory Dashboard Examples](https://www.klipfolio.com/resources/dashboard-examples/supply-chain/inventory-dashboard) — LOW confidence (generic industry content)
- [Knack — Inventory Management Dashboard: 6 Features & Setup Guide](https://www.knack.com/blog/inventory-management-dashboards/) — LOW confidence (generic industry content)

---
*Feature research for: Tiny ERP integration / ERP-data-to-dashboard SaaS (Brazilian small/medium business niche)*
*Researched: 2026-07-27*
