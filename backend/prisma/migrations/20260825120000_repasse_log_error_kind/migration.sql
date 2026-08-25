-- O log de repasse já dizia QUE o link foi descartado, mas o porquê era texto
-- livre: não dava pra filtrar, nem contar, nem perceber que 10 descartes
-- seguidos eram o MESMO problema (o ML recusando tudo por CAPTCHA em 25/08/2026).
--
-- `errorKind` é o motivo em lista fechada (ver backend/repasse/error-kinds.js).
-- Ele NÃO substitui `reason`: o texto humano continua ao lado, com o detalhe do
-- caso (qual campo faltou, o que o navegador viu na tela).
--
-- `stage` é até onde o link chegou no pipeline. É o que deixa a UI escrever
-- "não chegou nessa etapa" em vez de um traço solto que parece defeito.

ALTER TABLE "repasse_capture_log" ADD COLUMN IF NOT EXISTS "errorKind" TEXT;
ALTER TABLE "repasse_capture_log" ADD COLUMN IF NOT EXISTS "stage" TEXT;

-- Índice por motivo: serve o filtro novo do painel.
CREATE INDEX IF NOT EXISTS "repasse_capture_log_errorKind_createdAt_idx"
  ON "repasse_capture_log" ("errorKind", "createdAt" DESC);

-- Índice só por data: o resumo do topo agrega uma janela GLOBAL ("últimas 24h",
-- sem filtro de campanha). Os índices que já existiam começam por groupId/userId
-- e não servem pra essa varredura — sem este, o resumo vira seq scan.
CREATE INDEX IF NOT EXISTS "repasse_capture_log_createdAt_idx"
  ON "repasse_capture_log" ("createdAt" DESC);

-- Backfill: classifica o que já está gravado a partir do texto livre, senão o
-- resumo nasceria cego justamente no incidente que motivou esta mudança. Os
-- padrões abaixo espelham classifyFromText() de repasse/error-kinds.js — há
-- teste de paridade entre os dois. Ordem importa: o primeiro UPDATE que casar
-- vence (os seguintes exigem errorKind IS NULL).
UPDATE "repasse_capture_log" SET "errorKind" = 'captcha'
  WHERE "outcome" = 'discarded' AND "errorKind" IS NULL
    AND ("reason" ILIKE '%captcha%' OR "reason" ILIKE '%verificação%' OR "reason" ILIKE '%verificacao%');

UPDATE "repasse_capture_log" SET "errorKind" = 'login-wall'
  WHERE "outcome" = 'discarded' AND "errorKind" IS NULL
    AND ("reason" ILIKE '%pediu login%' OR "reason" ILIKE '%acesse sua conta%' OR "reason" ILIKE '%bloqueio anti-bot (login)%');

UPDATE "repasse_capture_log" SET "errorKind" = 'loja-nao-suportada'
  WHERE "outcome" = 'discarded' AND "errorKind" IS NULL
    AND ("reason" ILIKE '%loja não suportada%' OR "reason" ILIKE '%link não reconhecido%');

UPDATE "repasse_capture_log" SET "errorKind" = 'afiliado-ausente'
  WHERE "outcome" = 'discarded' AND "errorKind" IS NULL
    AND "reason" ILIKE '%não configurado%';

UPDATE "repasse_capture_log" SET "errorKind" = 'timeout'
  WHERE "outcome" = 'discarded' AND "errorKind" IS NULL
    AND ("reason" ILIKE '%timeout%' OR "reason" ILIKE '%ETIMEDOUT%');

UPDATE "repasse_capture_log" SET "errorKind" = 'nao-e-produto'
  WHERE "outcome" = 'discarded' AND "errorKind" IS NULL
    AND ("reason" ILIKE '%dados insuficientes%' OR "reason" ILIKE '%não foi possível encontrar%' OR "reason" ILIKE '%produto não encontrado%');

-- `stage` fica NULL nas linhas antigas DE PROPÓSITO: não dá pra saber com certeza
-- onde elas pararam, e chutar faria a UI mentir. Linha sem stage cai no
-- comportamento de antes (traço), e só as novas ganham o "não chegou nessa etapa".
