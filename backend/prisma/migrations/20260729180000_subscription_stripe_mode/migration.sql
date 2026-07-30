-- Modo do Stripe (test/live) em que a assinatura foi criada. O admin pode
-- alternar o sistema entre os produtos de teste e os de produção, e uma
-- assinatura só vale enquanto o sistema está no modo dela — senão os IDs de
-- customer/subscription apontariam pra objetos que não existem no outro modo.
-- NULL = linha sem Stripe (usuário nunca assinou).
ALTER TABLE "subscriptions" ADD COLUMN "stripeMode" TEXT;

-- Backfill: tudo que existe hoje foi criado com as chaves de teste.
UPDATE "subscriptions" SET "stripeMode" = 'test' WHERE "stripeCustomerId" IS NOT NULL;
