# catalog/

**Catálogo global de produtos** — compartilhado entre todos os usuários. O scraper joga produtos aqui dentro; o scheduler lê daqui pra montar a fila de envio de cada grupo.

## Arquivos

- **`index.js`** — fachada. Devolve a versão JSON ou Postgres conforme `STORAGE_BACKEND`.
- **`json.js`** — guarda tudo em `backend/data/catalog.json`. Tem um mutex global pra evitar corrida quando o admin-scraper escreve enquanto outro processo lê.
- **`pg.js`** — versão Postgres. Cada produto vira linha na tabela `CatalogProduct`.
- **`product-key.js`** — função que gera uma "chave única" do produto. Usa o ID do MLB quando dá (URLs de Mercado Livre), senão usa `origin + pathname` da URL. Garante que o mesmo produto com URLs ligeiramente diferentes (tracking, query) vire a mesma chave.

## Cuidado: `productKey` está duplicada

O `scheduler.js` também precisa dessa função pra calcular a chave do produto, e antes ele importava direto de `catalog/`. Em algum momento essa função foi duplicada lá dentro do scheduler pra evitar um import circular. **Se você mexer aqui, mexa lá também** — senão um lugar vai gerar uma chave e o outro vai gerar outra e o dedup quebra.

> Hoje, depois da reorganização, o scheduler importa `./catalog/product-key`. Verifique se ainda existe duplicação antes de mexer.

## Como o catálogo é alimentado

- O **admin-scraper** (`scraping/admin.js`) roda periodicamente (configurável pelo admin), faz scraping de ML e Amazon e dá `upsert` no catálogo.
- O **scheduler** lê do catálogo no tick, filtra pelas regras da campanha do grupo (categoria, fontes, desconto mínimo) e popula `group.queue`.
- O endpoint `GET /api/ofertas` também lê daqui — nunca scrape em tempo real numa request do usuário.
