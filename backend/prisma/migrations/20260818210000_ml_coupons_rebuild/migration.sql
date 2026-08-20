-- Cupons do Mercado Livre: as três tabelas da aba /cupons + a coluna que liga o
-- catálogo a uma campanha.
--
-- Por que tudo aqui é IF NOT EXISTS: as migrations 20260812135540_ml_coupons e
-- 20260812200229_ml_coupon_codes constam como aplicadas nesta máquina, mas as
-- pastas delas ficaram VAZIAS — o migration.sql sumiu e nunca entrou no git (o
-- mesmo caso descrito em 20260818110000_repasse_log_coupon). O banco de dev, por
-- causa disso, JÁ tem as três tabelas com dados (75 cupons, 1.122 vínculos, 6
-- palavras testadas), enquanto um banco novo não tem nada. Esta migration precisa
-- funcionar nos dois: no dev não faz nada e os dados sobrevivem; no limpo cria.

CREATE TABLE IF NOT EXISTS "ml_coupons" (
  "campaign_id"      TEXT NOT NULL,
  "title"            TEXT NOT NULL,
  "subtitle"         TEXT,
  "kind"             TEXT NOT NULL DEFAULT 'unknown',
  "value"            DOUBLE PRECISION,
  "minPurchase"      DOUBLE PRECISION,
  "maxDiscount"      DOUBLE PRECISION,
  "scope"            TEXT NOT NULL DEFAULT 'campaign',
  "sellerName"       TEXT,
  "containerUrl"     TEXT,
  "activated"        BOOLEAN NOT NULL DEFAULT false,
  "activationType"   TEXT,
  "startsAt"         TIMESTAMP(3),
  "expiresAt"        TIMESTAMP(3),
  "expiresText"      TEXT,
  "iconUrl"          TEXT,
  "groupings"        JSONB NOT NULL DEFAULT '[]',
  "sampleItems"      JSONB NOT NULL DEFAULT '[]',
  "raw"              JSONB NOT NULL DEFAULT '{}',
  "firstSeenAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "productsSyncedAt" TIMESTAMP(3),
  "code"             TEXT,
  "origin"           TEXT NOT NULL DEFAULT 'page',
  CONSTRAINT "ml_coupons_pkey" PRIMARY KEY ("campaign_id")
);

CREATE INDEX IF NOT EXISTS "ml_coupons_expiresAt_idx"  ON "ml_coupons"("expiresAt");
CREATE INDEX IF NOT EXISTS "ml_coupons_lastSeenAt_idx" ON "ml_coupons"("lastSeenAt" DESC);
CREATE INDEX IF NOT EXISTS "ml_coupons_scope_idx"      ON "ml_coupons"("scope");
CREATE INDEX IF NOT EXISTS "ml_coupons_code_idx"       ON "ml_coupons"("code");

CREATE TABLE IF NOT EXISTS "ml_coupon_products" (
  "id"          BIGSERIAL NOT NULL,
  "campaign_id" TEXT NOT NULL,
  "productKey"  TEXT NOT NULL,
  "productUrl"  TEXT NOT NULL,
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ml_coupon_products_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ml_coupon_products_campaign_id_productKey_key" ON "ml_coupon_products"("campaign_id", "productKey");
CREATE INDEX IF NOT EXISTS "ml_coupon_products_productKey_idx" ON "ml_coupon_products"("productKey");

-- A FK não existia no banco de dev (as tabelas nasceram sem ela). Só é criada
-- quando falta, e nunca com dados órfãos pendurados: o DELETE abaixo tira vínculo
-- de campanha que não existe mais antes de ligar a trava.
DELETE FROM "ml_coupon_products" p WHERE NOT EXISTS (SELECT 1 FROM "ml_coupons" c WHERE c."campaign_id" = p."campaign_id");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ml_coupon_products_campaign_id_fkey') THEN
    ALTER TABLE "ml_coupon_products"
      ADD CONSTRAINT "ml_coupon_products_campaign_id_fkey"
      FOREIGN KEY ("campaign_id") REFERENCES "ml_coupons"("campaign_id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "ml_coupon_codes" (
  "code"          TEXT NOT NULL,
  "verdict"       TEXT NOT NULL,
  "campaign_id"   TEXT,
  "message"       TEXT,
  "response_code" TEXT,
  "source"        TEXT,
  "checked_at"    TIMESTAMP(3) NOT NULL,
  "check_count"   INTEGER NOT NULL DEFAULT 1,
  "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "raw"           JSONB NOT NULL DEFAULT '{}',
  CONSTRAINT "ml_coupon_codes_pkey" PRIMARY KEY ("code")
);

CREATE INDEX IF NOT EXISTS "ml_coupon_codes_campaign_id_idx" ON "ml_coupon_codes"("campaign_id");
CREATE INDEX IF NOT EXISTS "ml_coupon_codes_checked_at_idx"  ON "ml_coupon_codes"("checked_at");

-- O produto do catálogo aponta para a campanha que o cobre. Coluna e não payload:
-- o upsert do scraping reescreve o payload inteiro, e o cupom sumiria na rodada
-- seguinte sem ninguém perceber.
ALTER TABLE "catalog_products" ADD COLUMN IF NOT EXISTS "couponCampaignId" TEXT;
CREATE INDEX IF NOT EXISTS "catalog_products_couponCampaignId_idx" ON "catalog_products"("couponCampaignId");
