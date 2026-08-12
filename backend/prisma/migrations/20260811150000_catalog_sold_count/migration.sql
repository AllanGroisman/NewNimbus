-- "soldCount": o número de vendas do produto, já parseado.
--
-- O filtro "vendas mínimas" da Busca de Produtos rodava em JS depois da query,
-- porque `sold` é texto ("+1,5 mil vendidos"). Consequência: o count() não
-- enxergava o corte (total inflado, últimas páginas vazias) e o query() tinha
-- que buscar 5x a página pra ter folga. Com a contagem numa coluna, o filtro
-- volta pro WHERE e o total volta a ser exato.
--
-- Backfill segue exatamente a regra do parseSold() (backend/catalog/pg.js):
-- primeiro número do texto, ponto é separador de milhar, vírgula é decimal,
-- "mil" multiplica por mil e "mi" por um milhão. Sem venda conhecida vira 0,
-- que é o que parseSold(null) devolve — assim minSales > 0 já os descarta.

ALTER TABLE "catalog_products" ADD COLUMN "soldCount" INTEGER;

-- Shopee já manda a contagem exata; ela vive no payload desde antes desta coluna.
UPDATE "catalog_products"
   SET "soldCount" = ROUND(("payload"->>'soldCount')::numeric)
 WHERE "payload"->>'soldCount' ~ '^[0-9]+(\.[0-9]+)?$';

UPDATE "catalog_products"
   SET "soldCount" = ROUND(
         REPLACE(REPLACE(SUBSTRING(LOWER("sold") FROM '[0-9][0-9.,]*'), '.', ''), ',', '.')::numeric
         * CASE
             WHEN LOWER("sold") ~ 'mil' THEN 1000
             WHEN LOWER("sold") ~ 'mi'  THEN 1000000
             ELSE 1
           END
       )
 WHERE "soldCount" IS NULL
   -- Guarda no texto já transformado: sobrando mais de um ponto (texto
   -- estranho como "1.2.3,4"), o ::numeric estouraria e derrubaria a migração.
   AND REPLACE(REPLACE(SUBSTRING(LOWER("sold") FROM '[0-9][0-9.,]*'), '.', ''), ',', '.')
       ~ '^[0-9]+(\.[0-9]+)?$';

UPDATE "catalog_products" SET "soldCount" = 0 WHERE "soldCount" IS NULL;

CREATE INDEX "catalog_products_soldCount_idx" ON "catalog_products"("soldCount" DESC);
