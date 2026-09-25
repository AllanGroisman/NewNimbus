-- O produto em que o cupom foi testado no checkout. Com ele a aba Admin › Cupom ›
-- Repasse mostra o último resultado de cada link que chegou com o cupom.
ALTER TABLE "repasse_coupon_autotest" ADD COLUMN "url" TEXT;
CREATE INDEX "repasse_coupon_autotest_code_url_created_at_idx"
  ON "repasse_coupon_autotest" ("code", "url", "created_at" DESC);
