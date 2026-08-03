# scraping/

Tudo relacionado a **pegar produtos das lojas** e **transformar links em links de afiliado**.

## Arquivos

- **`scraper.js`** — usa Puppeteer pra navegar nas páginas de ofertas de Mercado Livre, Amazon e Shopee e extrair os produtos. Define as constantes `CATEGORIES` (eletrônicos, casa, etc) e `STORES` (`ml`, `amazon`, `shopee`). No ML, `scrapeML` combina duas fontes — vitrine pública (`harvestMLVitrine`) e Hub de Afiliados — na ordem escolhida pelo admin.
- **`admin.js`** — o "admin-scraper": roda o `scraper.js` em loop, no intervalo configurado pelo admin, e dá `upsert` dos produtos no `catalog/`. Tem rotas `/api/admin/scraper/*` pra ligar, desligar e ver status.
- **`affiliate.js`** — converte URLs cruas em links de afiliado per-user e mantém cache + telemetria (último sucesso/falha por loja). Suporta:
  - **Mercado Livre**: API oficial de short link da ML (tag + cookie autenticado). Cache de 7 dias por (userId, link).
  - **Amazon**: anexa `?tag=<sua-tag>` na URL canônica `/dp/ASIN`. Extrai o ASIN com regex.
  - **Shopee**: GraphQL `open-api.affiliate.shopee.com.br` (App ID + App Secret). Cache de 7 dias.
- **`ml-hub.js`** — **Hub de Afiliados** do ML (`mercadolivre.com.br/afiliados/hub`), página que só existe logado. Confirma o acesso (`checkHubAccess`), coleta as ofertas (`scrapeHub`) e salva a página em disco (`dumpHub`). Usa a **sessão da conta do sistema** (ver abaixo), nunca o cookie de um usuário.
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

## Sessão ML da conta do sistema (Hub de Afiliados)

**Duas coisas diferentes, de donos diferentes — não misture:**

| | onde fica | de quem é | pra que serve |
|---|---|---|---|
| cookie do cliente | `affiliate_config.ml.cookie` (por usuário) | do cliente | gerar link curto com a TAG dele |
| sessão do sistema | `app_config` chave `scraper-ml-admin` | nossa | abrir páginas que só existem logado (Hub) |

`affiliate.getScraperMLSession()` resolve a sessão do sistema: env **`ML_SCRAPER_COOKIE`** → sessão salva no admin → `null`. **De propósito não existe fallback pro cookie de nenhum usuário** — raspar com a conta de um cliente sem ele saber não é aceitável (o Shopee tem esse fallback por herança).

Onde se mexe: **Admin › Mercado Livre**, card "Conta do Mercado Livre do sistema" (salvar / testar acesso / apagar). Rotas: `GET|PUT|DELETE /api/admin/scraper/ml/session` e `POST /api/admin/scraper/ml/session/test`. O cookie nunca sai da API inteiro — só tamanho e prévia.

### Como a coleta do Hub funciona

O Hub **não é raspado do HTML**. A própria página busca as ofertas numa API interna
(`/affiliate-program/api/hub/search`) que devolve os cards prontos em JSON (formato
"polycard"): MLB do produto, URL, título, imagem, preço, preço anterior, "60% OFF",
`alt_text` de nota/vendas no mesmo formato da vitrine (por isso `polycardToProduct`
reusa `parseMLReviewCompacted`), selo "MAIS VENDIDO" e a comissão ("GANHOS 12%").

Chamar essa API por fora **não funciona** (GET → 404, POST → 403: falta o CSRF e os
cabeçalhos que o ML monta no navegador). Então `scrapeHub` abre o Hub no Chrome com
a sessão do sistema e **escuta as respostas** que a página busca sozinha, rolando
pra carregar mais (18 cards por resposta, teto de 15 rolagens).

O filtro por categoria é aplicado **clicando na interface** (o ML não aceita filtro
por URL): `HUB_CATEGORIES` mapeia as nossas 10 categorias para o `{ id, label }` do
menu do Hub. Se o clique não pegar, a coleta segue sem filtro e o log avisa —
degrada, não quebra.

O Hub **não é uma loja nova**: os produtos saem como `store: "Mercado Livre"` e o
`scrapeML` junta os dois conjuntos com `mergeNewProducts`, deduplicando pela chave
do catálogo (o MLB), porque o mesmo item aparece nos dois lugares com URLs
diferentes. Extras do Hub (`hub`, `commission`, `extraCommission`, `bestSeller`,
`mlItemId`) vão pro `payload` jsonb do catálogo. Hub fora do ar não derruba a coleta
da vitrine pública.

### As duas fontes e a ordem entre elas

O ML tem **duas fontes**: a vitrine pública (`harvestMLVitrine`, a coleta de
sempre) e o Hub. Quais estão ligadas e qual vem primeiro ficam em `app_config`
chave **`ml-scraper-sources`** = `{ vitrine, hub, priority }` (default: as duas
ligadas, prioridade `hub`) — chave separada da sessão do sistema de propósito,
senão apagar o cookie apagaria junto a preferência da vitrine. Quem tinha o
`hubEnabled` antigo (que morava dentro de `scraper-ml-admin`) herda o valor na
primeira leitura.

`affiliate.orderedMLSources()` devolve as fontes ativas já na ordem. O `scrapeML`
percorre essa ordem: a primeira coleta com alvo `limit`, filtra, ordena por
desconto e entra; a segunda só é chamada com o que **faltar** — se a primeira já
encheu a cota, a segunda nem abre navegador. Uma fonte que falhar (sessão
expirada, layout mudado) é logada e pulada; a outra segue.

Liga/desliga e prioridade: card "De onde vêm as ofertas" em Admin › Mercado Livre
(`GET|PUT /api/admin/scraper/ml/sources`). Desligar as duas é recusado — pra parar
o ML inteiro, use o admin-scraper.

Pra inspecionar o Hub quando algo parecer errado:

```
node scripts/ml-hub-dump.js                    # → backend/logs/ml-hub/<timestamp>/
node scripts/ml-hub-dump.js --category casa    # aplica o filtro antes de capturar
```

Grava `hub.html`, `hub.png`, `hub-xhr.json` (as respostas cruas da API),
`hub-cards.json` (os produtos já convertidos — é o que mostra na hora se o formato
mudou) e `hub-meta.json` (inclui as categorias que o Hub oferece hoje, pra conferir
o `HUB_CATEGORIES`). O cookie não vai pros arquivos.
