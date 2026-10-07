-- Estatísticas da aba Grupos (task 4 de tasks.md).
-- group_member_events: entrada/saída de participante, com a hora do servidor do
--   WhatsApp; o unique é o dedupe entre números do mesmo usuário no grupo.
-- group_send_events: um envio de campanha por grupo, pra "saídas após envio".
-- group_member_snapshots: tamanho do grupo por dia de Brasília.
-- Sem FK pra whatsapp_groups/groups de propósito (whatsapp_groups é replace-all
-- a cada save); só pro usuário.

-- CreateTable
CREATE TABLE "group_member_events" (
    "id" BIGSERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "groupJid" TEXT NOT NULL,
    "participant" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "numberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_member_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_send_events" (
    "id" BIGSERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "groupJid" TEXT NOT NULL,
    "campaignId" BIGINT NOT NULL,
    "numberId" TEXT,
    "productName" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_send_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_member_snapshots" (
    "userId" TEXT NOT NULL,
    "groupJid" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "members" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "group_member_snapshots_pkey" PRIMARY KEY ("userId","groupJid","day")
);

-- CreateIndex
CREATE INDEX "group_member_events_userId_groupJid_at_idx" ON "group_member_events"("userId", "groupJid", "at");

-- CreateIndex
CREATE INDEX "group_member_events_at_idx" ON "group_member_events"("at");

-- CreateIndex
CREATE UNIQUE INDEX "group_member_events_userId_groupJid_participant_kind_at_key" ON "group_member_events"("userId", "groupJid", "participant", "kind", "at");

-- CreateIndex
CREATE INDEX "group_send_events_userId_groupJid_at_idx" ON "group_send_events"("userId", "groupJid", "at");

-- CreateIndex
CREATE INDEX "group_send_events_at_idx" ON "group_send_events"("at");

-- AddForeignKey
ALTER TABLE "group_member_events" ADD CONSTRAINT "group_member_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_send_events" ADD CONSTRAINT "group_send_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_member_snapshots" ADD CONSTRAINT "group_member_snapshots_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

