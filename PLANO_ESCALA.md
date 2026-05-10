# Plano de evolução para escala — Nimbus

Documento gerado em 2026-05-10.

## Diagnóstico atual

A arquitetura atual funciona bem para dezenas de usuários (beta fechado), mas
tem decisões que quebram em larga escala:

- **Persistência em arquivos JSON** — cada save reescreve o arquivo inteiro,
  sem índices, sem backup nativo. Catálogo é um único arquivo carregado
  inteiro a cada query.
- **Processo único** — API, scheduler, scraper (Puppeteer) e sessões WhatsApp
  (Baileys) rodam no mesmo processo Node. Restart derruba tudo. O mutex em
  memória (`storage.js:27`) impede subir múltiplas instâncias sem corromper
  estado.
- **`fs.writeFileSync` síncrono** bloqueia o event loop sob carga.
- **Scheduler O(N usuários × grupos)** a cada 30s, em série. Com 1000 usuários
  estoura o tick e ticks são silenciosamente pulados (flag `_running`).
- **Baileys em processo único** — ~100-300 sessões por processo é o teto
  realista. Risco adicional de banimento (não é API oficial).
- **Sem observabilidade**: zero métricas, sem health check real, logs em
  `console.log` sem rotação.
- **Sem rate limiting**, CORS aberto, sem testes.
- **`productKey` duplicada** em `scheduler.js` e `catalog.js` — bomba-relógio.

---

## Fase 0 — Hardening (3-5 dias, sem mudar arquitetura)

Reduz risco hoje sem reescrever nada. Aguenta com tranquilidade ~50-100
usuários ativos.

- **Rate limit** em `/api/auth/login`, `/api/auth/register`
  (`express-rate-limit`, 10 req/min/IP).
- **CORS allowlist** no lugar de `cors()` aberto (`server.js:15`).
- **Helmet** (`app.use(helmet())`).
- **Backup automático** de `backend/data/` — cron 15min, retenção 7 dias,
  espelho em S3/B2.
- **PM2** com `--max-memory-restart 1G` e logs rotacionados.
- **Health check real** `/healthz`: valida acesso a disco + status do
  scheduler + sessões ativas.
- **Sentry** (ou similar) pra `unhandledRejection`/`uncaughtException`.
- **`fs.writeFileSync` → `fs.promises.writeFile`** em `storage.js`,
  `catalog.js`, `affiliate.js`, `admin-scraper.js`.

---

## Fase 1 — Postgres no lugar de JSON (1-2 semanas)

Passo que destrava tudo. Sem ele, nada de horizontal scaling.

### Modelagem mínima

```
users(id, email, name, phone, password_hash, role, created_at)
user_state(user_id PK, settings jsonb, updated_at)
groups(id, user_id FK, name, schedule jsonb, scraping jsonb,
       categories jsonb, message_template, paused, ...)
group_history(id, group_id FK, product_key, name, link, sent_at, ...)
       -- index (group_id, sent_at)
group_queue(id, group_id FK, position, payload jsonb)
group_pending(id, group_id FK, payload jsonb)
whatsapp_groups(id, user_id FK, jid, number_id, name, ...)
numbers(id, user_id FK, ...)
catalog(key PK, name, link, img, price, original_price, discount,
        store, category, rating, sold, first_seen_at, last_seen_at,
        payload jsonb)
       -- indexes: (category, discount DESC), (store), (last_seen_at)
affiliate_config(scope PK, payload jsonb)
```

### Estratégia sem reescrever rotas

- Manter `storage.js`/`catalog.js` como interface (`loadState`, `saveState`,
  `query`, etc.) e trocar a implementação interna.
- Script one-shot que lê `data/state/*.json` + `data/catalog.json` e popula
  o Postgres.
- Feature flag `STORAGE_BACKEND=json|pg` pra rollback rápido nos primeiros
  dias.

### Ganhos imediatos

- `OPS_FIELDS` deixa de existir como hack — queue/history/pending viram
  tabelas. Frontend e scheduler escrevem em colunas diferentes, sem
  conflito.
- Scheduler tick deixa de ler arquivos: `SELECT g.* FROM groups WHERE NOT
  paused AND <janela ativa>`. O(N) vira O(grupos ativos *na janela*), com
  índice.
- Catálogo deixa de ser carregado inteiro: `query()` vira SQL com índices.
  Suporta milhões de produtos.
- Backup, replicação, point-in-time recovery: grátis com Postgres
  gerenciado (Neon, Supabase, RDS).
- Pode subir 2+ instâncias do backend atrás de um LB sem corromper estado.

---

## Fase 2 — Scheduler em workers + fila (Redis + BullMQ, ~1 semana)

`scheduler.js` deixa de ser loop monolítico:

- **Producer** (1 processo, leve): a cada 30s consulta no Postgres "que
  envios estão devidos agora" e enfileira jobs em BullMQ — 1 job =
  `(userId, groupId, productKey)`.
- **Workers de envio** (N processos, escaláveis): consomem da fila, fazem
  o envio Baileys, escrevem `group_history`. Retry automático,
  dead-letter queue.
- **Workers de refill** (separado): job `refill_queue` acionado quando
  `group_queue.len < 5`.

Ganhos: adiciona workers conforme volume cresce, sem tocar no producer.
Falha de um worker não derruba o sistema. Métricas grátis (BullMQ tem
dashboard).

---

## Fase 3 — Isolar Baileys (~2 semanas)

Ponto mais difícil — sessão WhatsApp é stateful (websocket vivo).

### Caminho A — manter Baileys, distribuir

- Auth state em Postgres (substituir `useMultiFileAuthState` por adapter
  Postgres — implementações abertas existem).
- "WhatsApp workers" dedicados (processos separados, 1 worker = ~50-100
  sessões).
- **Sticky routing**: tabela `session_routes(session_id PK, worker_id,
  last_heartbeat)` em Redis. API/jobs enviam pra `worker_id` correto.
  Workers fazem heartbeat; se cai, outro worker assume (re-login
  automático).
- Scraper sai do processo principal pra container separado (Puppeteer
  não pode dividir RAM com sessões Baileys).

### Caminho B — WhatsApp Cloud API oficial

- Decisão de produto, não técnica. Resolve banimento, escalabilidade,
  multi-tenant. Custo: ~$0.005-0.08 por mensagem (varia por país/tipo).
  Para SaaS pago, costuma compensar.
- Reescreve `whatsapp.js` (interface fica igual: `sendText`, `sendImage`).
  Remove toda a complexidade de sessão/QR.

**Recomendação**: avaliar B antes de investir em A. Se o modelo de
negócio aguenta o custo por mensagem, pula a complexidade toda.

---

## Fase 4 — Observabilidade e operação (paralelo)

- **Logs estruturados**: `pino` no lugar de `console.log`, com
  `userId`/`groupId`/`requestId`.
- **Métricas Prometheus**: requests/s, latência p95, jobs na fila,
  sessões ativas, taxa de envio, falhas Baileys.
- **Dashboards Grafana**: 1 pra produto (envios/dia, ofertas no catálogo),
  1 pra infra.
- **Alertas**: sessão WhatsApp caída >5min, scraper sem run há >2h, fila
  BullMQ empilhando, taxa de erro >1%.
- **Testes**: integração nas rotas críticas (auth, manual-add, send-now),
  unit nos cálculos de cooldown/janela.

---

## Resumo: ordem e justificativa

| Fase | Esforço | Desbloqueia |
|---|---|---|
| 0 — Hardening | 3-5 dias | Aguenta beta com segurança |
| 1 — Postgres | 1-2 sem | Multi-instance + remove hack OPS_FIELDS |
| 2 — Workers + fila | 1 sem | Scheduler horizontal |
| 3 — Baileys isolado / Cloud API | 2 sem | WhatsApp escala |
| 4 — Observabilidade | paralelo | Operar em produção sem rezar |

**Caminho realista para "ir ao ar em larga escala em 2-3 meses"**:
Fase 0 → Fase 1 → avaliar Cloud API. Fases 2 e 3A só fazem sentido se
for ficar com Baileys.
