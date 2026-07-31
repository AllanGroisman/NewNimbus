-- Uma conta = um CPF.
--
-- Guardamos só os 11 dígitos (sem ponto e sem traço) para o índice único
-- comparar sempre a mesma forma. A coluna é opcional porque as contas criadas
-- antes desta regra não têm documento: o UNIQUE do Postgres ignora NULL, então
-- elas convivem sem conflito e o sistema pede o CPF na primeira entrada.
ALTER TABLE "users" ADD COLUMN "cpf" TEXT;

CREATE UNIQUE INDEX "users_cpf_key" ON "users"("cpf");
