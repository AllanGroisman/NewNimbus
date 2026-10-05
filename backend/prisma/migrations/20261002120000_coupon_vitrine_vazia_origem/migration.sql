-- Task 8: a vitrine do cupom foi aberta e não tinha card nenhum (sem muro no
-- caminho). Até aqui isso só aparecia no log da rodada: o cupom seguia contado como
-- "sem nenhum produto" e voltava para a fila do botão 2 em toda rodada.
ALTER TABLE "ml_coupons" ADD COLUMN "vitrineVaziaAt" TIMESTAMP(3);

-- Tasks 9 e 10: o produto do catálogo só existe por causa da vitrine de um cupom.
-- `true` enquanto TODA escrita na linha veio de uma vitrine; qualquer outra fonte
-- (scraping, repasse) a derruba para `false` (catalog/pg.js:upsertProducts).
--
-- O default `false` é de propósito: o catálogo nunca guardou de onde a linha veio,
-- e as linhas que já existem contam como "outra origem" — os botões de apagar não
-- tocam nelas. Elas continuam saindo pelo purge diário do scraping.
ALTER TABLE "catalog_products" ADD COLUMN "soDaVitrine" BOOLEAN NOT NULL DEFAULT false;
