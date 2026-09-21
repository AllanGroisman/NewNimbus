# catalog/

**Catálogo global de produtos** — compartilhado entre todos os usuários. O scraper joga produtos aqui dentro; o scheduler lê daqui pra montar a fila de envio de cada grupo.

## Arquivos

- **`index.js`** — re-exporta `pg.js`.
- **`pg.js`** — versão Postgres. Cada produto vira linha na tabela `CatalogProduct`.
- **`product-key.js`** — função que gera uma "chave única" do produto. Usa o ID do MLB quando dá (URLs de Mercado Livre), senão usa `origin + pathname` da URL. Garante que o mesmo produto com URLs ligeiramente diferentes (tracking, query) vire a mesma chave.

## Mesmo produto, duas numerações (anúncio × catálogo)

O ML numera o mesmo produto de dois jeitos: o **catálogo** (`/p/MLB44567438`) e o **anúncio** (`MLB-5212859628`). A vitrine/landing do cupom entrega `/p/MLB<catálogo>?…&wid=MLB<anúncio>`; o scraping entrega `produto.mercadolivre.com.br/MLB-<anúncio>`. O `productKey` usa o número do caminho, então os dois saem com chaves diferentes — e ele **não muda** (é a PK).

Quem junta é a coluna `mlAnuncioId` (`product-key.js:mlAnuncioIdFromUrl`, que lê `wid`, `pdp_filters=item_id:` e o caminho de anúncio):

- **`upsertProducts`** — produto cujo anúncio já está em outra linha é gravado **nela** (preço, desconto etc. atualizados; `key` e `link` ficam os da linha; o `couponCampaignId` nunca passa pelo upsert, então o cupom fica). Devolve `canonical: Map<keyPedida, keyGravada>` e `fundidos`.
- **`resolveKeys`** — a mesma resolução para quem só precisa da chave: `coupons/pg.js:gravarVinculos` passa todo vínculo de cupom (vitrine, landing, amostra) por aqui, e o checkout também, para o carimbo cair na linha que existe.
- **`getByLink`** — não achou pela chave, procura pelo anúncio.

O critério é **só** o número do anúncio. Mesmo nome com anúncio diferente é outro vendedor, e juntar herdaria o cupom de um no anúncio do outro. As duplicatas de antes da coluna saem com `scripts/merge-ml-duplicates.js`.

## Como o catálogo é alimentado

- O **admin-scraper** (`scraping/admin.js`) roda periodicamente (configurável pelo admin), faz scraping de ML e Amazon e dá `upsert` no catálogo.
- O **scheduler** lê do catálogo no tick, filtra pelas regras da campanha do grupo (categoria, fontes, desconto mínimo) e popula `group.queue`.
- O endpoint `GET /api/ofertas` também lê daqui — nunca scrape em tempo real numa request do usuário.
