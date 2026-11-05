-- A marca do "Buscar condições" da aba Admin › Scraping Cupons › Cupons com
-- Palavras: a sonda do checkout rodou nos produtos da palavra e o cupom não
-- apareceu. É o que deixa o admin limpar essas palavras depois ("Limpar não
-- achados"). Some quando uma sonda acha as condições.

ALTER TABLE "ml_coupon_codes" ADD COLUMN IF NOT EXISTS "condicoes_falhou_at" TIMESTAMP(3);
ALTER TABLE "ml_coupon_codes" ADD COLUMN IF NOT EXISTS "condicoes_motivo" TEXT;
