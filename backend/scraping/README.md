# scraping/

Tudo relacionado a **pegar produtos das lojas** e **transformar links em links de afiliado**.

## Arquivos

- **`scraper.js`** — usa Puppeteer pra navegar nas páginas de ofertas de Mercado Livre, Amazon e Shopee e extrair os produtos. Define as constantes `CATEGORIES` (eletrônicos, casa, etc) e `STORES` (`ml`, `amazon`, `shopee`).
- **`admin.js`** — o "admin-scraper": roda o `scraper.js` em loop, no intervalo configurado pelo admin, e dá `upsert` dos produtos no `catalog/`. Tem rotas `/api/admin/scraper/*` pra ligar, desligar e ver status.
- **`affiliate.js`** — converte URLs cruas em links de afiliado per-user e mantém cache + telemetria (último sucesso/falha por loja). Suporta:
  - **Mercado Livre**: API oficial de short link da ML (tag + cookie autenticado). Cache de 7 dias por (userId, link).
  - **Amazon**: anexa `?tag=<sua-tag>` na URL canônica `/dp/ASIN`. Extrai o ASIN com regex.
  - **Shopee**: GraphQL `open-api.affiliate.shopee.com.br` (App ID + App Secret). Cache de 7 dias.
- **`affiliate-store/`** — façade (`index.js` + `pg.js`) pro storage per-user das configs de afiliado. Persiste em `affiliate_config` (Prisma) com cache em memória write-through. Expõe `getRaw(userId)`, `setRaw(userId, value)`, `clear(userId)`, `listShopeeConfigs()`, `warmup()`.

## Gating por afiliado

Se uma campanha usa Mercado Livre **ou Shopee** mas o afiliado não está configurado, o `scheduler.js` (função `affiliateGate` / `groupPausedByAffiliate`) pausa o grupo: não scrape, não envia. Amazon **não pausa** — cai pro link cru quando a tag está ausente.

Se o cookie do ML estiver presente mas expirado, o sistema cai pro link cru (diferente de "nunca configurou", que pausa).

No frontend, `groupUsesML()` em `data/constants.js` ajuda a renderizar o banner pra UI.

## Cuidado: sincronia com o frontend

`scraper.js` define `CATEGORIES` e `STORES`. O frontend tem cópias dessas listas em `frontend/src/data/constants.js`. **Adicionar uma categoria nova exige mexer nos dois lugares** — não há geração automática.

## Override por env var (dev / admin-scraper)

As envs `ML_AFFILIATE_TAG` + `ML_AFFILIATE_COOKIE`, `AMAZON_AFFILIATE_TAG`, `SHOPEE_AFFILIATE_APP_ID` + `SHOPEE_AFFILIATE_APP_SECRET` continuam funcionando como **override GLOBAL** (sobrescrevem qualquer config persistida). Quando setadas, o `affiliate.writeXxxConfig` rejeita escritas — pra mexer pela UI é preciso desligar as envs.

O admin-scraper (que roda fora de userId) usa env vars OU pega creds Shopee do primeiro usuário configurado via `affiliate.getScraperShopeeCreds()` → `affiliate-store.listShopeeConfigs()`.
