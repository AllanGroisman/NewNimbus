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

Lint do frontend (não há lint no backend, não há suíte de testes):

```bash
cd frontend && npm run lint
```

Build de produção do frontend:

```bash
cd frontend && npm run build
```

Variáveis de ambiente relevantes (lidas pelo backend):

- `JWT_SECRET` — sobrescreve o segredo persistido em `backend/data/.jwt_secret`.
- `ADMIN_EMAILS` — emails (separados por vírgula) que recebem `role=admin` automaticamente no login. `start.bat` já define `allangroisman@gmail.com`.
- `ML_AFFILIATE_TAG` / `ML_AFFILIATE_COOKIE` — sobrescrevem a config de afiliado ML salva no servidor (precedência sobre `data/affiliate.json`).
- `PORT` — porta do backend (default 3001).

## Arquitetura

### Camadas

- **Frontend** (`frontend/src/`): SPA React 19 com Vite. Sem TypeScript, sem framework de CSS — estilos inline + CSS variables para tema claro/escuro. Sem axios — usa `fetch` nativo.
- **Backend** (`backend/`): Express 5 (`server.js`) é só roteamento — toda lógica fica em módulos: `auth.js`, `storage.js`, `scheduler.js`, `whatsapp.js`, `scraper.js`, `affiliate.js`, `catalog.js`, `admin-scraper.js`.
- **Persistência**: arquivos JSON em `backend/data/` (gitignored). Não há banco. Os credenciais Baileys ficam em `backend/auth_states/<numberId>/` (também gitignored).

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

**6. WhatsApp (Baileys).** Sessões em `backend/auth_states/<numberId>/` (multi-arquivo). `whatsapp.js` mantém um mapa de sessões em memória; `restoreSessions()` é chamado no boot do server e religa as sessões existentes. QR code é convertido pra data URL via `qrcode` e exposto via `GET /api/whatsapp/sessions/:id`. Broadcasts adicionam intervalo (default 4s) entre envios para reduzir risco de bloqueio.

### Convenções

- Backend é CommonJS (`require`), frontend é ESM.
- O frontend chama `/api/*` (caminhos relativos) — Vite faz proxy para `localhost:3001`. Não há lógica de URL absoluta nem CORS em dev.
- Token JWT vai em `localStorage["nimbus.token"]` (ver `frontend/src/data/api.js`). Toda request via helper `http()`, que injeta `Authorization: Bearer` e trata 401.
- `backend/data/` e `backend/auth_states/` estão no `.gitignore` — nunca versionar nada de lá.
- Persistência: sempre escrever em `.tmp` e renomear (atômico). Padrão usado em `storage.js`, `catalog.js`, `admin-scraper.js`, `affiliate.js`.
