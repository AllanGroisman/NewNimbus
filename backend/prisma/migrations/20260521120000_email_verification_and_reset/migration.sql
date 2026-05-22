-- Email verification + password reset (Nimbus)
-- Contas existentes ficam com emailVerified=true (grandfathered) pra não trancar
-- ninguém que já estava usando. Novas contas nascem em emailVerified=false.

ALTER TABLE "users"
  ADD COLUMN "emailVerified"        BOOLEAN      NOT NULL DEFAULT false,
  ADD COLUMN "emailVerifyToken"     TEXT,
  ADD COLUMN "emailVerifyExpires"   TIMESTAMP(3),
  ADD COLUMN "passwordResetToken"   TEXT,
  ADD COLUMN "passwordResetExpires" TIMESTAMP(3);

-- Grandfather: usuários que já existiam antes desta migration são considerados verificados.
UPDATE "users" SET "emailVerified" = true;

-- Unique constraints (tokens precisam ser únicos pra lookup direto).
CREATE UNIQUE INDEX "users_emailVerifyToken_key"   ON "users"("emailVerifyToken");
CREATE UNIQUE INDEX "users_passwordResetToken_key" ON "users"("passwordResetToken");
