# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Visão geral

Nimbus é uma plataforma SaaS de automação de marketing por WhatsApp para ofertas. Faz scraping de produtos (Mercado Livre, Amazon), permite organizar campanhas por categoria e dispara mensagens em grupos de WhatsApp em horários configuráveis. Stack: React 19 + Vite no frontend, Node + Express 5 no backend, persistência em JSON, Baileys (WhatsApp) e Puppeteer (scraping).

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

**Persistência (JSON vs Postgres).** O backend tem dois modos de persistência, selecionados por `STORAGE_BACKEND`:

- `STORAGE_BACKEND=json` (default) — modo legado com arquivos em `backend/data/`. Não precisa de Postgres. Bom pra desenvolvimento rápido.
- `STORAGE_BACKEND=pg` — usa Postgres via Prisma. É o modo da Fase 1 do plano de escala.

**Fila de envios (Fase 2 + 2.1).** Modo selecionado por `QUEUE_BACKEND`:

- `QUEUE_BACKEND=memory` (default) — single process. Sem persistência, sem retry. Scheduler envia inline (comportamento legado).
- `QUEUE_BACKEND=redis` — **dois processos**:
  - **Server** (`node server.js`): HTTP API + scheduler producer (popa item, enfileira). Não owna Baileys nesse modo.
  - **Worker** (`node worker.js`): owna Baileys (sessões + envios) + consome filas (`send-message` com retry 5×, e `control` pro RPC do server). Em PM2 sobe como `nimbus-worker`.

  Filas BullMQ no Redis. Worker publica status das sessões no Redis (`nimbus:session:<userId>:<numberId>`) — `whatsapp-proxy.js` no server lê desse cache pra responder QR/status sem RPC.

Pra subir em modo PG + Redis localmente:

```bash
# 1. Sobe Postgres + Redis no Docker (compose define ambos)
docker compose up -d

# 2. Cria/atualiza schema (gera client + roda migrations)
cd backend
npx prisma migrate dev   # primeira vez (cria a migration)
# ou
npx prisma migrate deploy  # subsequente (CI / produção)

# 3. (Uma vez) Migra dados existentes do JSON pro Postgres
npm run migrate-data            # commit
npm run migrate-data -- --dry-run  # preview sem escrever

# 4. (Opcional, Fase 3) Migra sessões Baileys de auth_states/ pra Postgres
npm run migrate-auth                # commit
npm run migrate-auth -- --dry-run   # preview

# 5. Sobe backend em modo PG + Redis (server + worker em terminais separados)
STORAGE_BACKEND=pg QUEUE_BACKEND=redis node server.js
STORAGE_BACKEND=pg QUEUE_BACKEND=redis node worker.js
# (no Windows: start.bat sobe os dois automaticamente quando QUEUE_BACKEND=redis)
```

Ver `backend/.env.example` pras variáveis. Trocar entre json/pg sem rodar a migração faz o app voltar a ler do disco — é o "rollback" da Fase 1. Trocar `QUEUE_BACKEND` de `redis` pra `memory` é o rollback da Fase 2 — jobs que estavam em-vôo no Redis ficam órfãos (precisam ser drenados antes da troca em produção); o worker.js também não é mais necessário, server faz tudo.

Lint do frontend (não há lint no backend):

```bash
cd frontend && npm run lint
```

Build de produção do frontend:

```bash
cd frontend && npm run build
```

**Suíte de testes automatizada** (`tests/`, Vitest 2.x + supertest). Roda backend inteiro em-memória com WhatsApp/Baileys mockado e `NIMBUS_DATA_DIR` apontando pra tmpdir por worker, então não toca em `backend/data/`. ~83 testes, ~20s no total.

```bat
test.bat             :: wrapper na raiz — roda toda a suite
```

Ou direto:

```bash
cd tests
npm install          # primeira vez
npm test             # tudo
npm run test:unit    # unitarios (productKey, ASIN)
npm run test:integration
npm run test:journey # jornada completa do usuario
npm run test:watch
```

Cobertura: auth (register/login/me/admin), state com a **corrida do OPS_FIELDS** (scheduler vs frontend), catálogo (upsert/query/filtros, `/api/ofertas`), afiliado ML+Amazon, scheduler (`refillNow`/`manualAdd`/`sendNextNow`/`tick`) e jornada completa (registro → afiliado → catálogo → campanha → refill → send-now → reset). Fora do escopo: scraping real (Puppeteer), WhatsApp real (Baileys substituído por mock que registra chamadas em `waCalls`) e UI visual.

`start.bat` **não** roda testes — sobe direto. Pra rodar testes antes de subir, encadeie: `test.bat && start.bat`.

Mudanças no backend que sustentam os testes (importantes ao mexer):
- Módulos JSON (`storage-json.js`, `auth-json.js`, `catalog-json.js`, `app-config-json.js`) leem `NIMBUS_DATA_DIR` (default: `backend/data/`).
- `server.js` exporta `{ app, boot }` e só chama `boot()` quando `require.main === module` (supertest carrega o app sem bindar porta).
- Rate limiters no `server.js` viram no-op quando `NODE_ENV === "test"`.

Variáveis de ambiente relevantes (lidas pelo backend):

- `STORAGE_BACKEND` — `json` (default, legado) ou `pg` (Postgres via Prisma). Em modo `pg`, exige `DATABASE_URL` e schema migrado.
- `DATABASE_URL` — connection string do Postgres (modo `pg`). Ex: `postgresql://nimbus:nimbus_dev@localhost:5432/nimbus?schema=public`.
- `QUEUE_BACKEND` — `memory` (default, legado) ou `redis` (BullMQ). Em modo `redis`, exige `REDIS_URL` e Redis rodando.
- `REDIS_URL` — URL do Redis (modo `redis`). Default: `redis://localhost:6379`.
- `JWT_SECRET` — sobrescreve o segredo persistido em `backend/data/.jwt_secret`.
- `ADMIN_EMAILS` — emails (separados por vírgula) que recebem `role=admin` automaticamente no login. `start.bat` já define `allangroisman@gmail.com`.
- `ML_AFFILIATE_TAG` / `ML_AFFILIATE_COOKIE` — sobrescrevem a config de afiliado ML (precedência sobre o storage).
- `AMAZON_AFFILIATE_TAG` — sobrescreve a tag de afiliado Amazon.
- `NIMBUS_CORS_ORIGINS` — allowlist de origens CORS, separadas por vírgula (suporta `*.dominio.com`). Vazio = aceita tudo (modo dev).
- `LOG_LEVEL` — nível do pino (`debug`/`info`/`warn`/`error`). Default: `debug` em dev, `info` em prod.
- `NODE_ENV` — `development` (default) ou `production`. Em prod ativa logs JSON.
- `PORT` — porta do backend (default 3001).

### Operação (Fase 0 — hardening)

- **Health check**: `GET /healthz` — público, sem auth, retorna 200/503 com status do storage, scheduler, sessões WhatsApp, queue (BullMQ) e worker heartbeat. Use em load balancers / monitoring.
- **Métricas Prometheus**: `GET /metrics` — formato texto Prometheus. Counters (`nimbus_http_requests_total`, `nimbus_sends_total`, `nimbus_scheduler_ticks_total`), histograms (`nimbus_send_duration_seconds`, `nimbus_http_request_duration_seconds`), gauges (`nimbus_queue_depth`, `nimbus_whatsapp_sessions`, `nimbus_worker_heartbeat_age_seconds`).
- **Sentry**: ativa se `SENTRY_DSN` estiver setada. Captura `unhandledRejection`, `uncaughtException`, falhas terminais de jobs BullMQ. Sem DSN: no-op.
- **Backup local**: `cd backend && npm run backup` — copia `data/` pra `backups/data-YYYYMMDD-HHMMSS/`. Mantém últimos 96 (24h se rodar a cada 15min).
- **Backup remoto** (S3-compatível): `cd backend && npm run backup:remote` — sobe último snapshot pra S3/B2/R2/Wasabi. Sem env `BACKUP_S3_*` setadas, exit 0 sem fazer nada. PM2 roda a cada 1h.
- **PM2** (produção): `cd backend && npm run pm2:start` usa `ecosystem.config.js` — sobe `nimbus-backend` + `nimbus-worker` + `nimbus-backup` (15min) + `nimbus-backup-remote` (1h). Pra logs rotacionados: `pm2 install pm2-logrotate`.
- **Rate limit**: `/api/auth/login` (10/min/IP), `/api/auth/register` (5/min/IP), global `/api/*` (300/min/IP).
- **DLQ**: jobs que falham 5× ficam na fila como `failed`. Endpoints admin: `GET /api/admin/queue/failed`, `POST /api/admin/queue/failed/:id/retry`, `DELETE /api/admin/queue/failed/:id`.
- **Worker heartbeat**: worker escreve em `nimbus:worker:heartbeat` (Redis, TTL 60s) a cada 5s. Server checa em `/healthz` — se ageSeconds > 30, marca worker como morto e devolve 503.

## Arquitetura

### Camadas

- **Frontend** (`frontend/src/`): SPA React 19 com Vite. Sem TypeScript, sem framework de CSS — estilos inline + CSS variables para tema claro/escuro. Sem axios — usa `fetch` nativo.
- **Backend** (`backend/`): Express 5 (`server.js`) é só roteamento — toda lógica fica em módulos: `auth.js`, `storage.js`, `scheduler.js`, `whatsapp.js`, `scraper.js`, `affiliate.js`, `catalog.js`, `admin-scraper.js`, `app-config.js`, `logger.js`. **Os módulos de persistência (`storage`, `catalog`, `auth`, `app-config`) são façades que selecionam a implementação JSON ou Postgres em runtime via `STORAGE_BACKEND`** — o sufixo `-json.js` / `-pg.js` indica a implementação. `db.js` exporta o cliente Prisma singleton e o helper `isPg()`. **Toda IO de arquivo é async (`fs/promises`)** desde a Fase 0 — `writeFileSync` foi removido pra não bloquear o event loop. Reads em hot path (users, catalog, app-config) usam cache em memória populado por `warmup()` no boot.
- **Persistência (JSON, default)**: arquivos JSON em `backend/data/` (gitignored). Não há banco. Os credenciais Baileys ficam em `backend/auth_states/<numberId>/` (também gitignored).
- **Persistência (Postgres, Fase 1)**: schema em `backend/prisma/schema.prisma`, dev local via `docker compose up -d`. Mesma interface pública dos módulos — server.js não muda. `OPS_FIELDS` deixa de ser necessário internamente porque `queue/pending/history` viram tabelas dedicadas (sem race com saveState do frontend).
- **Fila de envios (Fase 2)**: `backend/queue.js` é facade `memory|redis`. Em modo `redis`, BullMQ persiste jobs no Redis. Scheduler vira producer (`dispatchOne` popa item + atualiza `lastSend` antes de enfileirar). `processSendJob` (handler) faz o envio + persiste history/métricas, com retry exponencial (5 tentativas, 5s→80s).
- **Worker process (Fase 2.1)**: em modo `redis`, `backend/worker.js` é processo separado que owna Baileys + consome as filas (`send-message` e `control`). `backend/whatsapp.js` é facade — resolve pra `whatsapp-local.js` no worker (`WORKER_PROCESS=true`) e pra `whatsapp-proxy.js` no server. Server proxy usa `queue.callControl` (BullMQ RPC com `waitUntilFinished`) pra ops e `session-status.read` (cache Redis populado pelo worker) pra status/QR. Em modo `memory`, server faz tudo no mesmo processo (worker.js ignorado).

### Fluxos críticos para entender antes de mexer

**1. Autenticação (JWT + bcrypt).** `auth.js` mantém `data/users.json` e o segredo JWT em `data/.jwt_secret` (gerado uma vez, modo 0600). TTL de 30 dias. Toda rota usa o middleware `auth.requireAuth` que injeta `req.user = { id, name, email, role }`. Em 401 o frontend dispara `nimbus:unauthorized` e volta pra tela de login. `auth.requireAdmin` exige `role === "admin"`. A função `syncRole()` é chamada no login/`requireAuth` e promove para admin se o email estiver em `ADMIN_EMAILS` — mas nunca rebaixa automaticamente (evita lockout). Para desenvolvimento local, a env `ADMIN_EMAILS` é a única forma sustentável de virar admin.

**2. Estado por usuário (frontend ↔ scheduler).** Esta é a parte mais sutil do sistema. O estado da app de cada usuário é um único JSON em `backend/data/state/<userId>.json` contendo `groups`, `numbers`, `whatsappGroups`, `settings`. **Existem dois escritores concorrentes**:

- O **frontend** salva via `PUT /api/state` com debounce de 800ms sempre que algo muda (ver `App.jsx`).
- O **scheduler** (`backend/scheduler.js`) escreve campos operacionais por grupo a cada tick (30s).

`storage.js` resolve o conflito com:
- Mutex por `userId` (`withLock`) que serializa leituras/escritas.
- Lista `OPS_FIELDS = ["queue", "pending", "history", "sentToday", "sentWeek", "weekData", "lastSend", "avgDiscount"]` que SÓ o scheduler escreve. Em `saveState()` (chamado pelo PUT do frontend), esses campos são preservados do disco para evitar que o auto-save do frontend sobrescreva o trabalho do scheduler.
- Escrita atômica via `.tmp` + rename.

O frontend espelha `OPS_FIELDS` em `App.jsx` (linha 30) e nunca os envia no save — apenas lê via polling em `GET /api/state/ops` a cada 30s. **Ao adicionar um novo campo gerenciado pelo scheduler, é obrigatório adicioná-lo a `OPS_FIELDS` nos dois lados (frontend e backend) — caso contrário, o auto-save do frontend vai apagá-lo.**

**3. Catálogo global (admin-scraper) → fila por campanha (scheduler).** Há um único catálogo de produtos compartilhado por todos os usuários (`backend/data/catalog.json`):

- `admin-scraper.js` roda periodicamente (configurável pelo admin via `/api/admin/scraper/*`) e dá upsert no catálogo.
- `catalog.js` mantém um mutex global e indexa produtos por `productKey()` (hash MD5 derivado do MLB id quando possível, com fallback pra origin+pathname). **A mesma `productKey()` está duplicada em `scheduler.js` para evitar import circular — qualquer mudança precisa ser feita nos dois lugares.**
- O scheduler, no tick, lê do catálogo, aplica filtros da campanha, e popula `group.queue`. Quando entra na janela horária, dispara via `whatsapp.js` (Baileys).
- Endpoint `GET /api/ofertas` lê do catálogo (não scrape on-demand).

**4. Gating por afiliado.** Campanhas que dependem do Mercado Livre ficam pausadas (não scrape, não envia) enquanto não houver TAG + cookie configurados em `affiliate.js`. O frontend usa o helper `groupUsesML()` em `data/constants.js` e mostra banner. Se o cookie estiver presente mas expirado, cai para o link cru — mas se nunca foi configurado, não envia. Cache de 7 dias por link cru → short_url.

**5. Sincronia frontend ↔ backend de categorias e fontes.** `frontend/src/data/constants.js` (`CATEGORIES`, `allSources`) e `backend/scraper.js` (`CATEGORIES`, `STORES`) precisam ser mantidos em sincronia manualmente. O comentário no constants.js avisa, mas é fácil esquecer ao adicionar uma categoria nova.

**6. WhatsApp (Baileys).** Persistência da sessão depende de `STORAGE_BACKEND`:

- `STORAGE_BACKEND=json` (legado) — arquivos em `backend/auth_states/<userId>/<numberId>/` via `useMultiFileAuthState`.
- `STORAGE_BACKEND=pg` (Fase 3) — tabela `baileys_auth` (sessionId, keyType, keyId, value) via `useDatabaseAuthState` em `baileys-auth-pg.js`. Permite trocar de máquina sem perder sessão.

`whatsapp-local.js` mantém o mapa de sessões em memória do processo; `restoreSessions()` religa as existentes. QR code é convertido pra data URL via `qrcode`. Em modo `memory`, isso roda no server. Em modo `redis` (Fase 2.1), roda no `worker.js` — server vê tudo via `whatsapp-proxy.js` (RPC pra ops, cache Redis pra status/QR). Broadcasts adicionam intervalo (default 4s) entre envios para reduzir risco de bloqueio.

Pra migrar sessões existentes de arquivo pra Postgres: `cd backend && npm run migrate-auth` (idempotente, suporta `--dry-run`).

**7. Fila de envios (Fase 2 + 2.1 — `QUEUE_BACKEND=redis`).** Duas filas BullMQ no Redis:

- `nimbus.send-message` — envios agendados, retry exponencial (5×, 5s→80s), concurrency 1, limiter 1/s
- `nimbus.control` — RPC server↔worker (start session, send manual, list groups, etc), concurrency 4, sem retry

Fluxo end-to-end de um envio agendado:

1. **Producer** (server, `scheduler.dispatchOne` no tick 30s): se há item na queue + janela ativa + intervalo respeitado, **popa o primeiro item** e atualiza `lastSend` no storage **antes** de enfileirar. Isso impede que o próximo tick re-enfileire o mesmo item.
2. **Worker** (`worker.js`, `processSendJob`): consome o job, chama `sendItem` → `wa.sendImage/sendText` (Baileys local), monta novo history/métricas e persiste só history + sentToday/sentWeek/weekData (queue e lastSend já foram setadas pelo producer).
3. **Falha** → BullMQ retenta com backoff. Falha final (5 tentativas) = item perdido + log. Sem DLQ ainda.

Fluxo de uma op manual via API (ex: usuário clica "Conectar WhatsApp"):

1. Server endpoint chama `wa.startSession(userId, numberId)` — facade resolve pra `whatsapp-proxy.startSession`
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
- `backend/data/` e `backend/auth_states/` estão no `.gitignore` — nunca versionar nada de lá.
- Persistência: sempre escrever em `.tmp` e renomear (atômico). Padrão usado em `storage.js`, `catalog.js`, `admin-scraper.js`, `affiliate.js`.
