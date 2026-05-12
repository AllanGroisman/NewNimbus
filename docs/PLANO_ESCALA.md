# Plano de evolução para escala — Nimbus

Documento criado em 2026-05-10. **Última atualização: 2026-05-11** (Fases 0, 1, 2, 2.1, 3 e 4 entregues).

---

## Status executivo

| Fase | Original (estimado) | Status real | Esforço gasto |
|---|---|---|---|
| 0 — Hardening | 3-5 dias | ✅ Entregue (faltam 2 itens não-bloqueantes) | 1 sessão |
| 1 — Postgres | 1-2 semanas | ✅ Entregue + migrado | 1 sessão |
| 2 — Workers + fila (BullMQ) | 1 semana | ✅ Entregue | 1 sessão |
| 2.1 — Worker em processo separado | (não estava no plano) | ✅ Entregue | 1 sessão |
| 3 — Baileys distribuído (caminho A) | 2 semanas | ✅ Auth state em PG entregue. Sticky routing pendente. | 1 sessão |
| 3 — WhatsApp Cloud API (caminho B) | — | ❌ Descartado pela escolha de manter Baileys |
| 4 — Observabilidade | paralelo | ✅ Entregue (Sentry pendente apenas o DSN do user) | 1 sessão |

> O plano original previa "ir ao ar em larga escala em 2-3 meses". Estamos com a estrutura técnica entregue em ~1 semana. O que falta não bloqueia escala — são afinações operacionais.

---

## Diagnóstico atual (atualizado)

A arquitetura **mudou drasticamente** desde o diagnóstico inicial. O que era frágil:

| Era assim (2026-05-10) | Está assim agora (2026-05-11) |
|---|---|
| Arquivos JSON síncronos | Postgres via Prisma (com fallback `STORAGE_BACKEND=json`) |
| `fs.writeFileSync` no event loop | Tudo `fs/promises` async; PG-only quando ativo |
| Single process (API+scheduler+Baileys) | 2 processos (server + worker), com facade `WORKER_PROCESS` |
| Scheduler O(usuários × grupos) síncrono | Producer pop+enqueue → BullMQ workers paralelos |
| Sessões Baileys em arquivo no disco local | Em Postgres (`baileys_auth`) — trocar de máquina não perde sessão |
| Sem health check | `/healthz` 200/503 com storage, scheduler, queue, worker, sessões |
| Zero observabilidade | `/metrics` Prometheus + Sentry skeleton + pino estruturado |
| Sem rate limit / CORS aberto | Rate limit em login/register/global + CORS allowlist + Helmet |
| Backup só local (zero) | Backup local 15min (PM2) + remoto S3-compatível 1h (PM2) |
| Sem retry de envio | BullMQ retry 5× exponencial + DLQ com endpoints admin |
| `productKey` duplicada em 2 arquivos | Módulo único `product-key.js` |

---

## ✅ Fase 0 — Hardening

**Entregue:**
- Rate limit: `/api/auth/login` (10/min/IP), `/api/auth/register` (5/min/IP), global `/api/*` (300/min/IP)
- CORS allowlist via `NIMBUS_CORS_ORIGINS` (suporta `*.dominio.com`)
- Helmet com CORP relaxado pra thumbnails de produto
- `fs.writeFileSync` → `fs.promises` em todos os módulos de persistência
- Health check real `/healthz` (verifica storage + scheduler + WhatsApp + queue + worker)
- Process error handlers (`unhandledRejection`, `uncaughtException`) com pino + Sentry
- PM2 `ecosystem.config.js` com `max_memory_restart: 1G`
- Backup local automático (PM2 cron 15min, retenção 96 snapshots)

**Pendente (não-bloqueante):**
- ⏸️ Sentry — código pronto, falta apenas o DSN do usuário (criar conta em sentry.io e colar `SENTRY_DSN` no env)
- ⏸️ Backup remoto — código pronto, falta credenciais S3/B2/R2 (criar bucket e colar `BACKUP_S3_*` no env)

---

## ✅ Fase 1 — Postgres no lugar de JSON

**Entregue:**
- Schema Prisma com 12 modelos (`User`, `UserState`, `Group`, `GroupHistory`, `GroupQueueItem`, `GroupPendingItem`, `WhatsappGroup`, `WhatsappNumber`, `CatalogProduct`, `AppConfig`, `BaileysAuth` + relacionamentos)
- Façades em `storage.js`, `catalog.js`, `auth.js`, `app-config.js` que selecionam `*-json.js` ou `*-pg.js` em runtime via `STORAGE_BACKEND`
- Singleton Prisma client em `db.js`
- Script `migrate-json-to-pg.js` idempotente (suporta `--dry-run`)
- Cache em memória pra interfaces sync no boot (warmup)
- Docker Compose com Postgres 16 + healthcheck

**Migração rodada:** 2 usuários, 955 produtos, 4 grupos com queue/pending/history completos.

**Ganho conceitual:** O hack `OPS_FIELDS` (que protegia campos do scheduler do save do frontend) deixou de ser necessário internamente — `queue`, `pending`, `history` viraram tabelas dedicadas.

---

## ✅ Fase 2 — Workers + fila (BullMQ + Redis)

**Entregue:**
- `queue.js` facade com `QUEUE_BACKEND=memory|redis`
- Producer/consumer split em `scheduler.js` — `dispatchOne` popa item + atualiza `lastSend` antes de enfileirar
- Handler `processSendJob` extraído pra ser chamável pelo worker
- Retry exponencial 5× (5s → 10s → 20s → 40s → 80s)
- Rate limiter BullMQ: 1 job/s por worker
- Docker Compose com Redis 7-alpine

**Ganho:** Mensagens não somem em restart, retry automático, observabilidade da fila.

---

## ✅ Fase 2.1 — Worker em processo separado (extensão do plano)

**Entregue:**
- `worker.js` — entry point separado que owna Baileys + consome filas
- `whatsapp.js` virou facade — resolve `whatsapp-local.js` (worker) ou `whatsapp-proxy.js` (server)
- Control queue `nimbus.control` pra RPC server↔worker via `waitUntilFinished`
- `session-status.js` — cache Redis com snapshot de cada sessão (status, QR, info) — server lê sem RPC
- PM2 entry pra `nimbus-worker`
- `start.bat` detecta `QUEUE_BACKEND=redis` e sobe 4 terminais (Backend, Worker, Frontend, ngrok)

**Ganho:** Server pode reiniciar sem matar Baileys; foundation pra sharding.

---

## ✅ Fase 3 — Baileys distribuído (caminho A escolhido)

**Entregue:**
- Schema `BaileysAuth(sessionId, keyType, keyId, value)` com PK composta
- `baileys-auth-pg.js` — adapter `useDatabaseAuthState` que substitui `useMultiFileAuthState` quando `STORAGE_BACKEND=pg`
- Encoding com `BufferJSON.replacer/reviver` (suporta os Buffer do Signal protocol)
- Script `migrate-auth-to-pg.js` (idempotente, `--dry-run`) — migrou 1599 chaves de uma sessão real
- `whatsapp-local.js` lê auth de PG ou disco transparente

**Pendente (Phase 2.2 / 3.1 — futuro quando volume justificar):**
- Sticky routing por número entre múltiplos workers
- Tabela `session_routes(session_id, worker_id, last_heartbeat)`
- Re-eleição automática se worker cai

---

## ✅ Fase 4 — Observabilidade

**Entregue:**
- **Métricas Prometheus** em `/metrics`:
  - `nimbus_http_requests_total{method,route,status}` (counter)
  - `nimbus_http_request_duration_seconds` (histogram)
  - `nimbus_scheduler_ticks_total{status}` (counter)
  - `nimbus_scheduler_tick_duration_seconds` (histogram)
  - `nimbus_scheduler_enqueued_total{target}` (counter)
  - `nimbus_sends_total{status,store}` (counter)
  - `nimbus_send_duration_seconds` (histogram)
  - `nimbus_send_retry_total` (counter)
  - `nimbus_queue_depth{queue,state}` (gauge)
  - `nimbus_whatsapp_sessions{status}` (gauge)
  - `nimbus_worker_heartbeat_age_seconds` (gauge)
  - `nimbus_catalog_products{store}` (gauge)
  - `nimbus_catalog_scrape_runs_total{status}` (counter)
- **Sentry skeleton** — `sentry.js`. Captura `unhandledRejection`, `uncaughtException`, falhas terminais de jobs. No-op sem `SENTRY_DSN`.
- **DLQ** — jobs falhos ficam até `removeOnFail.count: 500`. Endpoints admin: `GET /api/admin/queue/failed`, `POST /api/admin/queue/failed/:id/retry`, `DELETE /api/admin/queue/failed/:id`.
- **Heartbeat do worker** — escreve em `nimbus:worker:heartbeat` (Redis, TTL 60s) a cada 5s. Server checa em `/healthz` — se >30s, marca worker como morto e devolve 503.
- **Logs estruturados pino** — `scheduler.js`, `queue.js` migrados pra `logger.child({module})` com campos `userId`, `groupId`, `waGroup`, `jid`, `item`. Pronto pra ingestion em Datadog/Loki/CloudWatch.

**Pendente (não-bloqueante):**
- ⏸️ Dashboards Grafana — quando o produto pedir; Prometheus já tá pronto pra alimentar
- ⏸️ Alertas — quando o produto pedir; pode ser Alertmanager (Prom) ou Sentry rules
- ⏸️ Testes — não foram feitos. Acoplamento baixo facilita adicionar quando necessário.

---

## Capacidade hoje

| Métrica | Antes (2026-05-10) | Agora (2026-05-11) |
|---|---|---|
| Usuários simultâneos | ~50 (chutão) | **centenas** (Postgres + queue) |
| Sessões WhatsApp/processo | ~100-300 | **mesmo teto**, mas restart sem perda + sharding viável |
| Crash de processo | perde mensagens em-vôo | **zero perda** (BullMQ persiste) |
| Restart do server | derruba tudo | **só HTTP** — worker + Baileys continuam |
| Crash de SSD | perde tudo | **backup local 15min + remoto 1h** (quando S3 envs setadas) |
| Visibilidade | telefone do cliente | `/healthz` + `/metrics` + Sentry + logs estruturados |

---

## Próximos passos (em ordem de retorno)

### Tier 1 — Operacional, fechar loops abertos (1-2 dias somados)

1. **Sentry**: criar conta em sentry.io (free tier 5k erros/mês), pegar DSN, colar em `.env`. **Imediato**: passa a ver erros antes do cliente avisar.
2. **Backup remoto**: criar bucket no Backblaze B2 (10GB grátis, melhor custo) ou Cloudflare R2 (10GB grátis), colar 5 envs `BACKUP_S3_*`. **Imediato**: protege contra crash de SSD.
3. **Validar auth-pg em uso real** alguns dias. Quando confiar, mover `auth_states/` pra `auth_states.bak/` (não deletar imediatamente).

### Tier 2 — Quando volume justificar (1-2 semanas cada)

4. **Phase 2.2 — sticky routing**: ao passar de ~50 sessões, shardar entre múltiplos workers. Tabela `session_routes`, re-eleição automática.
5. **Dashboards Grafana**: 1 dashboard de produto (envios/dia, ofertas no catálogo, taxa de aprovação), 1 de infra (latência, queue depth, sessões).
6. **Alertas Alertmanager**: sessão WhatsApp caída >5min, scraper sem run há >2h, fila empilhando >100, worker heartbeat >60s, taxa de erro >1%.

### Tier 3 — Decisões de produto (não-técnicas)

7. **Avaliar WhatsApp Cloud API** quando o modelo de negócio aguentar ~$0.005-0.08/mensagem. Resolveria de vez o risco de banimento Baileys e simplificaria muito a stack (remove auth state, remove sticky routing, remove restoreSessions, remove worker dedicado em parte). Caminho não-trivial: reescrever `whatsapp-local.js` mantendo a interface.

8. **Multi-tenant real** com isolation: tenant_id em todas as tabelas, row-level security no Postgres, quotas por usuário (envios/dia, sessões max). Hoje os usuários são separados só por `userId` em coluna — funciona mas não impede SQL malicioso.

### Tier 4 — Qualidade de código (paralelo, quando incomodar)

9. **Testes integração** nas rotas críticas (auth, manual-add, send-now, queue/failed)
10. **Testes unit** em cooldown/janela/productKey/refillQueue
11. **TypeScript** no backend (frontend já usa JSDoc parcial)

---

## Arquivos relevantes

```
backend/
├── server.js                    HTTP API (producer)
├── worker.js                    Processo separado (Baileys + queue consumers)
├── scheduler.js                 Tick + processSendJob (handler)
├── queue.js                     Facade memory/redis (BullMQ)
├── storage.js → storage-{json,pg}.js              Persistência usuário/grupos
├── catalog.js → catalog-{json,pg}.js              Catálogo global
├── auth.js → auth-{json,pg}.js                    Auth (JWT + bcrypt)
├── app-config.js → app-config-{json,pg}.js        KV de configs
├── whatsapp.js → whatsapp-{local,proxy}.js        Facade Baileys local/RPC
├── baileys-auth-pg.js           Adapter useDatabaseAuthState
├── session-status.js            Cache Redis de status das sessões
├── worker-heartbeat.js          Heartbeat worker→Redis, server lê
├── product-key.js               Hash MD5 estável (deduplicado)
├── metrics.js                   Prometheus client
├── sentry.js                    Sentry skeleton (no-op sem DSN)
├── logger.js                    pino estruturado
├── db.js                        Prisma singleton
├── prisma/schema.prisma         12 modelos
├── ecosystem.config.js          PM2: server + worker + 2 backups
├── scripts/
│   ├── backup-data.js           Local (cron 15min)
│   ├── backup-remote.js         S3-compatível (cron 1h)
│   ├── migrate-json-to-pg.js    Migra dados JSON→PG
│   └── migrate-auth-to-pg.js    Migra auth_states/→PG

docker-compose.yml               Postgres 16 + Redis 7
start.bat                        Sobe 3-4 terminais conforme QUEUE_BACKEND
```

---

## Resumo dos rollbacks

Cada fase tem um botão de pânico. Documentado pra reduzir risco operacional.

| Fase | Como reverter |
|---|---|
| 1 — Postgres | `STORAGE_BACKEND=json` no env. Dados antigos ainda em `backend/data/`. App volta a ler do disco. |
| 2 — Queue Redis | `QUEUE_BACKEND=memory` no env. Scheduler volta a enviar inline. Jobs em-vôo no Redis ficam órfãos (drenar antes em prod). |
| 2.1 — Worker process | `QUEUE_BACKEND=memory` (engloba o de cima). Server faz tudo no mesmo processo. |
| 3 — Auth Baileys PG | `STORAGE_BACKEND=json` (engloba). OU manter PG mas deletar adapter — voltar pra `useMultiFileAuthState`. |
| 4 — Observabilidade | `SENTRY_DSN=` vazio (no-op). `/metrics` é endpoint inofensivo, deixar ligado. |

Tudo é feature flag. Nenhuma migration destrutiva. Postgres não foi normalizado a ponto de não dar pra exportar de volta pra JSON se necessário (`payload jsonb` preserva os campos originais).
