-- Busca por palavras-chave (catalog/search-query.js). O `name ILIKE '%x%'` não
-- ignorava acento ("cafe" não achava "Café") e varria a tabela inteira.
--
-- `nameSearch` é o nome já sem acento e em minúsculas — quem escreve daqui pra
-- frente é o catalog/pg.js:toRow, com a mesma normalizeText() que trata os termos
-- da busca. O preenchimento abaixo cobre as linhas antigas com os acentos do
-- português, que é o que o catálogo tem; a próxima raspagem regrava o resto.
--
-- O índice GIN de trigramas serve o `LIKE '%x%'` e a busca aproximada (`<%`,
-- quando a exata não acha nada: "samsumg" → "samsung").
CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE "catalog_products" ADD COLUMN IF NOT EXISTS "nameSearch" TEXT NOT NULL DEFAULT '';

UPDATE "catalog_products"
   SET "nameSearch" = btrim(regexp_replace(
         translate(lower("name"),
                   'áàâãäéèêëíìîïóòôõöúùûüçñ',
                   'aaaaaeeeeiiiiooooouuuucn'),
         '\s+', ' ', 'g'));

CREATE INDEX IF NOT EXISTS "catalog_products_nameSearch_idx"
    ON "catalog_products" USING GIN ("nameSearch" gin_trgm_ops);
