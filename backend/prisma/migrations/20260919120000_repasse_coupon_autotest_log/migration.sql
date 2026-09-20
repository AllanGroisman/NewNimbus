-- O diário do teste automático de cupom do repasse: uma linha por TENTATIVA.
--
-- Tabela nova em vez de colunas em `repasse_capture_log` porque lá as colunas de
-- captura (groupId, userId, waJid, rawUrl) são NOT NULL e um teste de palavra não
-- tem nenhuma delas — e porque a aba Admin › Cupom › Repasse agrega aquele log por
-- cupom com COUNT(*), então cada evento de teste apareceria como uma "captura".
--
-- IF NOT EXISTS pelo mesmo motivo das outras migrations de repasse: os bancos de
-- dev/teste desta máquina são recriados a partir de molde.

CREATE TABLE IF NOT EXISTS "repasse_coupon_autotest" (
    "id"          BIGSERIAL    NOT NULL,
    "code"        TEXT         NOT NULL,
    "action"      TEXT         NOT NULL,
    "ok"          BOOLEAN      NOT NULL,
    "verdict"     TEXT,
    "campaign_id" TEXT,
    "produtos"    INTEGER,
    "error_kind"  TEXT,
    "message"     TEXT,
    "duration_ms" INTEGER,
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "repasse_coupon_autotest_pkey" PRIMARY KEY ("id")
);

-- A tela abre sempre pelo mais recente; o segundo índice é o "histórico deste
-- cupom" que a linha expandida da aba pede.
CREATE INDEX IF NOT EXISTS "repasse_coupon_autotest_created_at_idx"
    ON "repasse_coupon_autotest" ("created_at" DESC);

CREATE INDEX IF NOT EXISTS "repasse_coupon_autotest_code_created_at_idx"
    ON "repasse_coupon_autotest" ("code", "created_at" DESC);
