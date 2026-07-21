-- CreateTable
CREATE TABLE "repasse_capture_log" (
    "id" BIGSERIAL NOT NULL,
    "groupId" BIGINT NOT NULL,
    "userId" TEXT NOT NULL,
    "waJid" TEXT NOT NULL,
    "rawUrl" TEXT NOT NULL,
    "resolvedUrl" TEXT,
    "store" TEXT,
    "sourceAllowed" BOOLEAN,
    "affiliateConfigured" BOOLEAN,
    "scrapeOk" BOOLEAN,
    "productName" TEXT,
    "outcome" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "repasse_capture_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "repasse_capture_log_groupId_createdAt_idx" ON "repasse_capture_log"("groupId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "repasse_capture_log_userId_createdAt_idx" ON "repasse_capture_log"("userId", "createdAt" DESC);
