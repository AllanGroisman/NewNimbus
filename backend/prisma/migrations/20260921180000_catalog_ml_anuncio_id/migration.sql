-- O mesmo produto do ML chegava ao catálogo com duas chaves: a vitrine/landing do
-- cupom entrega `/p/MLB<catálogo>?…&wid=MLB<anúncio>` e o scraping entrega
-- `produto.mercadolivre.com.br/MLB-<anúncio>`. O productKey usa o número do
-- caminho, então saíam dois hashes, duas linhas, e o cupom carimbado numa só.
--
-- A coluna guarda o nº do anúncio (catalog/product-key.js:mlAnuncioIdFromUrl) e é
-- por ela que o upsert acha a linha que já existe. Fica nula aqui: o preenchimento
-- das linhas antigas e a fusão das duplicadas são do scripts/merge-ml-duplicates.js,
-- porque a leitura do anúncio é a MESMA função JS que o upsert usa — reescrevê-la
-- em regex de SQL seria ter duas versões da regra.
ALTER TABLE "catalog_products" ADD COLUMN IF NOT EXISTS "mlAnuncioId" TEXT;
CREATE INDEX IF NOT EXISTS "catalog_products_mlAnuncioId_idx" ON "catalog_products"("mlAnuncioId");
