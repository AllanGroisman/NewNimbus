-- A aba Admin › Cupom › Repasse agrega o log de captura por cupom
-- (GROUP BY coupon, ORDER BY MAX("createdAt")). Sem índice isso é um seq scan na
-- tabela inteira, que é a que mais cresce do sistema — uma linha por link visto
-- em grupo líder.
--
-- Índice PARCIAL: a esmagadora maioria das linhas tem coupon NULL (a mensagem não
-- trazia código nenhum), e essas a consulta descarta no WHERE. Indexar só as que
-- têm cupom deixa o índice uma ordem de grandeza menor.
--
-- IF NOT EXISTS pelo mesmo motivo das outras migrations de repasse: os bancos de
-- dev/teste desta máquina são recriados a partir de molde.

CREATE INDEX IF NOT EXISTS "repasse_capture_log_coupon_createdAt_idx"
    ON "repasse_capture_log" ("coupon", "createdAt" DESC)
 WHERE "coupon" IS NOT NULL;
