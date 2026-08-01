# Infraestrutura e Deploy

> **Nota de versão**: este documento foi reescrito para refletir a arquitetura
> final (Supabase Edge Functions + Vercel), sem containers próprios. Substitui o
> desenho original baseado em Docker Compose + PaaS de containers
> (Railway/Render/Fly.io).

## 1. Princípio geral

Time pequeno (você) ⇒ **serviços gerenciados > operação própria** sempre que o
custo compensar. Sem Kubernetes, sem container próprio para operar: tanto o
backend (Edge Functions) quanto o banco (Postgres) e a autenticação (Auth) vivem
dentro do mesmo projeto Supabase; o frontend vive no Vercel. O plano de
infraestrutura evolui **por fase de negócio**, não por escolha técnica antecipada
— ver §4.

## 2. Ambiente local (dev)

- **Supabase CLI** (`supabase start`) sobe um stack Postgres local (via Docker,
  gerenciado pela própria CLI — não é um `docker-compose.yml` mantido a mão) para
  rodar migrações e testar Edge Functions localmente (`supabase functions serve`).
- **Vite dev server** para o frontend (`npm run dev`).
- Variáveis de ambiente (URLs, chaves) documentadas em `.env.example`; segredos
  reais nunca commitados.

Se Docker não estiver disponível na máquina de desenvolvimento (caso já
documentado na Fase 1 — ver `.planning/phases/01-infrastructure-connection-foundation/01-VERIFICATION.md`),
o fallback é `supabase db push --dry-run --linked` para validar migrações sem
stack local, com o entendimento de que isso não substitui totalmente um teste
local real.

## 3. Conexão ao Postgres: duas portas, dois usos

- **Porta 5432 (conexão direta)** — usar **apenas** para migração/DDL via
  Supabase CLI (`supabase db push`). Não usar para runtime da aplicação.
- **Porta 6543 (pooler / Transaction Pooler)** — usar para **todo runtime da
  aplicação** (Edge Functions, scripts operacionais). Requer usuário no formato
  `postgres.<project-ref>` (não `postgres` puro) e, no driver `postgres.js`
  (usado pelas Edge Functions deste projeto), a opção `{ prepare: false }` para
  evitar o bug de prepared statements sob pooler em modo transação.

**Não confundir as duas** — este é exatamente o bug de classe que já quebrou o
projeto anterior (`tinysaas`, commit `55b0f80`): reconstruir a `DATABASE_URL` a
partir de host/usuário/senha separados, em vez de copiar a connection string
completa que o Supabase fornece para cada modo, derruba o usuário
`postgres.<ref>` exigido pelo pooler. Sempre copiar a string completa; só
reescrever o esquema (`postgres://` → `postgresql://`) se necessário.

## 4. Plano de custo por fase

O plano de infraestrutura acompanha o estágio comercial do produto, não decisões
técnicas antecipadas:

| Fase | Estágio | Infra | Custo |
|---|---|---|---|
| **Fase 0** | Validação, sem cliente pagando | Supabase Free + Vercel Hobby | **US$0/mês** |
| **Fase 1** | Primeiro cliente pagante | Vercel Pro (US$20/mês — obrigatório por ToS assim que há receita, o Hobby é para uso pessoal não-comercial) + Supabase Pro (US$25/mês — remove o auto-pause de 7 dias por inatividade, que quebraria o recebimento de webhook) | **~US$45/mês** |
| **Fase 2** | Se o motor de sync estourar os limites de Edge Function em volume real (muitos tenants, syncs grandes e frequentes) | Motor de sync migra para um worker dedicado: **Render** (~US$15-20/mês, setup simples) ou **AWS Lambda + EventBridge + SQS** (tier grátis mais generoso, porém mais setup). Banco/Auth/Storage continuam no Supabase, **sem mudança de schema** | Variável, avaliar no momento |

**Importante**: o auto-pause de 7 dias do Supabase Free (Fase 0) só é
interrompido por atividade real de banco (queries), não por acessos ao
dashboard. Enquanto não há cliente pagante, é aceitável conviver com pausas
ocasionais em ambiente de desenvolvimento; a migração para Supabase Pro na Fase
1 remove esse risco antes que exista um webhook real de cliente para perder.

## 5. CI/CD (GitHub Actions)

Pipeline (`.github/workflows/ci.yml`, já em uso desde a Fase 1):
1. `smoke-test`: roda `scripts/smoke-test-db.ts` (Deno) — conexão ao Postgres
   exatamente pelo mesmo método usado em produção (Transaction Pooler,
   `prepare:false`), prevenindo a classe de bug do §3.
2. Testes automatizados (`deno test`) das Edge Functions.
3. Build + testes do frontend (`npm run build`, `vitest`).
4. Deploy: `supabase functions deploy` (backend) + deploy automático do Vercel
   (frontend, via integração Git).

Segredos necessários no GitHub Actions: `DATABASE_URL`, `SUPABASE_ACCESS_TOKEN`,
`SUPABASE_PROJECT_ID`, `SUPABASE_DB_PASSWORD`. **Pendente**: repositório ainda não
tem remote configurado no GitHub — o pipeline nunca rodou de fato em CI (ver
`.planning/STATE.md`, Blockers/Concerns).

## 6. Segurança e segredos

- Segredos de plataforma (`DATABASE_URL`, chaves de invocação de função) vivem no
  **Supabase Vault** (`vault.create_secret` / `vault.decrypted_secrets`) e nas
  variáveis de ambiente do provedor (GitHub Actions secrets, Vercel env vars) —
  nunca em código ou `.env` commitado.
- `client_secret`, `access_token` e `refresh_token` do Tiny por tenant também
  ficam criptografados em repouso via Supabase Vault, mesmo padrão já em uso para
  segredos de plataforma desde a Fase 1 (substitui a criptografia Fernet do
  desenho original em Python).
- HTTPS obrigatório em produção (nativo em Supabase e Vercel).
- CORS restrito ao domínio do frontend em produção (não usar `*`).
- Edge Functions sensíveis (OAuth callback, endpoints de sync/fila) permanecem
  `verify_jwt`-protegidas por padrão; apenas o health-check é uma exceção
  explícita e documentada (`supabase/config.toml`, `[functions.health]`).

## 7. Observabilidade mínima viável

- Logs estruturados das Edge Functions (nativos do Supabase; incluir `tenant_id`
  em todo log de sync, para conseguir filtrar problema por cliente).
- Reavaliar uma ferramenta de captura de exceções (ex.: Sentry) quando o volume
  de tenants justificar o custo — não é bloqueante para o MVP.
- Health-check (`GET /functions/v1/health`) já implementado na Fase 1.
- Métrica simples de negócio desde o dia 1: quantos tenants com sync saudável vs.
  quebrado (`tiny_credentials.status`).

## 8. Backups e recuperação

- Backup automático do Postgres gerenciado pelo Supabase (confirmar política de
  PITR disponível no plano contratado — Pro inclui point-in-time recovery).
- Como o bronze (`raw_tiny_payloads`) guarda o payload bruto, um desastre na
  camada silver é recuperável via **replay** sem precisar rechamar a API do Tiny
  (importante dado o rate limit).
