-- Task 7: testes de cupom no checkout pedidos à mão na aba Repasse (link + código).
CREATE TABLE "repasse_coupon_manual" (
    "id" BIGSERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tested_at" TIMESTAMP(3),
    "verdict" TEXT,
    "message" TEXT,

    CONSTRAINT "repasse_coupon_manual_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "repasse_coupon_manual_tested_at_idx" ON "repasse_coupon_manual"("tested_at");
