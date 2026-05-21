# data/

Helpers de **dados e configuração** do frontend. Não é estado React — são funções e constantes usadas por várias páginas.

## Arquivos

- **`api.js`** — wrapper em volta do `fetch` nativo. Adiciona o token JWT do `localStorage`, trata 401 (dispara `nimbus:unauthorized`), parseia JSON. Todo request pro backend passa por aqui.
- **`constants.js`** — listas compartilhadas: `CATEGORIES` (eletrônicos, casa, etc), `allSources` (ml, amazon), helpers tipo `groupUsesML()`. **Tem que ficar em sincronia manual com `backend/scraping/scraper.js`** — adicionar categoria nova exige mexer nos dois.
- **`mockData.js`** — *starter state* da SPA: listas vazias (`initialGroups`, `initialNumbers`, `initialWhatsappGroups`), `DEFAULT_MESSAGE_TEMPLATE` e o factory `makeEmptyGroup({ id, name, categories, template })` usado pelo `App.jsx` ao criar campanha nova. Não tem dados de demo — o estado real vem do backend (`GET /api/state`).

## Por que não tem `axios`?

Decisão consciente: `fetch` nativo já dá conta, sem dependência a mais. O wrapper em `api.js` resolve as únicas duas coisas chatas (token + 401).
