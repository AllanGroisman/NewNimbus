-- Mensagem no privado para os membros dos grupos destino (task 4).
-- dm_broadcasts: um disparo por linha, com os contadores que a tela acompanha.
-- dm_broadcast_recipients: um destinatário por linha; o unique (broadcastId, jid)
-- é o dedupe de quem está em mais de um grupo.

-- CreateTable
CREATE TABLE "dm_broadcasts" (
    "id" BIGSERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "campaignId" BIGINT NOT NULL,
    "whatsappGroupIds" JSONB NOT NULL DEFAULT '[]',
    "text" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'preparing',
    "total" INTEGER NOT NULL DEFAULT 0,
    "sent" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "nextAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "dm_broadcasts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dm_broadcast_recipients" (
    "id" BIGSERIAL NOT NULL,
    "broadcastId" BIGINT NOT NULL,
    "numberId" TEXT NOT NULL,
    "jid" TEXT NOT NULL,
    "groupJid" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "dm_broadcast_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "dm_broadcasts_userId_status_idx" ON "dm_broadcasts"("userId", "status");

-- CreateIndex
CREATE INDEX "dm_broadcasts_campaignId_createdAt_idx" ON "dm_broadcasts"("campaignId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "dm_broadcast_recipients_broadcastId_status_idx" ON "dm_broadcast_recipients"("broadcastId", "status");

-- CreateIndex
CREATE INDEX "dm_broadcast_recipients_numberId_status_sentAt_idx" ON "dm_broadcast_recipients"("numberId", "status", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "dm_broadcast_recipients_broadcastId_jid_key" ON "dm_broadcast_recipients"("broadcastId", "jid");

-- AddForeignKey
ALTER TABLE "dm_broadcasts" ADD CONSTRAINT "dm_broadcasts_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dm_broadcast_recipients" ADD CONSTRAINT "dm_broadcast_recipients_broadcastId_fkey" FOREIGN KEY ("broadcastId") REFERENCES "dm_broadcasts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

