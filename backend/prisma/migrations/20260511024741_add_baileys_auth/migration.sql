-- CreateTable
CREATE TABLE "baileys_auth" (
    "sessionId" TEXT NOT NULL,
    "keyType" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "baileys_auth_pkey" PRIMARY KEY ("sessionId","keyType","keyId")
);

-- CreateIndex
CREATE INDEX "baileys_auth_sessionId_idx" ON "baileys_auth"("sessionId");
