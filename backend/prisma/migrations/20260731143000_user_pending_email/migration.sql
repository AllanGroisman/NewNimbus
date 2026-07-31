-- Troca de email confirmada no endereço novo.
--
-- O email é a identidade de login, então trocar direto é arriscado: um erro de
-- digitação tranca a pessoa fora da conta. O endereço novo fica estacionado em
-- pending_email até alguém clicar no link enviado PARA ELE; só então vira o
-- email de verdade. O token é único (é o que identifica o pedido); o endereço
-- pendente não é — dois usuários podem pedir o mesmo, e quem confirmar primeiro
-- leva, porque o UNIQUE de "email" barra o segundo na confirmação.
ALTER TABLE "users" ADD COLUMN "pendingEmail" TEXT;
ALTER TABLE "users" ADD COLUMN "pendingEmailToken" TEXT;
ALTER TABLE "users" ADD COLUMN "pendingEmailExpires" TIMESTAMP(3);

CREATE UNIQUE INDEX "users_pendingEmailToken_key" ON "users"("pendingEmailToken");
