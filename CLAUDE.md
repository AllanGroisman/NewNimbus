# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Visão geral

Nimbus é uma plataforma SaaS de automação de marketing por WhatsApp para ofertas. Faz scraping de produtos (Mercado Livre, Amazon), permite organizar campanhas por categoria e dispara mensagens em grupos de WhatsApp em horários configuráveis. Stack: React 19 + Vite no frontend, Node + Express 5 no backend, Postgres via Prisma para persistência, Baileys (WhatsApp) e Puppeteer (scraping).

## Comandos

Subir tudo no Windows (backend, frontend, ngrok em terminais separados):

```bat
start.bat
```

Rodar manualmente em 3 terminais:

```bash
# Backend (porta 3001)
cd backend && node server.js

# Frontend (porta 5173, com proxy /api → 3001)
cd frontend && npx vite --host

# ngrok (opcional, exposição externa da 5173)
ngrok http 5173
```

**Persistência.** Toda a persistência é Postgres via Prisma — exige `DATABASE_URL` apontando pra uma instância acessível. Usuários, estado por user, catálogo de produtos, configs de afiliado, sessões Baileys (tabela `baileys_auth`), assinaturas Stripe e o segredo JWT (`AppConfig` key=`jwt_secret`) ficam todos no DB.

**Fila de envios (Fase 2 + 2.1).** Modo selecionado por `QUEUE_BACKEND`:

- `QUEUE_BACKEND=memory` (default) — single process. Sem persistência, sem retry. Scheduler envia inline (comportamento legado).
- `QUEUE_BACKEND=redis` — **dois processos**:
  - **Server** (`node server.js`): HTTP API + scheduler producer (popa item, enfileira). Não owna Baileys nesse modo.
  - **Worker** (`node worker.js`): owna Baileys (sessões + envios) + consome filas (`send-message` com retry 5×, e `control` pro RPC do server). Em PM2 sobe como `nimbus-worker`.

  Filas BullMQ no Redis. Worker publica status das sessões no Redis (`nimbus:session:<userId>:<numberId>`) — `whatsapp/proxy.js` no server lê desse cache pra responder QR/status sem RPC.

Pra subir localmente:

```bash
# 1. Sobe Postgres + Redis no Docker
docker compose up -d

# 2. Cria/atualiza schema (gera client + roda migrations)
cd backend
npx prisma migrate dev    # primeira vez (cria a migration)
# ou
npx prisma migrate deploy # subsequente (CI / produção)

# 3. Sobe backend (e worker se QUEUE_BACKEND=redis)
QUEUE_BACKEND=redis node server.js
QUEUE_BACKEND=redis node worker.js
# (no Windows: start.bat sobe os dois automaticamente quando QUEUE_BACKEND=redis)
```

Ver `backend/.env.example` pras variáveis. Trocar `QUEUE_BACKEND` de `redis` pra `memory` é o rollback da Fase 2 — jobs que estavam em-vôo no Redis ficam órfãos (precisam ser drenados antes da troca em produção); o worker.js também não é mais necessário, server faz tudo.

Lint do frontend (não há lint no backend):

```bash
cd frontend && npm run lint
```

Build de produção do frontend:

```bash
cd frontend && npm run build
```

**Suíte de testes — três camadas, ~286 testes:**

1. **Backend + integração** (`tests/`, Vitest 2.x + supertest) — ~222 testes, ~100s. Modo PG real (`nimbus_test` DB) com WhatsApp/Baileys e Stripe mockados. `truncateAll` antes de cada teste (journey opta por persistir via `globalThis.__NIMBUS_SKIP_TRUNCATE_BETWEEN_TESTS`).
2. **Frontend** (`frontend/`, Vitest + RTL + jsdom) — ~59 testes, ~4s. `data/api.js`, `data/constants.js`, `Subscription.jsx`, `GroupDashboard.jsx`.
3. **E2E** (`tests/e2e/`, Playwright + Chromium) — 5 testes, ~12s. Sobe backend+frontend dedicados (portas 3101/5273) contra DB `nimbus_test_e2e` isolado.

```bat
test.bat                          :: backend + frontend (não inclui E2E)
```

```bash
cd tests
npm install
npm test                          # backend (~100s)
npm run test:unit
npm run test:integration
npm run test:journey
RUN_REDIS_TESTS=1 npm test        # inclui redis-queue (BullMQ real)
npm run test:e2e                  # Playwright (auto-sobe servers)
npm run test:watch

cd frontend && npm test           # ~4s
```

**Pré-requisitos:** Docker compose UP. DB `nimbus_test` precisa existir uma vez (`docker exec nimbus-postgres psql -U nimbus -c "CREATE DATABASE nimbus_test OWNER nimbus"`); `nimbus_test_e2e` é criado/migrado pelo globalSetup do Playwright.

**Cobertura:**
- **Auth** — register/login/me/PATCH/password/admin gating
- **State + OPS_FIELDS** — race scheduler vs frontend (no PG a race some estruturalmente, mas o contrato continua testado)
- **Catálogo** — upsert/query/filtros, `/api/ofertas`, `/api/admin/catalog` paginação/filtros
- **Afiliados** — ML/Amazon/Shopee (gerar link, expiração, cache)
- **Scheduler** — refillNow/manualAdd/sendNextNow/tick + edge cases (sem afiliado, sem janela, sem grupo WA)
- **Manual ops HTTP** — refill/manual-add (force/409/202 cooldown)/pending approve+reject/history clear, isolamento entre users
- **Admin** — users CRUD + role, scraper config/run/status, catalog admin, DLQ memory mode
- **WhatsApp** — sessions/grupos/send/broadcast/invite + plan-gating de número novo (402)
- **Billing** — trial auto, /me, checkout flow (URL fake), portal, webhooks (`checkout.session.completed`, `subscription.{created,updated,deleted}`, `invoice.payment_failed`, idempotência por event.id, signature inválida, evento desconhecido, sub órfã), plan-gating + admin bypass
- **Health/metrics** — `/healthz` checks, `/metrics` formato + incremento, rate limiters no-op em test
- **Redis queue** — enqueueSend → handler, retry exponencial até sucesso, callControl RPC, status counts, DLQ
- **Frontend** — data/api.js (Authorization, 401 limpa token + dispatchEvent, 402), data/constants.js (helpers), Subscription.jsx (status/checkout/admin bypass/Stripe disabled), GroupDashboard.jsx (botão pausar/retomar no header visível em qualquer aba, banner sem afiliado)
- **E2E** — registro+entrada, login inválido, logout, navegação pra Assinatura com trial

**Fora do escopo:** scraping real (Puppeteer), Baileys real, Stripe real (cobrança não testada).

`start.bat` **não** roda testes — sobe direto. Pra rodar testes antes de subir, encadeie: `test.bat && start.bat`.

Mudanças no backend que sustentam os testes (importantes ao mexer):
- `server.js` exporta `{ app, boot }` e só chama `boot()` quando `require.main === module` (supertest carrega o app sem bindar porta).
- Rate limiters no `server.js` viram no-op quando `NODE_ENV === "test"`.
- `storage/pg.js` coerce `avgDiscount` (coluna `String`) pra `Number` quando numérico.
- Mocks em `tests/helpers/wa-mock.js` (whatsapp/index.js) e `tests/helpers/stripe-mock.js` (billing/stripe.js): patcheiam `require.cache` antes de `server.js` carregar.

Variáveis de ambiente relevantes (lidas pelo backend):

- `DATABASE_URL` — connection string do Postgres (obrigatória). Ex: `postgresql://nimbus:nimbus_dev@localhost:5432/nimbus?schema=public`.
- `QUEUE_BACKEND` — `memory` (default, legado) ou `redis` (BullMQ). Em modo `redis`, exige `REDIS_URL` e Redis rodando.
- `REDIS_URL` — URL do Redis (modo `redis`). Default: `redis://localhost:6379`.
- `JWT_SECRET` — sobrescreve o segredo persistido em `AppConfig` (key `jwt_secret`). Recomendado em produção.
- `ADMIN_EMAILS` — emails (separados por vírgula) que recebem `role=admin` automaticamente no login. `start.bat` já define `allangroisman@gmail.com`.
- `ML_AFFILIATE_TAG` / `ML_AFFILIATE_COOKIE` — sobrescrevem a config de afiliado ML (precedência sobre o storage).
- `AMAZON_AFFILIATE_TAG` — sobrescreve a tag de afiliado Amazon.
- `NIMBUS_CORS_ORIGINS` — allowlist de origens CORS, separadas por vírgula (suporta `*.dominio.com`). Vazio = aceita tudo (modo dev).
- `LOG_LEVEL` — nível do pino (`debug`/`info`/`warn`/`error`). Default: `debug` em dev, `info` em prod.
- `NODE_ENV` — `development` (default) ou `production`. Em prod ativa logs JSON.
- `PORT` — porta do backend (default 3001).
- `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` — chaves do Stripe (test ou live). Vazio = endpoints de billing retornam 501 (modo dev sem credenciais).
- `STRIPE_PRICE_BASIC` / `STRIPE_PRICE_PRO` / `STRIPE_PRICE_BUSINESS` — Price IDs dos 3 planos (criados no dashboard Stripe, BRL recorrente mensal).
- `STRIPE_SUCCESS_URL` / `STRIPE_CANCEL_URL` — pra onde o Checkout redireciona após sucesso/cancel. Default aponta pra `localhost:5173/?checkout=...`.

### Operação (Fase 0 — hardening)

- **Health check**: `GET /healthz` — público, sem auth, retorna 200/503 com status do storage, scheduler, sessões WhatsApp, queue (BullMQ) e worker heartbeat. Use em load balancers / monitoring.
- **Métricas Prometheus**: `GET /metrics` — formato texto Prometheus. Counters (`nimbus_http_requests_total`, `nimbus_sends_total`, `nimbus_scheduler_ticks_total`), histograms (`nimbus_send_duration_seconds`, `nimbus_http_request_duration_seconds`), gauges (`nimbus_queue_depth`, `nimbus_whatsapp_sessions`, `nimbus_worker_heartbeat_age_seconds`).
- **Sentry**: ativa se `SENTRY_DSN` estiver setada. Captura `unhandledRejection`, `uncaughtException`, falhas terminais de jobs BullMQ. Sem DSN: no-op.
- **Backup remoto** (S3-compatível): `cd backend && npm run backup:remote` — sobe snapshots de `backend/backups/` (gerados externamente, ex: pg_dump agendado) pra S3/B2/R2/Wasabi. Sem env `BACKUP_S3_*` setadas, exit 0 sem fazer nada.
- **PM2** (produção): `cd backend && npm run pm2:start` usa `ecosystem.config.js` — sobe `nimbus-backend` + `nimbus-worker`. Pra logs rotacionados: `pm2 install pm2-logrotate`.
- **Rate limit**: `/api/auth/login` (10/min/IP), `/api/auth/register` (5/min/IP), global `/api/*` (300/min/IP).
- **DLQ**: jobs que falham 5× ficam na fila como `failed`. Endpoints admin: `GET /api/admin/queue/failed`, `POST /api/admin/queue/failed/:id/retry`, `DELETE /api/admin/queue/failed/:id`.
- **Worker heartbeat**: worker escreve em `nimbus:worker:heartbeat` (Redis, TTL 60s) a cada 5s. Server checa em `/healthz` — se ageSeconds > 30, marca worker como morto e devolve 503.

## Arquitetura

### Camadas

- **Frontend** (`frontend/src/`): SPA React 19 com Vite. Sem TypeScript, sem framework de CSS — estilos inline + CSS variables para tema claro/escuro. Sem axios — usa `fetch` nativo.
- **Backend** (`backend/`): Express 5 (`server.js`) é só roteamento. Lógica fica em pastas por feature: `auth/`, `storage/`, `catalog/`, `config/`, `whatsapp/`, `scraping/` (`scraper.js`, `admin.js`, `affiliate.js`) e `infra/` (`logger.js`, `metrics.js`, `sentry.js`, `queue.js`, `session-status.js`, `worker-heartbeat.js`). `scheduler.js` e `db.js` ficam na raiz porque são compartilhados. Cada pasta de feature expõe um `index.js` que re-exporta `pg.js` — toda a persistência vai pro Postgres. Reads em hot path (users, catalog, app-config) usam cache em memória populado por `warmup()` no boot.
- **Persistência (Postgres)**: schema em `backend/prisma/schema.prisma`, dev local via `docker compose up -d`. `queue/pending/history` são tabelas dedicadas (sem race com saveState do frontend).
- **Fila de envios (Fase 2)**: `backend/infra/queue.js` é facade `memory|redis`. Em modo `redis`, BullMQ persiste jobs no Redis. Scheduler vira producer (`dispatchOne` popa item + atualiza `lastSend` antes de enfileirar). `processSendJob` (handler) faz o envio + persiste history/métricas, com retry exponencial (5 tentativas, 5s→80s).
- **Worker process (Fase 2.1)**: em modo `redis`, `backend/worker.js` é processo separado que owna Baileys + consome as filas (`send-message` e `control`). `backend/whatsapp/index.js` é facade — resolve pra `whatsapp/local.js` no worker (`WORKER_PROCESS=true`) e pra `whatsapp/proxy.js` no server. Server proxy usa `queue.callControl` (BullMQ RPC com `waitUntilFinished`) pra ops e `session-status.read` (cache Redis populado pelo worker) pra status/QR. Em modo `memory`, server faz tudo no mesmo processo (worker.js ignorado).

### Fluxos críticos para entender antes de mexer

**1. Autenticação (JWT + bcrypt).** `auth/` mantém usuários na tabela `User` e o segredo JWT na tabela `AppConfig` (key `jwt_secret`, gerado uma vez no `auth.warmup()`). Env `JWT_SECRET` tem prioridade — útil pra fixar entre deploys. TTL de 30 dias. Toda rota usa o middleware `auth.requireAuth` que injeta `req.user = { id, name, email, role }`. Em 401 o frontend dispara `nimbus:unauthorized` e volta pra tela de login. `auth.requireAdmin` exige `role === "admin"`. A função `syncRole()` é chamada no login/`requireAuth` e promove para admin se o email estiver em `ADMIN_EMAILS` — mas nunca rebaixa automaticamente (evita lockout). Para desenvolvimento local, a env `ADMIN_EMAILS` é a única forma sustentável de virar admin.

**2. Estado por usuário (frontend ↔ scheduler).** O estado da app de cada usuário (`groups`, `numbers`, `whatsappGroups`, `settings`) vive em tabelas dedicadas no Postgres. **Existem dois escritores concorrentes**:

- O **frontend** salva via `PUT /api/state` com debounce de 800ms sempre que algo muda (ver `App.jsx`).
- O **scheduler** (`backend/scheduler.js`) escreve campos operacionais por grupo a cada tick (30s).

Como `queue/pending/history` viraram tabelas dedicadas, não há race entre os dois escritores — o frontend não sobrescreve campos operacionais. Continua existindo `OPS_FIELDS` no frontend (linha 30 de `App.jsx`) só pra filtrar o payload do save e ler operações via `GET /api/state/ops` a cada 30s. **Ao adicionar um novo campo gerenciado pelo scheduler, é obrigatório adicioná-lo a `OPS_FIELDS` no frontend** — senão o auto-save manda pra cá um valor stale.

**3. Catálogo global (admin-scraper) → fila por campanha (scheduler).** Há um único catálogo de produtos compartilhado por todos os usuários (tabela `Product`):

- `scraping/admin.js` roda periodicamente (configurável pelo admin via `/api/admin/scraper/*`) e dá upsert no catálogo.
- `catalog/` indexa produtos por `productKey()` em `catalog/product-key.js` (hash MD5 derivado do MLB id quando possível, com fallback pra origin+pathname). O scheduler importa essa função direto de `./catalog/product-key`.
- O scheduler, no tick, lê do catálogo, aplica filtros da campanha, e popula `group.queue`. Quando entra na janela horária, dispara via `whatsapp/` (Baileys).
- Endpoint `GET /api/ofertas` lê do catálogo (não scrape on-demand).

**4. Gating por afiliado (per-user).** Cada usuário tem sua própria config de afiliado (ML/Amazon/Shopee) — armazenada na tabela `affiliate_config`, acessada via `scraping/affiliate-store/`. `scraping/affiliate.js` expõe `readMLConfig(userId)`, `writeMLConfig(userId, {tag,cookie})`, `gerarLinkAfiliadoML(userId, link)` etc — `userId` é sempre o primeiro arg. Campanhas que dependem do Mercado Livre ou Shopee ficam pausadas (não scrape, não envia) enquanto o **usuário dono** não configurar credenciais. O frontend usa o helper `groupUsesML()` em `data/constants.js` e mostra banner. Cache de 7 dias por (userId, link) → short_url. Env vars (`ML_AFFILIATE_TAG`/`AMAZON_AFFILIATE_TAG`/`SHOPEE_AFFILIATE_APP_*`) continuam como override GLOBAL — útil em dev. O admin-scraper (que roda fora de userId) usa env vars OU pega creds Shopee do primeiro usuário configurado, via `affiliate.getScraperShopeeCreds()`.

**5. Sincronia frontend ↔ backend de categorias e fontes.** `frontend/src/data/constants.js` (`CATEGORIES`, `allSources`) e `backend/scraping/scraper.js` (`CATEGORIES`, `STORES`) precisam ser mantidos em sincronia manualmente. O comentário no constants.js avisa, mas é fácil esquecer ao adicionar uma categoria nova.

**6. WhatsApp (Baileys).** Sessão persistida na tabela `baileys_auth` (sessionId, keyType, keyId, value) via `useDatabaseAuthState` em `auth/baileys-pg.js` — trocar de máquina não perde sessão. `whatsapp/local.js` mantém o mapa de sessões em memória do processo; `restoreSessions()` religa as existentes na boot. QR code é convertido pra data URL via `qrcode`. Em modo `memory`, isso roda no server. Em modo `redis` (Fase 2.1), roda no `worker.js` — server vê tudo via `whatsapp/proxy.js` (RPC pra ops, cache Redis pra status/QR). Broadcasts adicionam intervalo (default 4s) entre envios para reduzir risco de bloqueio.

**7. Billing (Stripe — Checkout + Portal hosted).** Assinatura por usuário (1:1 com `User`) no modelo `Subscription` (Prisma). Eventos idempotentes via `WebhookEvent` (id = `evt_…` do Stripe).

- **Trial automático**: `auth.register` cria `Subscription { planId:"pro", status:"trialing", currentPeriodEnd:+7d }` sem cartão. `billing.getStatus` também faz lazy-trial pra usuários pré-existentes que ainda não têm row.
- **Admin bypass**: usuários com `role=admin` (ADMIN_EMAILS) sempre caem em `effectivePlan=business` independente de pagamento. Vide `limits.effectivePlanId` e `billing.isActive`.
- **Plan-gating** aplicado em 3 lugares:
  - `PUT /api/state` valida `numbers/groups/categoriesPerGroup/autoScraping` e retorna **402** com `{ error, limit, current, planRequired }`.
  - `POST /api/whatsapp/sessions/:id` (criação de sessão NOVA) bloqueia se exceder `numbers`.
  - `scheduler.tick` pula usuários onde `billing.isActive(sub, role)` é falso — sessões WA continuam vivas, só os envios pausam.
- **Webhook** (`POST /api/billing/webhook`): montado com `express.raw({type:"application/json"})` ANTES do `express.json()` global pra preservar bytes pra validação HMAC. Idempotência: `markWebhookProcessed(event.id)` antes de processar; conflito = no-op.
- **Limits**: única fonte de verdade em `backend/billing/limits.js` (`PLANS.{free,basic,pro,business}.limits`). Frontend lê via `billingMe()` e usa pra desabilitar botões.
- **Métricas**: `nimbus_billing_webhook_events_total{type,result}`, `nimbus_billing_checkout_total{plan,result}`, `nimbus_billing_active_subscriptions{plan}`.

Stripe local (dev):

```bash
# 1) Stripe CLI roda webhook listener — imprime o whsec_… use no .env
stripe login
stripe listen --forward-to http://localhost:3001/api/billing/webhook

# 2) No .env do backend, configure STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET + 3 PRICE_IDs.
#    Sem STRIPE_SECRET_KEY, endpoints /checkout e /portal retornam 501.

# 3) Disparar eventos sintéticos pra testar:
stripe trigger checkout.session.completed
stripe trigger customer.subscription.updated
```

**8. Fila de envios (Fase 2 + 2.1 — `QUEUE_BACKEND=redis`).** Duas filas BullMQ no Redis:

- `nimbus.send-message` — envios agendados, retry exponencial (5×, 5s→80s), concurrency 1, limiter 1/s
- `nimbus.control` — RPC server↔worker (start session, send manual, list groups, etc), concurrency 4, sem retry

Fluxo end-to-end de um envio agendado:

1. **Producer** (server, `scheduler.dispatchOne` no tick 30s): se há item na queue + janela ativa + intervalo respeitado, **popa o primeiro item** e atualiza `lastSend` no storage **antes** de enfileirar. Isso impede que o próximo tick re-enfileire o mesmo item.
2. **Worker** (`worker.js`, `processSendJob`): consome o job, chama `sendItem` → `wa.sendImage/sendText` (Baileys local), monta novo history/métricas e persiste só history + sentToday/sentWeek/weekData (queue e lastSend já foram setadas pelo producer).
3. **Falha** → BullMQ retenta com backoff. Falha final (5 tentativas) = item perdido + log. Sem DLQ ainda.

Fluxo de uma op manual via API (ex: usuário clica "Conectar WhatsApp"):

1. Server endpoint chama `wa.startSession(userId, numberId)` — facade resolve pra `whatsapp/proxy.startSession`
2. Proxy faz `queue.callControl("startSession", [userId, numberId])` → enfileira na control queue + aguarda via `waitUntilFinished` (timeout 30s)
3. Worker consome o job → chama `wa.startSession` local → Baileys cria socket → `connection.update` events disparam → `publishStatus` escreve no Redis
4. Worker job retorna snapshot inicial; proxy devolve pra endpoint; endpoint responde HTTP
5. UI faz polling `GET /api/whatsapp/sessions/:id` → server proxy lê do cache Redis → devolve QR/status atual

**Manual "Send Now"** (`scheduler.sendNextNow`) **não passa pela send-message queue** — chama `sendItem` direto, que via facade vai pra control queue em redis mode (sem retry). Idem broadcasts ad-hoc.

**Rollback Fase 2.1:** trocar `QUEUE_BACKEND` pra `memory` faz o server voltar a usar Baileys local — basta não rodar o `worker.js`. Jobs em-vôo no Redis ficam órfãos (drenar antes em prod).

### Convenções

- Backend é CommonJS (`require`), frontend é ESM.
- O frontend chama `/api/*` (caminhos relativos) — Vite faz proxy para `localhost:3001`. Não há lógica de URL absoluta nem CORS em dev.
- Token JWT vai em `localStorage["nimbus.token"]` (ver `frontend/src/data/api.js`). Toda request via helper `http()`, que injeta `Authorization: Bearer` e trata 401.
- Persistência: tudo via Prisma; escritas que dependem de read-then-write usam transações (`prisma().$transaction`) ou upsert nativo pra evitar race.
