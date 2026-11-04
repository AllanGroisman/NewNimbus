-- Lista branca/negra de palavras do repasse (repasse/word-filter.js): o veredito
-- do filtro em cada linha do log, pra aba Histórico → Filtro de palavras da
-- campanha. Null = a campanha não tinha palavras e o filtro não rodou.
--
-- IF NOT EXISTS pelo mesmo motivo das outras migrations de repasse: os bancos de
-- dev/teste desta máquina são recriados a partir de molde.

ALTER TABLE "repasse_capture_log" ADD COLUMN IF NOT EXISTS "wordFilter" TEXT;
ALTER TABLE "repasse_capture_log" ADD COLUMN IF NOT EXISTS "wordFilterReason" TEXT;

-- Índice PARCIAL: só as linhas em que o filtro rodou, que é o que a aba lista.
CREATE INDEX IF NOT EXISTS "repasse_capture_log_groupId_wordFilter_createdAt_idx"
    ON "repasse_capture_log" ("groupId", "createdAt" DESC)
 WHERE "wordFilter" IS NOT NULL;
