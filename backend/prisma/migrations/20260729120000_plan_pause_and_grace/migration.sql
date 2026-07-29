-- Pausa por plano: quais campanhas/números o cliente escolheu manter ATIVOS
-- deixa de ser inferido pela contagem e passa a ser estado explícito do servidor.
-- Fica em user_state porque saveState() só escreve `settings` nesta tabela — o
-- frontend nunca sobrescreve esta coluna (mesma proteção das colunas de ops).
ALTER TABLE "user_state" ADD COLUMN "planPaused" JSONB NOT NULL DEFAULT '{"groups":[],"numbers":[]}';

-- Carência de pagamento: quando a assinatura entrou em past_due/unpaid.
-- NULL = não está em atraso. Usado pelos 3 dias de tolerância antes de pausar.
ALTER TABLE "subscriptions" ADD COLUMN "pastDueSince" TIMESTAMP(3);
