-- Checkout público (landing page → Stripe → conta criada pelo pagamento).
--
-- checkoutSessionId: id da Checkout Session que originou a assinatura. É o que
--   liga o retorno do Stripe (/bem-vindo?session_id=…) à conta provisionada, e
--   o UNIQUE é o que garante idempotência entre o webhook e o resgate — os dois
--   chamam provisionFromCheckout e o primeiro a gravar ganha.
-- claimedAt: o session_id anda na URL de retorno, então o resgate é de uso único.
-- signupSource: "landing" (pagou antes de ter conta) | "app" (assinou logado).
ALTER TABLE "subscriptions" ADD COLUMN "checkoutSessionId" TEXT;
ALTER TABLE "subscriptions" ADD COLUMN "claimedAt" TIMESTAMP(3);
ALTER TABLE "subscriptions" ADD COLUMN "signupSource" TEXT;

CREATE UNIQUE INDEX "subscriptions_checkoutSessionId_key" ON "subscriptions"("checkoutSessionId");

-- Backfill: tudo que existe hoje foi assinado por dentro do app.
UPDATE "subscriptions" SET "signupSource" = 'app' WHERE "stripeCustomerId" IS NOT NULL;
