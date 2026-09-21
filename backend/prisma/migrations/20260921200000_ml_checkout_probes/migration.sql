-- A sonda do checkout em lote (task 13): um registro por produto sondado, com o
-- desfecho — inclusive "0 cupons". Serve pra pular quem foi sondado há pouco e
-- pra medir quantos produtos de cada categoria tiveram cupom (a ordem da fila).
CREATE TABLE IF NOT EXISTS "ml_checkout_probes" (
    "productKey" TEXT NOT NULL,
    "productUrl" TEXT NOT NULL,
    "category" TEXT,
    "probedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ok" BOOLEAN NOT NULL,
    "cupons" INTEGER NOT NULL DEFAULT 0,
    "campaignIds" JSONB NOT NULL DEFAULT '[]',
    "motivo" TEXT,

    CONSTRAINT "ml_checkout_probes_pkey" PRIMARY KEY ("productKey")
);

CREATE INDEX IF NOT EXISTS "ml_checkout_probes_probedAt_idx" ON "ml_checkout_probes"("probedAt");
CREATE INDEX IF NOT EXISTS "ml_checkout_probes_category_idx" ON "ml_checkout_probes"("category");
