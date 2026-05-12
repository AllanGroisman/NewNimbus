# Nimbus — Documento técnico completo (snapshot 2026-05-12)

> Este documento é auto-suficiente. Foi escrito pra ser colado num prompt de IA que vai analisar/auditar/sugerir mudanças no sistema sem ter acesso ao código. Se você é a IA lendo isto: aqui tem o que você precisa pra responder com precisão sobre a arquitetura. Quando o usuário pedir algo, **pergunte por arquivos específicos antes de assumir** — este doc cobre o quê e o porquê, não cada linha.

---

## 1. Visão de produto

**Nimbus** é uma plataforma SaaS para **automação de marketing por WhatsApp** voltada a divulgação de ofertas. Funcionamento:

1. **Scraping** periódico popula um catálogo global de produtos com preço, desconto, categoria, etc. Fontes:
   - **Mercado Livre** + **Amazon** via Puppeteer (browser headless)
   - **Shopee** via Affiliate Open API (GraphQL, sem browser)
2. Cada **usuário** cria **campanhas** (chamadas internamente de "groups"). Uma campanha define: categorias de interesse, fontes (`sources` — ml/amazon/shopee), filtros (desconto mínimo, faixa de preço, palavras-chave), template de mensagem, janelas horárias de envio, intervalo entre envios, cooldown de re-envio do mesmo produto, e os grupos de WhatsApp pra disparar.
3. O **scheduler** roda a cada 30s. Pra cada campanha: preenche fila com produtos do catálogo que casam os filtros, remove itens stale (config mudou), e dispara mensagens dentro da janela horária.
4. Envio via **Baileys** (biblioteca não-oficial WhatsApp Web). Sessões persistem em Postgres (Fase 3).
5. **Afiliados**: links passam por gerador de short_url com tag de afiliado:
   - **Mercado Livre**: tag + cookie MLA (cookie expira; cai pra link cru se falhar)
   - **Amazon**: tag injetada na URL (`?tag=...`)
   - **Shopee**: App ID + App Secret via API GraphQL oficial (sem cookie, não expira)

Stack alta:
- Frontend: React 19 + Vite, ESM, sem TypeScript, sem framework CSS, fetch nativo
- Backend: Node + Express 5 (CommonJS)
- Persistência: Postgres 16 via Prisma (com fallback JSON)
- Fila: BullMQ no Redis 7 (com fallback memory)
- WhatsApp: Baileys 6.x
- Scraper: Puppeteer 24

---

## 2. Topologia de processos

```
                    ┌─────────────┐
                    │ Frontend    │  React SPA
                    │ Vite :5173  │  proxy /api → :3001
                    └──────┬──────┘
                           │ HTTP (JWT bearer)
                           ▼
   ┌───────────────────────────────────────────────┐
   │ Server (server.js, :3001)                     │
   │  - Express HTTP API (todas rotas /api/*)      │
   │  - Scheduler producer (tick 30s)              │
   │  - Admin scraper coordinator                  │
   │  - Em modo redis: whatsapp = proxy            │
   │  - Em modo memory: whatsapp = local           │
   └────────┬─────────────────────┬────────────────┘
            │                     │
        Postgres                Redis (modo redis only)
        (Prisma)                  │
            │                     │
            │           ┌─────────┴───────────────┐
            │           │ Worker (worker.js)      │
            │           │  - Baileys local        │
            │           │  - send-message handler │
            │           │  - control RPC handler  │
            │           │  - heartbeat 5s         │
            │           └─────────────────────────┘
            │                     │
            └─────────────────────┘
              ambos leem/escrevem
              auth Baileys e dados
```

**Modos:**

| Modo (env) | Server | Worker | Storage | Notas |
|---|---|---|---|---|
| `STORAGE_BACKEND=json + QUEUE_BACKEND=memory` | Faz tudo, Baileys local | não usado | Arquivos `data/` | Legado, dev rápido |
| `STORAGE_BACKEND=pg + QUEUE_BACKEND=memory` | Faz tudo, Baileys local | não usado | Postgres | Híbrido — não recomendo |
| `STORAGE_BACKEND=pg + QUEUE_BACKEND=redis` | API + producer, Baileys via proxy | Baileys + handlers | Postgres + Redis | **Recomendado pra produção** |

---

## 3. Inventário de arquivos (`backend/`)

### Entry points
- `server.js` — Express HTTP API. Producer da queue. Boot inicia Sentry, métricas, queue (`producer:true`), restoreSessions (só memory mode), scheduler, admin-scraper.
- `worker.js` — Processo separado. Seta `WORKER_PROCESS=true`, init queue (`consumer:true`), restoreSessions, registra `setSendHandler(processSendJob)` + `setControlHandler(handleControlJob)`, inicia heartbeat.

### Persistência (façades + impls)
Padrão: cada feature é uma **pasta** com `index.js` (facade) + `json.js` + `pg.js`. O `index.js` carrega `json` ou `pg` baseado em `isPg()` de `db.js`.

- `storage/{index,json,pg}.js` — estado por usuário (groups, settings, whatsappGroups, numbers, queue, pending, history, sentToday/Week, weekData, lastSend)
- `catalog/{index,json,pg}.js` + `catalog/product-key.js` — catálogo global de produtos
- `auth/{index,json,pg}.js` + `auth/baileys-pg.js` — users (JWT + bcrypt) e adapter Baileys ↔ Postgres
- `config/{index,json,pg}.js` — KV (afiliado, scraper config)
- `db.js` — singleton PrismaClient + `isPg()` + `backendName()`
- `prisma/schema.prisma` — 12 modelos

### WhatsApp (Fase 2.1 + 3)
- `whatsapp/index.js` — facade. Resolve `local` se `WORKER_PROCESS=true` ou modo memory; senão `proxy`.
- `whatsapp/local.js` — owna sessões Baileys em mapa em memória. Em modo PG usa `useDatabaseAuthState` (`auth/baileys-pg.js`); senão `useMultiFileAuthState` em `auth_states/<userId>/<numberId>/`. Hooks `connection.update` publicam status no Redis (via `infra/session-status.js`) quando `WORKER_PROCESS=true`.
- `whatsapp/proxy.js` — usado pelo server em modo redis. Cada op (send, createGroup, listGroups, etc) vira `queue.callControl(op, args)` aguardando resposta via `waitUntilFinished` (timeouts 15-60s). Status reads (getSession, listSessions, status) leem direto do Redis cache.
- `auth/baileys-pg.js` — adapter `useDatabaseAuthState(sessionId)`. Mirror exato de `useMultiFileAuthState`. PK composta `(sessionId, keyType, keyId)`. Encoding com `BufferJSON.replacer/reviver`. Trata `app-state-sync-key` com `proto.Message.AppStateSyncKeyData.fromObject`.
- `infra/session-status.js` — Redis-backed cache. Schema `nimbus:session:<userId>:<numberId>` → JSON `{numberId, status, qr, info, lastError, updatedAt}`. TTL 24h.

### Fila (Fase 2) e infra de observabilidade
Pasta `infra/` agrupa preocupações operacionais:

- `infra/queue.js` — facade memory/redis com 2 filas BullMQ:
  - `nimbus.send-message` — envios (concurrency 1, limiter 1/s, attempts 5, backoff exp 5s base, removeOnComplete 200, removeOnFail 500)
  - `nimbus.control` — RPC server↔worker (concurrency 4, attempts 1)
  - Helpers: `init({producer, consumer})`, `setSendHandler`, `setControlHandler`, `enqueueSend`, `callControl`, `listFailed`, `retryFailed`, `removeFailed`, `status`, `close`
- `infra/worker-heartbeat.js` — escreve `nimbus:worker:heartbeat` a cada 5s, TTL 60s. Server lê `ageSeconds()` em `/healthz`.
- `infra/metrics.js` — Prometheus client. Counters/Histograms/Gauges + `httpMiddleware` + `handler` pra `/metrics`.
- `infra/sentry.js` — wrapper. `init({context})`, `captureException`, `captureMessage`, `flush`. No-op sem `SENTRY_DSN`.
- `infra/logger.js` — pino. Pretty-print em dev, JSON em prod. `logger.child({module})` em quem migrou (scheduler, queue).

### Scheduler (Fase 2 modificada)
- `scheduler.js` — exporta `start, stop, tick, sendNextNow, refillNow, manualAdd, status, processSendJob`. Producer flow:
  1. `tick()` (30s): pra cada user → loadState → pra cada group → `processGroup()`
  2. `processGroup()`: **prune stale** (itens que não batem mais com `sources`/`categories`/`filters` atuais, preservando `manual: true`) → `refillQueue` (consulta catálogo) → `dispatchOne`
  3. `dispatchOne()`: se há item + janela ativa + intervalo respeitado → em redis: pop+lastSend+enqueue; em memory: sendItem inline
  4. `processSendJob(job)` (chamado pelo BullMQ Worker): loadState fresh → sendItem → updateGroupOps com history+métricas
- Helpers internos: `campaignFilterCtx(group)`, `itemMatchesCampaign(item, ctx)` — predicado compartilhado por `refillQueue`, `processGroup` e `sendNextNow` pra remover/filtrar itens stale de forma consistente.

### Scraping
Pasta `scraping/`:

- `scraping/affiliate.js` — gera shortlinks ML (cookie+tag), Amazon (tag), Shopee (App ID+Secret via GraphQL). Cache 7 dias por loja. Status reportado em `/api/affiliate`.
- `scraping/scraper.js` — entrypoints `scrapeML` (Puppeteer), `scrapeAmazon` (Puppeteer), `scrapeShopee` (GraphQL via `affiliate.fetchShopeeOffers`), `scrapeOfertas` (agregador). Constantes `CATEGORIES` e `STORES` (precisam estar em sync com `frontend/src/data/constants.js`).
- `scraping/admin.js` — orquestra runs periódicas, chamado por endpoints `/api/admin/scraper/*` (admin-only).

### Outros módulos
- `catalog/product-key.js` — `productKey(p)` MD5 estável (MLB id se houver, ASIN pra Amazon, item id pra Shopee, fallback origin+pathname ou nome+store). **PK do catálogo — não mudar sem regerar tudo.**

### Scripts (`backend/scripts/`)
- `migrate-json-to-pg.js` — migra `data/*.json` → Postgres (idempotente, `--dry-run`)
- `migrate-auth-to-pg.js` — migra `auth_states/<userId>/<numberId>/*.json` → tabela `baileys_auth` (idempotente, `--dry-run`)
- `backup-data.js` — copia `data/` pra `backups/data-YYYYMMDD-HHMMSS/`. Mantém últimos 96.
- `backup-remote.js` — sobe último snapshot pra S3-compatível. No-op sem `BACKUP_S3_*`. Compatível AWS/B2/R2/Wasabi/MinIO. Rotação remota baseada em `BACKUP_RETAIN_REMOTE` (default 30).

### Outros
- `ecosystem.config.js` — PM2: `nimbus-backend`, `nimbus-worker`, `nimbus-backup` (cron 15min), `nimbus-backup-remote` (cron 1h)
- `.env.example` — documenta todas envs
- `package.json` scripts: `dev`, `prisma:*`, `migrate-data`, `migrate-auth`, `backup`, `backup:remote`, `pm2:*`

### Dados não-versionados
- `backend/data/` (modo json) — JSON files
- `backend/auth_states/<userId>/<numberId>/` (modo json) — Baileys multi-file auth
- `backend/backups/` — snapshots locais
- `.env` — secrets

---

## 4. Schema Postgres (resumo)

```
User(id uuid PK, email unique, name, phone?, passwordHash, role default "user", createdAt)
UserState(userId PK→User, settings jsonb, updatedAt)

Group(id BIGINT PK, userId→User, name, messageTemplate, paused bool,
      categories jsonb, whatsappGroupIds jsonb, schedule jsonb, scraping jsonb,
      sentToday int, sentWeek int, weekData jsonb, lastSend string, avgDiscount string,
      createdAt, updatedAt)
   indexes: userId, paused

GroupHistory(id BIGINT autoinc, groupId→Group, productKey, name, link, img?, store?,
             price?, originalPrice?, discount?, sentAt, groupCount)
   indexes: (groupId, sentAt DESC), (groupId, productKey)

GroupQueueItem(id BIGINT autoinc, groupId→Group, productKey, position, payload jsonb, addedAt)
   unique: (groupId, productKey)
   indexes: (groupId, position)

GroupPendingItem(id BIGINT autoinc, groupId→Group, productKey, payload jsonb, addedAt)
   unique: (groupId, productKey)
   indexes: (groupId)

WhatsappGroup(id string PK, userId→User, numberId, jid, name, metadata jsonb)
   indexes: userId

WhatsappNumber(id string PK, userId→User, label?, phone?, metadata jsonb)
   indexes: userId

CatalogProduct(key PK, name, link, img?, price?, originalPrice?, discount?,
               store?, category?, rating?, sold?, payload jsonb, firstSeenAt, lastSeenAt)
   indexes: (category, discount DESC), store, lastSeenAt DESC, discount DESC

AppConfig(key PK, value jsonb, updatedAt)
   keys: "affiliate.ml", "affiliate.amazon", "scraper.config", "scraper.runs.last"

BaileysAuth(sessionId, keyType, keyId, value text, updatedAt)
   PK composta: (sessionId, keyType, keyId)
   indexes: sessionId
   sessionId formato: "<userId>::<numberId>"
   keyType: "creds" | "pre-key" | "session" | "sender-key" | "sender-key-memory" | "app-state-sync-key" | "app-state-sync-version"
   keyId: "" pra creds; ID específico pras outras
   value: JSON.stringify(v, BufferJSON.replacer)
```

**Race condition resolvida pelo schema**: queue/pending/history viraram tabelas dedicadas. O hack `OPS_FIELDS` (preservar campos do scheduler ao salvar pelo PUT do frontend) só vive na implementação JSON; em PG, frontend e scheduler escrevem em colunas/tabelas diferentes naturalmente.

---

## 5. Variáveis de ambiente

```ini
# Storage
STORAGE_BACKEND=json|pg                    # default: json
DATABASE_URL=postgresql://...              # required if pg

# Queue
QUEUE_BACKEND=memory|redis                 # default: memory
REDIS_URL=redis://localhost:6379

# Auth
JWT_SECRET=...                             # opcional; senão gerado em data/.jwt_secret
ADMIN_EMAILS=email1@x.com,email2@y.com     # promovidos a admin no login

# Afiliados (sobrescreve config persistida)
ML_AFFILIATE_TAG=...
ML_AFFILIATE_COOKIE=...
AMAZON_AFFILIATE_TAG=...
SHOPEE_AFFILIATE_APP_ID=...                # se setado, força config Shopee via env (bloqueia escrita dinâmica)
SHOPEE_AFFILIATE_APP_SECRET=...

# Hardening
NIMBUS_CORS_ORIGINS=https://app.x.com,https://*.x.com    # vazio = aceita tudo (dev)
LOG_LEVEL=debug|info|warn|error           # default: debug em dev, info em prod
NODE_ENV=development|production
PORT=3001

# Observabilidade
SENTRY_DSN=https://...@sentry.io/...      # vazio = desativado
SENTRY_RELEASE=v1.2.3

# Backup remoto S3-compatível (opcional)
BACKUP_S3_ENDPOINT=https://s3.us-west-002.backblazeb2.com  # AWS=vazio
BACKUP_S3_REGION=us-east-1
BACKUP_S3_BUCKET=
BACKUP_S3_PREFIX=nimbus/
BACKUP_S3_KEY_ID=
BACKUP_S3_SECRET=
BACKUP_RETAIN_REMOTE=30
```

`WORKER_PROCESS=true` é **interno** — setado pelo `worker.js` no início. **Não setar manualmente** em outro lugar.

---

## 6. Endpoints HTTP

Todos `/api/*` exigem `Authorization: Bearer <jwt>` exceto `auth/login` e `auth/register`.

### Pública
- `GET /healthz` — JSON com status do storage, scheduler, whatsapp, queue (send+control), worker, adminScraper. 200 ok / 503 degraded
- `GET /metrics` — Prometheus text format (sem auth — em prod ficar atrás de allowlist no nginx)

### Auth
- `POST /api/auth/register` (rate 5/min/IP)
- `POST /api/auth/login` (rate 10/min/IP)
- `GET /api/auth/me`
- `PATCH /api/auth/me`
- `POST /api/auth/password`

### Estado por usuário
- `GET /api/state` — full load (groups, numbers, whatsappGroups, settings)
- `PUT /api/state` — save (preserva OPS_FIELDS internamente em modo json)
- `GET /api/state/ops` — só campos operacionais do scheduler (polling 30s no frontend)

### Campanhas
- `POST /api/state/groups/:gid/send-now` — dispara próximo item ignorando janela
- `POST /api/state/groups/:gid/manual-add` — adiciona produto manual (suporta `force` pra sobrepor cooldown)
- `POST /api/state/groups/:gid/refill` — força refill da queue do catálogo
- `POST /api/state/groups/:gid/pending/:pid/approve` — move pending → queue
- `DELETE /api/state/groups/:gid/pending/:pid`
- `DELETE /api/state/groups/:gid/history` — limpa history (reset cooldown)

### Catálogo / Ofertas
- `GET /api/ofertas?category=X&minDiscount=N&minPrice=N&maxPrice=N&limit=N&sources=ml,amazon`
- `GET /api/categories`
- `GET /api/status`

### Afiliados
- `GET /api/affiliate` — devolve status `{ml, amazon, shopee}` consolidado
- `PUT /api/affiliate` (tag + cookie ML)
- `DELETE /api/affiliate`
- `POST /api/affiliate/test` (testa link ML real)
- `PUT/DELETE/POST /api/affiliate/amazon[/test]`
- `PUT/DELETE/POST /api/affiliate/shopee[/test]` — body `{appId, appSecret}` (PUT aceita só `appId` se já configurado)

### Scraper one-off
- `POST /api/scraper/fetch-url` — Puppeteer scrape de URL única

### WhatsApp (Baileys)
- `GET /api/whatsapp/sessions` — listSessions do user
- `POST /api/whatsapp/sessions/:id` — startSession (devolve QR depois via polling)
- `GET /api/whatsapp/sessions/:id` — status + QR
- `DELETE /api/whatsapp/sessions/:id`
- `GET /api/whatsapp/sessions/:id/groups` — listGroups Baileys
- `POST /api/whatsapp/sessions/:id/groups` — createGroup `{name, participants}`
- `GET /api/whatsapp/sessions/:id/groups/:jid/invite`
- `POST /api/whatsapp/sessions/:id/groups/:jid/invite/revoke`
- `DELETE /api/whatsapp/sessions/:id/groups/:jid` — leaveGroup
- `POST /api/whatsapp/sessions/:id/send` — manual `{jid, text, imageUrl}`
- `POST /api/whatsapp/sessions/:id/broadcast` — manual `{jids, text, imageUrl, intervalMs}`

### Admin (requireAdmin)
- `GET /api/admin/users`
- `DELETE /api/admin/users/:id`
- `PATCH /api/admin/users/:id/password`
- `PATCH /api/admin/users/:id/role`
- `GET /api/admin/scraper/config`
- `PUT /api/admin/scraper/config`
- `POST /api/admin/scraper/run` — dispara scraping em background
- `GET /api/admin/scraper/status`
- `GET /api/admin/catalog?page&pageSize&category&source&q&sortBy`
- `GET /api/admin/queue/failed?queue=send|control&start&end` — DLQ
- `POST /api/admin/queue/failed/:id/retry?queue=send|control`
- `DELETE /api/admin/queue/failed/:id?queue=send|control`

Rate limit global: 300 req/min/IP em `/api/*`.

---

## 7. Fluxos críticos

### 7.1 Auth
JWT TTL 30 dias. Segredo em env `JWT_SECRET` ou auto-gerado em `data/.jwt_secret` (modo 0600). Middleware `auth.requireAuth` injeta `req.user = { id, name, email, role }`. `syncRole()` no login/requireAuth promove pra admin se email em `ADMIN_EMAILS` — mas nunca rebaixa (evita lockout). 401 dispara `nimbus:unauthorized` no frontend → volta pra login.

### 7.2 Estado por usuário (frontend ↔ scheduler)
**Em PG**: queue/pending/history são tabelas separadas — sem race entre `PUT /api/state` (frontend) e `updateGroupOps` (scheduler). Frontend NUNCA envia esses campos.

**Em JSON**: existe race. Resolvido por:
- Mutex por userId (`withLock` em storage-json)
- Lista `OPS_FIELDS = ["queue","pending","history","sentToday","sentWeek","weekData","lastSend","avgDiscount"]`. Em `saveState()`, esses campos são preservados do disco (não sobrescritos pelo PUT do frontend).
- Atomic write via `.tmp` + rename.

**Frontend** (App.jsx ~linha 30) espelha `OPS_FIELDS` e nunca envia. Polling em `GET /api/state/ops` a cada 30s pra atualizar UI.

⚠️ **Adicionar novo campo gerenciado pelo scheduler exige adicionar em `OPS_FIELDS` nos dois lados** (frontend + backend modo json), ou virar uma coluna nova em PG.

### 7.3 Catálogo → fila por campanha
- Scraper popula CatalogProduct (admin-scraper)
- Scheduler tick: pra cada campanha →
  1. **Prune stale** — itens em `queue`/`pending` que não casam mais com `sources`/`categories`/`filters` atuais são removidos. Roda sempre, independente do threshold de refill. Items com `manual: true` (adicionados via "Adicionar produto" na UI) são preservados — usuário escolheu explicitamente, não é stale.
  2. **`refillQueue()`** — consulta catalog com filtros + dedup contra queue/pending/history (cooldown) + reaplica o predicate stale. Adiciona até `target` (queue se auto-aprovação, senão pending).
  3. **`dispatchOne()`** na janela horária + intervalo: em redis pops+enqueue, em memory chama sendItem inline.
- `sendNextNow` (botão "Enviar agora") também roda prune antes de despachar — usuário não quer mandar item que já não bate com config.

⚠️ **Regressão histórica**: antes do prune stale (commit anterior), trocar `sources` de `["ml","amazon"]` pra `["shopee"]` deixava ML/Amazon na fila — só novos itens eram filtrados. Resultado: usuário marcava "só Shopee" e via outras lojas sendo enviadas.

### 7.4 Gating por afiliado
Campanhas pausam (não scrape, não envia) se uma loja com **gating** não está configurada:

- **Mercado Livre** — exige tag + cookie. `groupUsesML()` em `data/constants.js` decide o banner.
- **Shopee** — exige App ID + App Secret. `groupUsesShopee()` em `data/constants.js`.
- **Amazon** — **não** tem gating: se afiliado não configurado, envia com link cru (sem tag).

Lógica no backend em `scheduler.js → affiliateGate(group)`: retorna `{paused, reason}` consultando `affiliate.status()`. Frontend espelha em `getGroupStats({affiliateConfigured: {ml, shopee}})`. Cache 7 dias por link cru → short_url, por loja.

### 7.5 Sincronia frontend↔backend
`frontend/src/data/constants.js` (`CATEGORIES`, `allSources`) e `backend/scraping/scraper.js` (`CATEGORIES`, `STORES`) são MANUALMENTE mantidos em sync. Comentário avisa. `allSources` no frontend usa rótulos amigáveis (`"Mercado Livre"`, `"Amazon"`, `"Shopee"`); o backend normaliza pra ids (`ml`/`amazon`/`shopee`) via `normalizeSource()`.

### 7.6 Envio agendado em modo redis (passo a passo)
1. Server scheduler tick (30s) → processGroup → dispatchOne
2. dispatchOne: pop item de Group.queue, set Group.lastSend, enqueueSend
3. BullMQ worker pega job (concurrency 1, limiter 1/s)
4. processSendJob: loadState fresh, sendItem
5. sendItem: aplica afiliado, monta texto, pra cada WA group vinculado: `wa.sendImage/sendText` (worker.js: facade resolve local → Baileys), 4s sleep entre destinos
6. Sucesso: append GroupHistory, increment sentToday/sentWeek/weekData
7. Fail: BullMQ retenta com backoff exp (5/10/20/40/80s). Após 5 falhas: vira DLQ (failed status), Sentry capture

### 7.7 Op manual via API em modo redis
Ex: usuário clica "Conectar WhatsApp"
1. Server `app.post("/api/whatsapp/sessions/:id")` → `wa.startSession(uid, nid)` → facade resolve **proxy**
2. proxy.startSession → `queue.callControl("startSession", [uid, nid], {timeoutMs: 30000})` → `_controlQueue.add` + `job.waitUntilFinished(_controlEvents, 30000)`
3. Worker BullMQ Worker (control queue) → `handleControlJob({op, args})` → `wa.startSession(uid, nid)` (worker = local) → Baileys cria socket
4. Eventos `connection.update`: status muda → `publishStatus(session)` → grava em `nimbus:session:<uid>:<nid>` no Redis
5. Worker job retorna snapshot: `{numberId, status, info, lastError}`. waitUntilFinished resolve.
6. Server proxy retorna pro endpoint, endpoint responde HTTP
7. UI faz polling `GET /api/whatsapp/sessions/:id` → server proxy.getSession lê do Redis cache → devolve QR/status

### 7.8 Restoration de sessões no boot do worker
- Em PG: SELECT distinct sessionId em baileys_auth WHERE keyType='creds' → cada sessionId vira [userId, numberId] → startSession() em paralelo
- Em arquivo: walk auth_states/<userId>/<numberId>/ → idem

### 7.9 Heartbeat & worker liveness
- Worker: `heartbeat.start()` no boot → escreve `nimbus:worker:heartbeat` JSON `{ts, pid, ...}` a cada 5s, TTL 60s
- Server `/healthz`: lê `heartbeat.ageSeconds()` → `worker.alive = age < 30`. Se >30 ou null, `healthy=false`, retorna 503

---

## 8. Métricas Prometheus

Em `/metrics`. Convenção: prefixo `nimbus_`, sufixo `_total` pra counter, `_seconds` pra histogram, sem sufixo pra gauge.

```
nimbus_http_requests_total{method, route, status}
nimbus_http_request_duration_seconds{method, route, status}        # histogram
nimbus_scheduler_ticks_total{status="ok"|"error"}
nimbus_scheduler_tick_duration_seconds                              # histogram
nimbus_scheduler_enqueued_total{target="queue"|"memory"}
nimbus_sends_total{status="ok"|"fail", store}
nimbus_send_duration_seconds                                        # histogram
nimbus_send_retry_total
nimbus_queue_depth{queue="send"|"control", state="waiting"|"active"|"delayed"|"failed"|"completed"}   # gauge, atualizado em /healthz
nimbus_whatsapp_sessions{status}                                    # gauge, ainda não populado em todos paths
nimbus_catalog_products{store}                                      # gauge, ainda não populado
nimbus_catalog_scrape_runs_total{status}                            # counter, ainda não populado
nimbus_worker_heartbeat_age_seconds                                 # gauge, set em /healthz
```

Mais default node metrics (heap, gc, event loop lag) via `prom-client.collectDefaultMetrics`.

---

## 9. Logging

`pino` em `logger.js`. Em prod: JSON em stdout (PM2 captura, `pm2 install pm2-logrotate` rotaciona). Em dev: pretty-print.

Migrado pra `logger.child({module})`:
- `scheduler.js` (`module: "scheduler"`) — campos típicos: `userId`, `groupId`, `group` (name), `waGroup`, `jid`, `item`, `err`
- `infra/queue.js` (`module: "queue"`) — campos: `queue` ("send"|"control"), `jobId`, `attempt`, `max`, `op`, `err`

Outros módulos ainda têm `console.log/error` legados — não-bloqueante mas pode migrar depois.

Process error handlers (`unhandledRejection`, `uncaughtException`) em server.js + worker.js usam pino + Sentry capture.

---

## 10. Dependências chave

```json
{
  "@aws-sdk/client-s3": "backup remoto",
  "@hapi/boom": "(legado, pouco uso)",
  "@prisma/client": "ORM",
  "@sentry/node": "captura de erros",
  "@whiskeysockets/baileys": "WhatsApp",
  "bcryptjs": "hash de senha",
  "bullmq": "fila",
  "cors": "CORS",
  "dotenv": "env loader",
  "express": "HTTP server (v5)",
  "express-rate-limit": "rate limiting",
  "helmet": "security headers",
  "ioredis": "Redis client",
  "jsonwebtoken": "JWT",
  "pino": "structured logging",
  "prisma": "schema/migration tool",
  "prom-client": "Prometheus",
  "puppeteer": "scraping",
  "qrcode": "QR data URL"
}
```

---

## 11. Comandos

### Subir local (Windows)
```bat
start.bat
```
Detecta `QUEUE_BACKEND=redis` e sobe 4 terminais (Backend, Worker, Frontend, ngrok). Em memory mode: sobe 3.

### Manual
```bash
docker compose up -d                       # Postgres + Redis
cd backend
npx prisma migrate deploy                  # aplica migrations
npm run migrate-data                       # one-shot JSON → PG
npm run migrate-auth                       # one-shot auth_states/ → PG (Fase 3)
STORAGE_BACKEND=pg QUEUE_BACKEND=redis node server.js   # terminal A
STORAGE_BACKEND=pg QUEUE_BACKEND=redis node worker.js   # terminal B
cd ../frontend && npx vite --host          # terminal C
```

### Produção (PM2)
```bash
cd backend
npm install -g pm2
pm2 start ecosystem.config.js              # backend + worker + 2 backups
pm2 install pm2-logrotate                  # rotação de logs
pm2 set pm2-logrotate:max_size 50M
pm2 set pm2-logrotate:retain 14
pm2 save && pm2 startup                    # autostart no SO
```

### Backup
```bash
npm run backup           # snapshot local em backups/data-YYYYMMDD-HHMMSS/
npm run backup:remote    # sobe último snapshot pra S3-compatível (no-op sem env)
```

### Lint
```bash
cd frontend && npm run lint
```

### Testes (Vitest)
```bat
test.bat                  :: wrapper na raiz — roda tudo (~20s, 100+ testes)
```

Ou direto:
```bash
cd tests
npm install                # primeira vez
npm test                   # tudo
npm run test:unit          # unitários (productKey, ASIN, Shopee parsing)
npm run test:integration   # auth, state, catálogo, afiliados, scheduler
npm run test:journey       # jornada completa (registro → afiliado → catálogo → campanha → refill → send-now → reset)
npm run test:watch
```

Os testes rodam o backend inteiro em-memória com **Baileys mockado** e `NIMBUS_DATA_DIR` apontando pra tmpdir por worker — não tocam em `backend/data/`. Cobrem auth, state com a corrida do `OPS_FIELDS` (scheduler vs frontend), catálogo (upsert/query/filtros incluindo Shopee), afiliados ML/Amazon/Shopee, scheduler (`refillNow`/`manualAdd`/`sendNextNow`/`tick`, incluindo prune de itens stale), e jornada completa. **Fora do escopo**: scraping real (Puppeteer), WhatsApp real (Baileys substituído por mock que registra chamadas em `waCalls`), UI visual.

`start.bat` **não** roda testes — sobe direto. Pra rodar antes de subir: `test.bat && start.bat`.

---

## 12. Rollbacks (cada fase)

| Fase | Como reverter | O que fica órfão |
|---|---|---|
| 1 (Postgres) | `STORAGE_BACKEND=json` | Dados ainda em `backend/data/` (é o que app vai ler) |
| 2 (Queue Redis) | `QUEUE_BACKEND=memory` | Jobs em-vôo no Redis (drenar antes em prod) |
| 2.1 (Worker process) | `QUEUE_BACKEND=memory` | Worker process não tem mais função (pode matar) |
| 3 (Auth Baileys PG) | `STORAGE_BACKEND=json` | `baileys_auth` em PG fica intocada; app volta a usar `auth_states/` |
| 4 (Sentry) | `SENTRY_DSN=` vazio | nada |

Tudo é feature flag. Nenhuma migração destrutiva. Postgres não foi normalizado a ponto de impedir export de volta pra JSON (`payload jsonb` preserva campos originais).

---

## 13. Convenções de código

- Backend: CommonJS (`require`)
- Frontend: ESM
- Sem TypeScript em ambos
- Frontend: estilos inline + CSS variables; sem framework UI; fetch nativo (sem axios)
- Auth: JWT em `localStorage["nimbus.token"]`; helper `http()` injeta `Authorization: Bearer` e trata 401
- IDs de Group: `BigInt` (legado: frontend gera com `Date.now()`) — tratamento especial no Prisma
- IDs de WhatsappGroup/WhatsappNumber: `string`
- Atomic writes em modo JSON: sempre `.tmp` + `rename`
- Mutexes: per-user lock em storage-json; per-catalog lock em catalog-json

---

## 14. Limitações conhecidas / dívida técnica

1. **WhatsApp sessões: 1 worker only**. Múltiplos workers exigem sticky routing por número (Phase 2.2 / 3.1 — não implementado).
2. **Worker single-instance no PM2**. Restart do worker = downtime de envios até subir (~5s). Aceitável hoje.
3. **DLQ não tem retenção configurável por idade** — só por count (500). Pode encher lentamente em produção.
4. **Sem tracing distribuído** (OpenTelemetry). Pra debug end-to-end de um envio, hoje precisa correlacionar logs por jobId.
5. **Métricas catalog/whatsapp gauges declarados mas não populados** em todos paths. Quem precisar instrumentar adiciona.
6. **Frontend espelha OPS_FIELDS** em código. Modo PG não precisa, mas frontend não sabe diferenciar — sempre filtra. Funciona, mas é tech debt.
7. **`productKey` é PK do catálogo**. Mudar a função quebra cooldown e dedup pra produtos já enfileirados/no histórico.
8. **Scraper Puppeteer no mesmo processo do server** (admin-scraper). Pesado. Plano sugeria container separado — não feito.
9. **Sem rate limit por usuário, só por IP**. Usuário malicioso atrás do mesmo IP que outros legítimos seria limitado em conjunto.
10. **`/metrics` sem auth**. Em prod, ficar atrás de allowlist no proxy reverso.
11. **Auth state PG ainda em uso paralelo com `auth_states/` files** durante validação. Quando confirmar, mover pra backup.
12. **WhatsApp Cloud API não avaliada** — escolha de manter Baileys foi consciente (ver `STATUS_PARA_SOCIO.md`).

---

## 15. Como me perguntar sobre isso (se você é a IA)

Pra responder bem, peça:

1. **Pra ver código específico**: cite o arquivo que o doc menciona. Ex: "preciso ver `backend/queue.js` linhas X-Y pra confirmar como o handler é registrado".
2. **Pra entender o porquê de uma decisão**: cheque seções 2, 7, 12 antes de assumir que algo é bug.
3. **Pra debug de produção**: comece pedindo log do `/healthz`, /metrics relevantes, e `pm2 logs` recentes.
4. **Pra adicionar feature**: confirme que o fluxo passa pela facade certa (storage/whatsapp/queue) — atalho via implementação direta quebra o feature flag.
5. **Pra mudanças de schema**: rodar `npx prisma migrate dev --name <descrição>` no `backend/`. Schema em `prisma/schema.prisma`.

Se algo neste doc estiver desatualizado em relação ao código, **o código vence**. Doc reflete snapshot 2026-05-11.
