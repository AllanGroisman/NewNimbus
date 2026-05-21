# Nimbus

Plataforma de automação de ofertas no WhatsApp. Faz scraping de produtos (Mercado Livre, Amazon), organiza campanhas por categoria e dispara mensagens em grupos no horário que você quiser.

## Pastas principais

- **`backend/`** — servidor Node.js (Express). Onde fica toda a lógica: login, scraping, scheduler, envio pelo WhatsApp.
- **`frontend/`** — site React que o usuário usa. Conecta no backend pela rota `/api`.
- **`tests/`** — bateria automatizada de testes (Vitest). Roda com `test.bat`.
- **`docs/`** — documentos do projeto (arquitetura, plano, status). Não tem código aqui.
- **`start.bat` / `stop.bat`** — sobem e param tudo (backend, frontend, ngrok) em janelas separadas no Windows.
- **`test.bat`** — atalho pra rodar a bateria de testes.
- **`docker-compose.yml`** — sobe Postgres + Redis em containers locais. **Obrigatório**: Postgres é o storage primário (Prisma) e Redis é usado em modo `QUEUE_BACKEND=redis` (padrão do `start.bat`).

## Por onde começar

1. Leia `CLAUDE.md` na raiz — é o "mapa" técnico do projeto.
2. Pra entender a estrutura interna do backend, leia `backend/README.md`.
3. Pra rodar tudo localmente, dê `start.bat`.

## Documentação extra

Veja `docs/` pra documentos de arquitetura, plano de escala e status do projeto.

## Testes automatizados

O projeto tem **~286 testes** divididos em três camadas. Rodam com `test.bat` (backend + frontend) ou individualmente. Detalhes técnicos em `CLAUDE.md`.

### Backend — unitários (`tests/unit/`)

Testam funções isoladas, sem subir servidor.

- **`affiliate-asin.test.js`** — extração de ASIN da Amazon a partir de URLs variadas (link curto, link com parâmetros, etc).
- **`affiliate-shopee.test.js`** — parsing de links da Shopee e montagem do link de afiliado.
- **`billing-limits.test.js`** — limites de cada plano (free/basic/pro/business): números, grupos, categorias por grupo, auto-scraping.
- **`product-key.test.js`** — geração da chave única de produto (hash MLB ou fallback por URL) que evita duplicar ofertas no catálogo.
- **`scraper-shopee.test.js`** — parser do HTML da Shopee, extração de preço, desconto, imagem.

### Backend — integração (`tests/integration/`)

Sobem o backend inteiro em memória (com WhatsApp e Stripe mockados) e batem nas rotas via HTTP.

- **`auth.test.js`** — cadastro, login, `/me`, troca de senha, promoção pra admin via `ADMIN_EMAILS`.
- **`state.test.js`** — race condition entre scheduler e auto-save do frontend (`OPS_FIELDS`).
- **`catalog.test.js`** — upsert no catálogo, filtros, paginação, endpoints `/api/ofertas` e `/api/admin/catalog`.
- **`affiliate.test.js`** — geração de link de afiliado pros 3 marketplaces, cache de 7 dias, expiração.
- **`scheduler.test.js`** — tick do scheduler: refill, manual add, send next, casos sem afiliado/sem janela/sem grupo.
- **`manual-ops.test.js`** — ações manuais via HTTP (refill, add, approve/reject pending, clear history) com isolamento entre usuários.
- **`admin.test.js`** — CRUD de usuários, troca de role, config do scraper, admin do catálogo, DLQ.
- **`whatsapp.test.js`** — sessões, listagem de grupos, envio direto, broadcast, convite; gating de número novo por plano (402).
- **`billing.test.js`** — trial automático, checkout, portal, webhooks do Stripe (todos os eventos relevantes), idempotência, assinatura órfã, gating por plano com bypass de admin.
- **`health-metrics.test.js`** — `/healthz` (status dos componentes) e `/metrics` (formato Prometheus, incremento de counters).
- **`redis-queue.test.js`** — fila BullMQ real (precisa de `RUN_REDIS_TESTS=1`): enqueue, retry exponencial, RPC de control, status counts, DLQ.

### Backend — jornada (`tests/journey/`)

- **`full-journey.test.js`** — simula um usuário do zero: cadastra, configura número, cria grupo, scheduler envia ofertas. Não trunca o banco entre etapas.

### Frontend (`frontend/src/__tests__/`)

Vitest + React Testing Library + jsdom.

- **`api.test.js`** — helper `http()`: injeta `Authorization`, trata 401 (limpa token + dispara evento), trata 402 (limite de plano).
- **`constants.test.js`** — helpers de `data/constants.js` (categorias, `groupUsesML`, etc).
- **`Subscription.test.jsx`** — tela de Assinatura: status do trial, botão de checkout, bypass de admin, mensagem quando Stripe desabilitado.
- **`GroupDashboard.test.jsx`** — dashboard do grupo: botão pausar/retomar visível em qualquer aba, banner quando falta afiliado ML.

### E2E (`tests/e2e/`)

Playwright + Chromium. Sobe backend (3101) e frontend (5273) dedicados contra um Postgres isolado (`nimbus_test_e2e`).

- **`auth-flow.spec.js`** — registro de novo usuário, login inválido, logout, navegação pra tela de assinatura já com trial ativo.
- **`billing-page.spec.js`** — fluxo da tela de billing visto do navegador real.

