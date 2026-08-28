-- A vitrine do cupom (lista.mercadolivre.com.br/_Container_…) está atrás de um
-- muro anti-bot desde 25/08/2026: a rodada morria com "Parei nas vitrines:
-- CAPTCHA" e `ml_coupon_products` ficava vazia, o que fazia o quick-check
-- responder "não sei" para quase todo cupom.
--
-- O que o ML entrega sem muro nenhum: as 4 miniaturas do card do cupom, que vêm
-- com os MLBs no bloco de telemetria do modelo da própria aba /cupons
-- (ml-cupons.js:sampleIdsFromTracking). São produtos reais da vitrine, de graça,
-- e existem inclusive para o cupom NÃO ativado — que não tem vitrine pra raspar.
--
-- Mas amostra e vitrine não valem a mesma coisa, e misturar as duas causaria o
-- erro caro do quick-check: 4 amostras que não casam com o produto virariam
-- "este cupom não cobre este produto" (fora-da-vitrine) quando a verdade é
-- "não sei" (sem-vitrine) — descartando cupom bom. Daí a coluna.
-- Valores: 'vitrine' (lista completa, raspada no navegador), 'landing' (a prévia
-- de 3-8 itens que a landing de afiliado entrega sem navegador) e 'amostra'.
-- Só 'vitrine' é lista fechada; as outras duas provam cobertura, não ausência.
ALTER TABLE "ml_coupon_products" ADD COLUMN IF NOT EXISTS "origem" TEXT NOT NULL DEFAULT 'vitrine';

-- Tudo que já está gravado veio da vitrine, então o default já classifica certo.

-- O quick-check pergunta "esta campanha tem vitrine de verdade?" a cada teste.
CREATE INDEX IF NOT EXISTS "ml_coupon_products_campaign_id_origem_idx"
  ON "ml_coupon_products" ("campaign_id", "origem");

-- Os ids da amostra ficam guardados no cupom também: é o que permite regravar os
-- vínculos sem reabrir a página, e é o registro de o que sustentou o vínculo.
ALTER TABLE "ml_coupons" ADD COLUMN IF NOT EXISTS "sampleItemIds" JSONB NOT NULL DEFAULT '[]';
