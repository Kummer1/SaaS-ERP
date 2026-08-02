# Integração com Tiny ERP (Olist) — API v3

Fatos abaixo confirmados na documentação/central de ajuda oficial da Olist em
jul/2026. Como é API de terceiro, **revalide antes de codar** — esses detalhes
mudam sem aviso.

> **Nota de versão**: os fatos sobre a API do Tiny (rate limits, OAuth2, padrão
> webhook+polling, endpoints em lote) não mudaram e seguem confirmados abaixo. O
> que mudou é **onde e como** essa lógica roda: Celery workers foram substituídos
> por Supabase Edge Functions (Deno + TypeScript), agendadas via Supabase Cron.
> Ver `01-ARQUITETURA.md` para a arquitetura de execução completa.

## 1. Autenticação

- API v3 usa **OAuth2** (`client_id` + `client_secret`), gerados pelo cliente no
  próprio Tiny em *Configurações → Aplicativos → Novo aplicativo*, informando a
  URL de redirect da sua plataforma.
- A API v2 (token único, sem OAuth) **continua funcional mas não recebe mais
  atualizações** — não construa integração nova sobre ela.
- Fluxo: seu backend gera a URL de autorização → usuário do tenant loga no Tiny
  e aprova → Tiny redireciona para seu callback com `code` → backend troca `code`
  por `access_token` + `refresh_token` → tokens ficam guardados criptografados
  em `tiny_credentials`, associados ao `tenant_id`.
- **Cada tenant conecta sua própria conta Tiny** — não existe um único token
  "master" da sua aplicação; o `client_id/secret` identifica sua *aplicação*
  no marketplace de apps do Tiny, mas o token de acesso é por conta conectada.

## 2. Rate limits (por plano do cliente, não por aplicativo)

| Plano do tenant | Requisições/min | Escritas/min |
|---|---|---|
| Básico / Crescer | 60 | 30 |
| Essencial / Evoluir | 120 | 60 |
| Grande / Potencializar | 240 | 100 |

Pontos importantes:
- O limite é **da conta Tiny do cliente**, não do seu app — se o tenant também
  usa Tiny em outro integrador (planilha, n8n, etc.), a cota é compartilhada.
- Ao estourar o limite a API responde **HTTP 429** com header `Retry-After`
  (segundos a aguardar). **5 respostas 429 seguidas podem bloquear o token por
  1 hora** — o worker precisa parar de tentar antes disso, não insistir.
- Existem endpoints de **atualização em lote (até 50 produtos por chamada)** —
  use-os para sincronizar preço/estoque, que mudam com mais frequência, em vez
  de uma chamada por SKU.

**Implicação de design**: rate limit por *tenant*, não por aplicação → é preciso
um limitador (token bucket) por `tenant_id`, não um global. Como Edge Functions são
**stateless entre invocações** (sem memória de processo compartilhada), esse
estado (contagem de requisições na janela atual, timestamp do último 429) fica em
uma **tabela Postgres**, lida e atualizada a cada invocação — não em memória do
worker, como seria natural num processo Celery de longa duração.

## 3. Padrão de ingestão: webhook + polling de reconciliação

O Tiny expõe uma **API de Gatilhos (Triggers/Webhooks)** que notifica eventos
(ex.: pedido criado) quase em tempo real. Ainda assim, webhook **não é garantia
de entrega** (rede cai, seu endpoint fica fora do ar, etc.), então o desenho
correto é híbrido:

```
Webhook recebido  ──▶  Edge Function grava em fila (tabela Postgres)
                          ──▶  Edge Function de processamento (polling)
                                 busca o recurso completo pela API
                                 ──▶ upsert idempotente

Supabase Cron (a cada 15–30 min)  ──▶  dispara Edge Function de sync
                                          para cada tenant conectado:
                                          busca "atualizado desde watermark - 10min"
                                          ──▶ upsert idempotente
                                          (pega o que o webhook perdeu)

Primeira conexão do tenant  ──▶  full sync (backfill) processado em pedaços
                                   entre múltiplas invocações de Edge Function
                                   (cursor em sync_watermarks), paginado,
                                   respeitando rate limit
```

- **Webhook = latência baixa.** **Polling = garantia.** Nenhum dos dois sozinho
  é suficiente em produção.
- Todo upsert é feito com `ON CONFLICT (tenant_id, tiny_id) DO UPDATE`, então
  rodar o mesmo evento duas vezes (webhook + polling pegando o mesmo registro)
  é seguro por construção.

## 4. Recursos a sincronizar (MVP)

| Recurso | Endpoint v3 (base `https://erp.tiny.com.br/api/v3`) | Frequência sugerida |
|---|---|---|
| Contatos/clientes | `/contatos` | polling 30 min + webhook se disponível para o evento |
| Produtos | `/produtos` | polling 15 min + lote de 50 para preço/estoque |
| Estoque | `/estoque` (consulta de saldo) | polling 15 min ou no evento de pedido |
| Pedidos | `/pedidos` (`/sales/orders` em algumas integrações de exemplo) | webhook (gatilho de pedido) + polling 15 min |

Confirme os nomes exatos de endpoint e paginação na documentação oficial do
Tiny no momento da implementação — o nome pode variar entre `/pedidos` e
`/sales/orders` dependendo da versão/documentação consultada.

## 5. Onde n8n entra (e onde não entra)

Você já usa n8n para automações — ele é uma ótima ferramenta para:
- Notificações operacionais (ex.: Slack quando um tenant desconecta a integração)
- Fluxos administrativos simples (ex.: onboarding manual de um cliente novo)
- Existe inclusive um **node comunitário n8n para Tiny ERP v3** (ações de
  Produtos, Pedidos, Contatos, Estoque) — útil para protótipos rápidos ou
  automações internas que não fazem parte do core do produto.

Para o **motor de sincronização do produto** (definição de tenant, retries com
backoff exponencial, idempotência, rate limiting por tenant e testes
automatizados), prefira a Edge Function dedicada (Deno + TypeScript), orquestrada
via Supabase Cron: workflows visuais ficam difíceis de versionar, testar e
depurar quando a lógica cresce (múltiplos tenants, múltiplos recursos,
tratamento fino de erro, chunking por limite de CPU/wall-clock). Regra prática:
**se precisa de teste unitário e retry com política customizada, é código; se é
"quando X acontece, avisa Y", pode ser n8n.**

## 6. Erros a tratar explicitamente

| Situação | Tratamento |
|---|---|
| `429 Too Many Requests` | Respeitar `Retry-After`; nunca fazer retry imediato |
| `401 Unauthorized` (token expirado) | Refresh automático via `refresh_token`; se falhar, marcar tenant como `status=expired` e notificar |
| Token revogado pelo cliente no Tiny | Detectar via erro persistente de auth; marcar `status=revoked`; parar de tentar sync até reconexão |
| Schema novo/campo removido pela Tiny | Bronze (`raw_tiny_payloads`) preserva o payload original mesmo se o parser silver falhar — nunca se perde o dado bruto |
