# tests/

Bateria automatizada de testes do Nimbus — três camadas, **~287 testes** no total.

- **Backend** (este diretório): unit + integration + journey, Vitest 2.x + supertest, ~222 testes, ~100s. Sobe o backend em memória (sem bindar porta) com WhatsApp e Stripe mockados.
- **Frontend** (`frontend/`): Vitest + React Testing Library + jsdom, 59 testes, ~4s. Roda no diretório `frontend/`.
- **E2E** (`tests/e2e/`): Playwright + Chromium, 5 testes, ~12s. Sobe backend (3101) + frontend (5273) dedicados contra um Postgres isolado (`nimbus_test_e2e`).

## Como rodar

Da raiz do projeto:

```bat
windows\test.bat
```

Roda backend + frontend (não inclui E2E). Veja `CLAUDE.md` na raiz pra detalhes técnicos.

Manualmente:

```bash
# Backend (deste diretório)
cd tests
npm install                       # primeira vez
npm test                          # tudo (~100s)
npm run test:unit                 # só unitários
npm run test:integration          # só integração
npm run test:journey              # só jornada
RUN_REDIS_TESTS=1 npm test        # inclui redis-queue (BullMQ real)
npm run test:e2e                  # Playwright (auto-sobe servers)
npm run test:watch                # watch mode

# Frontend (RTL + jsdom)
cd frontend
npm test                          # ~4s
```

**Pré-requisito**: `docker compose up -d` (Postgres + Redis). O DB `nimbus_test` precisa existir uma vez (`docker exec nimbus-postgres psql -U nimbus -c "CREATE DATABASE nimbus_test OWNER nimbus"`); `nimbus_test_e2e` é criado pelo globalSetup do Playwright.

## Estrutura

### `unit/` — funções puras (sem IO)
- `affiliate-asin.test.js` — extração de ASIN da Amazon a partir de URLs variadas.
- `affiliate-shopee.test.js` — parsing de links da Shopee + montagem do link de afiliado.
- `billing-limits.test.js` — limites de cada plano (free/basic/pro/business): números, grupos, categorias por grupo, auto-scraping.
- `product-key.test.js` — geração da chave única de produto (hash MLB ou fallback por URL).
- `scraper-shopee.test.js` — parser de produtos da Shopee, extração de preço/desconto/imagem.

### `integration/` — backend rodando, batendo nas rotas via supertest
- `auth.test.js` — register/login/me/PATCH/password/admin gating via ADMIN_EMAILS.
- `state.test.js` — race condition scheduler ↔ auto-save do frontend (`OPS_FIELDS`).
- `catalog.test.js` — upsert no catálogo, filtros, paginação, `/api/ofertas`, `/api/admin/catalog`.
- `affiliate.test.js` — geração de link pros 3 marketplaces, cache de 7 dias, expiração.
- `scheduler.test.js` — tick do scheduler: refill, manual add, send next, edge cases.
- `manual-ops.test.js` — refill/manual-add (force/409/202 cooldown)/pending approve+reject/history clear, isolamento entre users.
- `admin.test.js` — CRUD de usuários + role, scraper config/run/status, catalog admin, DLQ.
- `whatsapp.test.js` — sessões, listagem de grupos, envio, broadcast, invite; plan-gating de número novo (402).
- `billing.test.js` — trial automático, `/me`, checkout, portal, webhooks Stripe (todos os eventos relevantes), idempotência, sub órfã, plan-gating com admin bypass.
- `health-metrics.test.js` — `/healthz` (status dos componentes) e `/metrics` (formato Prometheus, incremento de counters).
- `redis-queue.test.js` — fila BullMQ real (exige `RUN_REDIS_TESTS=1`): enqueue, retry exponencial, RPC de control, status counts, DLQ.

### `journey/` — fluxo end-to-end de um usuário
- `full-journey.test.js` — registro → afiliado → catálogo → campanha → refill → envio → reset. Persiste estado entre testes (`globalThis.__NIMBUS_SKIP_TRUNCATE_BETWEEN_TESTS`).

### `e2e/` — browser real (Playwright)
- `auth-flow.spec.js` — registro novo, login inválido, logout, navegação pra Assinatura.
- `billing-page.spec.js` — tela de billing vista do navegador (trial Pro, Stripe desabilitado mostra banner).
- `global-setup.js` — sobe backend (3101) + frontend (5273) com DB `nimbus_test_e2e`.

### `helpers/` — utilitários
- `env.js` — seta `NODE_ENV=test`, aponta `DATABASE_URL` pra `nimbus_test`, define `JWT_SECRET`. **Importar primeiro** em qualquer teste.
- `env-redis.js` — variante com `QUEUE_BACKEND=redis` pra `redis-queue.test.js`.
- `app.js` — helper único que importa o backend já configurado pra teste (com mocks de WA + Stripe instalados).
- `app-redis.js` — variante que monta o app com fila Redis real.
- `wa-mock.js` — mock no lugar de `backend/whatsapp/index.js`. Toda chamada de envio fica em `calls[]` pra os testes inspecionarem.
- `stripe-mock.js` — mock no lugar de `backend/billing/stripe.js`. URL fake, eventos sintéticos.
- `pg-helpers.js` — `truncateAll()` antes de cada teste, helpers de seed.
- `setup-each.js` — `beforeEach` global (reset de mocks, truncate).
- `global-setup.js` — `beforeAll` global (warmup do appConfig).
- `fixtures.js` — geradores de objetos de teste (produto, grupo, etc).

## O que NÃO está coberto

- Scraping real (Puppeteer abrindo browser).
- WhatsApp real (Baileys conectando).
- Stripe real (cobrança); apenas o mock + webhooks sintéticos.

## Mudanças no backend que sustentam os testes

(importantes ao mexer no código)

- `server.js` exporta `{ app, boot }` e só chama `boot()` quando `require.main === module` — supertest carrega o app sem bindar porta.
- Rate limiters viram no-op quando `NODE_ENV === "test"`.
- `storage/pg.js` coerce `avgDiscount` (coluna `String`) pra `Number` quando numérico.
- Mocks em `helpers/wa-mock.js` e `helpers/stripe-mock.js` patcheiam `require.cache` antes de `server.js` carregar.

## Dica pra iniciante

Se algo quebrar depois de mexer no backend, rode `windows\test.bat` antes de subir — é a melhor rede de proteção. Problemas comuns:

- **"connection refused" no PG**: `docker compose up -d` esquecido.
- **DB `nimbus_test` não existe**: rode o `CREATE DATABASE` listado acima uma vez.
- **Teste flakey de WhatsApp**: o mock não foi resetado entre testes (deve ser chamado em `beforeEach`).
- **redis-queue.test.js pulado**: precisa `RUN_REDIS_TESTS=1` + Redis up.
