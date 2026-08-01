-- Log dos e-mails transacionais (cobrança e segurança).
--
-- "dedupeKey" UNIQUE é o coração da tabela: quem consegue inserir manda o
-- e-mail, quem bate em conflito descobre que outro processo já mandou. Sem
-- isso, uma reentrega de webhook do Stripe ou uma segunda rodada do job de
-- lembretes repetiria o mesmo aviso para o cliente.
--
-- Sem FK para "users": apagar a conta apaga em cascade, e o histórico de envio
-- precisa sobreviver a isso (é o que responde ao "não recebi o e-mail").
CREATE TABLE "email_log" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "kind" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "email_log_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "email_log_dedupeKey_key" ON "email_log"("dedupeKey");

CREATE INDEX "email_log_userId_kind_createdAt_idx" ON "email_log"("userId", "kind", "createdAt");
