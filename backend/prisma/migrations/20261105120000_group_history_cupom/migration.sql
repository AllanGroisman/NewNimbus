-- O que a mensagem prometeu em cada envio: cupom, preço conferido na landing e
-- preço com cupom. A aba Admin › Scraping Cupons › Cupons Teste confere isto
-- contra o que o checkout do ML cobra. Null nos envios antigos (a aba refaz a
-- conta e marca como "estimado").

ALTER TABLE "group_history" ADD COLUMN IF NOT EXISTS "coupon" TEXT;
ALTER TABLE "group_history" ADD COLUMN IF NOT EXISTS "couponCampaignId" TEXT;
ALTER TABLE "group_history" ADD COLUMN IF NOT EXISTS "sentPrice" DOUBLE PRECISION;
ALTER TABLE "group_history" ADD COLUMN IF NOT EXISTS "priceWithCoupon" DOUBLE PRECISION;
ALTER TABLE "group_history" ADD COLUMN IF NOT EXISTS "couponLabel" TEXT;

-- A aba lista os envios recentes de todas as campanhas.
CREATE INDEX IF NOT EXISTS "group_history_sentAt_idx" ON "group_history" ("sentAt" DESC);

-- As rodadas da aba Cupons Teste e cada produto conferido nelas.
CREATE TABLE IF NOT EXISTS "cupom_teste_runs" (
    "id" BIGSERIAL NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'rodando',
    "config" JSONB NOT NULL DEFAULT '{}',
    "total" INTEGER NOT NULL DEFAULT 0,
    "feitos" INTEGER NOT NULL DEFAULT 0,
    "ok" INTEGER NOT NULL DEFAULT 0,
    "divergente" INTEGER NOT NULL DEFAULT 0,
    "nao_pegou" INTEGER NOT NULL DEFAULT 0,
    "falhou" INTEGER NOT NULL DEFAULT 0,
    "motivo_fim" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    CONSTRAINT "cupom_teste_runs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "cupom_teste_runs_started_at_idx" ON "cupom_teste_runs" ("started_at" DESC);

CREATE TABLE IF NOT EXISTS "cupom_teste_itens" (
    "id" BIGSERIAL NOT NULL,
    "run_id" BIGINT NOT NULL,
    "group_id" TEXT,
    "group_name" TEXT,
    "product_key" TEXT,
    "name" TEXT,
    "img" TEXT,
    "link" TEXT NOT NULL,
    "coupon" TEXT,
    "sent_at" TIMESTAMP(3),
    "estimado" BOOLEAN NOT NULL DEFAULT false,
    "prometido_preco" DOUBLE PRECISION,
    "prometido_com_cupom" DOUBLE PRECISION,
    "preco_pagina" DOUBLE PRECISION,
    "desconto_ml" DOUBLE PRECISION,
    "real_com_cupom" DOUBLE PRECISION,
    "total_checkout" DOUBLE PRECISION,
    "diferenca" DOUBLE PRECISION,
    "status" TEXT NOT NULL,
    "motivo" TEXT,
    "detalhe" JSONB NOT NULL DEFAULT '{}',
    "duration_ms" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "cupom_teste_itens_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "cupom_teste_itens_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "cupom_teste_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "cupom_teste_itens_run_id_id_idx" ON "cupom_teste_itens" ("run_id", "id");
