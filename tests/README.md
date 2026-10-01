# tests/

Bateria automatizada de testes do Nimbus — três camadas, **~2500 testes** no total (backend + frontend).

- **Backend** (este diretório): unit + integration + journey, Vitest 2.x + supertest, ~1886 testes, **~85s**. Sobe o backend em memória (sem bindar porta) com WhatsApp, Stripe e mailer mockados.
- **Frontend** (`frontend/`): Vitest + React Testing Library + happy-dom, 619 testes, ~58s. Roda no diretório `frontend/`.
- **E2E** (`tests/e2e/`): Playwright + Chromium, 44 testes. Sobe backend (3101) + frontend (5273) dedicados contra um Postgres isolado (`nimbus_test_e2e`).

**Tempo por arquivo e o mapa "mudei X → rode Y": [TIMING.md](TIMING.md).** Use
ele pra não rodar a suíte inteira a cada implementação.

**CI**: `.github/workflows/tests.yml` roda backend + frontend a cada push/PR no GitHub; o E2E roda no agendamento noturno ou manualmente pela aba Actions.

**Assinatura nos testes**: conta nova nasce no plano **free (0 campanhas / 0 números)** — salvar campanha sem assinatura leva **402**. Use `createTestUser({ plan: "pro" })` (ou `"basic"`/`"business"`) pra criar o usuário já com assinatura ativa; sem a opção, o usuário fica free (útil pros testes de gating).

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
npm test                          # tudo (~85s)
npm run test:unit                 # só unitários, SEM banco (~17s)
npm run test:db                   # integração + jornada (~60s)
npm run test:integration          # só integração
npm run test:journey              # só jornada
npm run test:repasse              # atalhos por área — ver TIMING.md
RUN_REDIS_TESTS=1 npm run test:db # inclui redis-queue (BullMQ real)
npm run test:e2e                  # Playwright (auto-sobe servers)
npx playwright test --project=mobile  # só o celular (360px, toque) — rode antes o test:e2e:setup
npm run test:watch                # watch mode (unitários)
npm run test:timing               # remede o tempo de cada arquivo

# Frontend (RTL + happy-dom)
cd frontend
npm test                          # ~58s
```

**Pré-requisito**: `docker compose up -d` (Postgres + Redis). O DB `nimbus_test` precisa existir uma vez (`docker exec nimbus-postgres psql -U nimbus -c "CREATE DATABASE nimbus_test OWNER nimbus"`); `nimbus_test_e2e` é criado pelo globalSetup do Playwright.

## Estrutura

### `unit/` — funções puras (sem banco e sem IO de rede)

Rodam em paralelo e **não conectam no Postgres** — é o que mantém essa camada em
~14s. Teste que precisa de banco pertence a `integration/`. Foi o caso dos
quatro `affiliate-*.test.js`, que gravam o cache de link no Postgres e por isso
moram lá.
- `billing-limits.test.js` — limites de cada plano (free/basic/pro/business): números, grupos, categorias por grupo; `effectivePlanId` e admin bypass.
- `coupon-price.test.js` — `precoComCupom` (preço com o desconto do cupom do ML): percentual/fixo, teto, compra mínima, validade, e todos os casos em que o cupom não vale e o preço normal é a resposta.
- `notify-state-alert.test.js` — `stateAlert` (grace period, aviso de queda/volta, anti-spam).
- `product-key.test.js` — geração da chave única de produto (hash MLB ou fallback por URL).
- `repasse-extract.test.js` — extração de URLs das mensagens (wrappers do Baileys, dedupe) e serialização por usuário.
- `scheduler-core.test.js` — janelas de horário (`inWindow`/`activeWindow`), `cooldownMinutes`, `renderTemplate` (inclusive o fallback do `{preco_com_cupom}`), `isAutoApprove`/`isRepasse`, `batchSize`/`autoRefillDue`.
- `scraper-filters.test.js` — filtros ML/Amazon/Shopee (read/write, clamps), `buildAmazonDealsUrl`, backoff da Amazon.
- `scraper-live.test.js` — **opt-in** (`RUN_LIVE_SCRAPE=1`): scrape real de ML/Amazon com Puppeteer.
- `scraper-ml-card.test.js` — parsers de card do ML (reviews, vendidos, rating, reconciliação de preço).
- `scraper-shopee.test.js` — parser de produtos da Shopee, extração de preço/desconto/imagem.
- `scrap-tester.test.js` — verificador periódico de saúde do scraper (cobertura por campo, thresholds).
- `store-locks.test.js` — trava de loja pelo admin + efeito no `scheduler.activeSources`.
- `whatsapp-close.test.js` — `classifyClose` (motivos de desconexão do Baileys) e `isStuckReconnecting`.

### `integration/` — backend rodando, batendo nas rotas via supertest
- `auth.test.js` — register/login/me/PATCH/password/admin gating via ADMIN_EMAILS.
- `state.test.js` — race condition scheduler ↔ auto-save do frontend (`OPS_FIELDS`).
- `catalog.test.js` — upsert no catálogo, filtros, paginação, `/api/ofertas`, `/api/admin/catalog`.
- `affiliate.test.js` — geração de link pros 3 marketplaces, cache de 7 dias, expiração.
- `affiliate-asin.test.js` — extração de ASIN da Amazon a partir de URLs variadas.
- `affiliate-ml.test.js` — `gerarLinkAfiliadoML` com fetch mockado: headers/body, cache de 7 dias, modos de falha.
- `affiliate-ml-session.test.js` — sessão/cookie do afiliado ML.
- `affiliate-shopee.test.js` — assinatura HMAC da Shopee + payloads GraphQL + link de afiliado.
- `scheduler.test.js` — tick do scheduler: refill, manual add, send next, edge cases.
- `manual-ops.test.js` — refill/manual-add (force/409/202 cooldown)/pending approve+reject/history clear, isolamento entre users.
- `admin.test.js` — CRUD de usuários + role, scraper config/run/status, catalog admin, DLQ.
- `whatsapp.test.js` — sessões, listagem de grupos, envio, broadcast, invite; plan-gating de número novo (402).
- `billing.test.js` — conta nova sem trial, `/me`, checkout, portal, trial de R$1, webhooks Stripe (todos os eventos relevantes), idempotência, sub órfã, plan-gating com admin bypass.
- `health-metrics.test.js` — `/healthz` (status dos componentes) e `/metrics` (formato Prometheus, incremento de counters).
- `store-locks.test.js` — gating admin da trava de loja, bloqueio de credenciais, campanha pulando loja trancada.
- `repasse-capture.test.js` — captura de link do grupo líder → pending/fila, dedupe, lojas sem afiliado/não suportadas.
- `scraper-shopee-flow.test.js` — fluxo `scrapeShopee` com fetch mockado (paginação, categorias, minDiscount).
- `redis-queue.test.js` — fila BullMQ real (**opt-in**: só roda com `RUN_REDIS_TESTS=1`): enqueue, retry exponencial, RPC de control, status counts, DLQ. É opt-in porque bate num broker real e é sensível a timing (race de cold-start do marker do BullMQ + backoff de 5s no retry) → flaky de forma não-determinística, **não por bug de produto**. Fora do gate padrão pra manter `npm test` determinístico.

### `journey/` — fluxo end-to-end de um usuário
- `full-journey.test.js` — registro → afiliado → catálogo → campanha → refill → envio → reset. Persiste estado entre testes (`globalThis.__NIMBUS_SKIP_TRUNCATE_BETWEEN_TESTS`).

### `e2e/` — browser real (Playwright)
- `auth.spec.js` — cadastro (confirmação de email), login inválido, login admin, logout, recuperar senha.
- `dashboard.spec.js` — visão geral, navegação pelo sidebar, persistência da página no F5.
- `campaign.spec.js` — criar/abrir/excluir campanha, navegar abas.
- `affiliate.spec.js` — salvar/apagar credenciais ML/Amazon/Shopee.
- `settings.spec.js` — tema, nome da conta, seção Segurança.
- `billing.spec.js` — planos renderizam, Stripe desabilitado.
- `whatsapp.spec.js` — modal de adicionar número inicia o QR.
- `admin-scraper.spec.js`, `admin-shopee-filters.spec.js`, `admin-misc.spec.js` — telas de admin.
- `mobile.spec.js` — projeto `mobile` (Pixel 7 a 360px, com toque): nenhuma rota nem aba de campanha pode rolar de lado, todo input tem fonte ≥ 16px (senão o iPhone dá zoom ao focar), ☰ à esquerda com a gaveta do mesmo lado, modal no toque sem focar campo. Screenshots de cada tela ficam em `test-results/`. Cria o próprio admin (não depende do `DEFAULT_ADMIN_*`).
- `global-setup.js` — cria/migra o DB `nimbus_test_e2e` (docker exec local; psql direto no CI).

### `helpers/` — utilitários
- `env.js` — seta `NODE_ENV=test`, define `JWT_SECRET` e aponta `DATABASE_URL` pro banco do worker (`nimbus_test_<VITEST_POOL_ID>`, ou `nimbus_test` fora do vitest). **Importar primeiro** em qualquer teste.
- `env-redis.js` — variante com `QUEUE_BACKEND=redis` pra `redis-queue.test.js`.
- `app.js` — helper único que importa o backend já configurado pra teste (com mocks de WA + Stripe instalados).
- `app-redis.js` — variante que monta o app com fila Redis real. Expõe `cleanQueues()` (limpeza entre testes via API do BullMQ — drain/clean) em vez de `flushdb`, que apagaria os markers internos do BullMQ embaixo dos workers vivos e travaria o consumo de jobs. `flushRedis` (flushdb bruto) só é usado no baseline do `setupQueue`, antes de qualquer worker existir.
- `wa-mock.js` — mock no lugar de `backend/whatsapp/index.js`. Toda chamada de envio fica em `calls[]` pra os testes inspecionarem. `listSessions` espelha o contrato real (`{ numberId, status, info, lastError }`). Exporta `connect(userId, numberId)` (re-exportado como `waConnect` em `app.js`): marca uma sessão como `status:"connected"` — **necessário** pra qualquer teste de envio, porque o `whatsappGate` (`scheduler.js:152`) só deixa enviar quando algum número vinculado está conectado. `startSession` deixa a sessão em `"open"` (iniciada mas não conectada).
- `stripe-mock.js` — mock no lugar de `backend/billing/stripe.js`. URL fake, eventos sintéticos.
- `mailer-mock.js` — mock no lugar de `backend/auth/mailer.js`. Sem ele o register/reset dispara o SMTP **real** e bate na cota horária. O token de verificação continua sendo gravado no DB, então `createTestUser` (que lê o token direto do banco) segue funcionando.
- `pg-helpers.js` — `truncateAll()` antes de cada teste (via `DELETE` com FK triggers desligadas — `TRUNCATE` custava 4,3s por chamada; ver TIMING.md), com a lista de tabelas lida do próprio banco, `seedSubscription(userId, planId)` (assinatura ativa direto no DB — é o que `createTestUser({ plan })` usa) e helpers de seed.
- `setup-each.js` — `beforeEach` de integration/journey (reset de mocks + limpeza do banco).
- `setup-unit.js` — `beforeEach` dos unitários: só reseta mocks, **não toca no banco**.
- `global-setup.js` — roda 1× antes de integration/journey: aplica as migrations no molde `nimbus_test` (pulando quando já está em dia) e garante os bancos-worker `nimbus_test_1..N` que permitem rodar os arquivos em paralelo.
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
