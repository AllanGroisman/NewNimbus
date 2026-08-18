-- O cupom capturado na legenda do grupo líder já seguia junto do produto até o
-- envio, mas não ficava no log de captura: dava pra ver o link, o produto e o
-- destino (fila/pendente/descarte) e não dava pra saber se a mensagem trazia um
-- cupom, nem qual. Sem retroatividade — as linhas antigas ficam NULL, que aqui
-- significa "não se sabe", e não "não tinha cupom".
--
-- IF NOT EXISTS de propósito: os bancos de dev e de teste desta máquina já têm a
-- coluna, criada em 12/08/2026 pelas migrations 20260812135540_ml_coupons e
-- 20260812200229_ml_coupon_codes — que estão registradas como aplicadas mas
-- perderam o migration.sql (as pastas ficaram vazias e nunca entraram no git).
-- Em banco novo esta migration cria a coluna; nos que já a têm, é no-op.

ALTER TABLE "repasse_capture_log" ADD COLUMN IF NOT EXISTS "coupon" TEXT;
