-- Limpeza automática das conversas de grupo, por número (task 13 de tasks.md).
-- Sem FK pra whatsapp_numbers de propósito (replace-all a cada save); só pro usuário.

-- CreateTable
CREATE TABLE "whatsapp_chat_cleanup" (
    "id" BIGSERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "numberId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "intervalHours" INTEGER NOT NULL DEFAULT 24,
    "jids" JSONB NOT NULL DEFAULT '[]',
    "lastRunAt" TIMESTAMP(3),
    "lastResult" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_chat_cleanup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_chat_cleanup_userId_numberId_key" ON "whatsapp_chat_cleanup"("userId", "numberId");

-- CreateIndex
CREATE INDEX "whatsapp_chat_cleanup_enabled_idx" ON "whatsapp_chat_cleanup"("enabled");

-- AddForeignKey
ALTER TABLE "whatsapp_chat_cleanup" ADD CONSTRAINT "whatsapp_chat_cleanup_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
