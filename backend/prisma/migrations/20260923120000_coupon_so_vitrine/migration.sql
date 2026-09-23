-- Task 22: os produtos de um cupom vêm só da página dele (a vitrine).
--
-- Saem as duas fontes de prévia: a landing de afiliado (3-8 itens, origem
-- 'landing') e as 4 miniaturas do card (origem 'amostra'). A vitrine que a
-- raspagem viu só em parte passa a ter origem própria, 'parcial' — até aqui ela
-- era gravada como 'landing' e sai junto; esses cupons voltam para a fila de
-- "sem produtos" e são raspados de novo.
DELETE FROM "ml_coupon_products" WHERE "origem" IN ('amostra', 'landing');

-- O mesmo passo 3 do coupons/pg.js:syncCatalogCoupons: produto carimbado com
-- campanha que não tem mais vínculo com ele perde o carimbo. O carimbo para outra
-- campanha que ainda o cubra volta na próxima rodada.
UPDATE "catalog_products" cp SET "couponCampaignId" = NULL
 WHERE cp."couponCampaignId" IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM "ml_coupon_products" p
      WHERE p."productKey" = cp."key" AND p."campaign_id" = cp."couponCampaignId");
