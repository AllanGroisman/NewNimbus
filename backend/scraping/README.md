# scraping/

Tudo relacionado a **pegar produtos das lojas** e **transformar links em links de afiliado**.

## Arquivos

- **`scraper.js`** — usa Puppeteer pra navegar nas páginas de ofertas de Mercado Livre e Amazon e extrair os produtos. Define as constantes `CATEGORIES` (eletrônicos, casa, etc) e `STORES` (ml, amazon).
- **`admin.js`** — o "admin-scraper": roda o `scraper.js` em loop, no intervalo configurado pelo admin, e dá `upsert` dos produtos no `catalog/`. Tem rotas `/api/admin/scraper/*` pra ligar, desligar, ver status.
- **`affiliate.js`** — converte URLs cruas em links de afiliado:
  - **Mercado Livre**: chama a API oficial de short link da ML (precisa de tag + cookie autenticado). Cache de 7 dias por URL.
  - **Amazon**: só anexa `?tag=<sua-tag>` na URL (formato `/dp/ASIN`). Extrai o ASIN com regex.

## Gating por afiliado (importante)

Se uma campanha usa Mercado Livre mas a tag + cookie não estão configurados, o sistema **não envia nada** (pausa o grupo). Isso evita compartilhar links crus sem comissão.

A função `groupUsesML()` (no frontend, em `data/constants.js`) é o que detecta isso. O backend respeita o estado: scheduler vê que o link não pode ser convertido e pula.

Se o cookie estiver presente mas expirado, o sistema **cai pro link cru** — diferente de "nunca configurou".

## Cuidado: sincronia com o frontend

`scraper.js` define `CATEGORIES` e `STORES`. O frontend tem cópias dessas listas em `frontend/src/data/constants.js`. **Adicionar uma categoria nova exige mexer nos dois lugares**.
