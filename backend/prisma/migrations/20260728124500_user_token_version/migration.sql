-- Versão de sessão: subir este número invalida os JWTs já emitidos pro usuário.
-- Usado por troca de senha, reset e suspensão pra derrubar sessões abertas.
ALTER TABLE "users" ADD COLUMN "tokenVersion" INTEGER NOT NULL DEFAULT 0;
