// Setup global do Playwright — cria + migra o DB de E2E antes de subir webServers.
// Rodando 1x antes da suite inteira.

import { execSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendDir = path.resolve(__dirname, "..", "..", "backend");

const DB_NAME = "nimbus_test_e2e";
const DATABASE_URL = `postgresql://nimbus:nimbus_dev@localhost:5432/${DB_NAME}?schema=public`;

export default async function globalSetup() {
  // 1. Garante que o DB existe — usa `psql -lqt` pra listar, cria via CREATE DATABASE.
  //    Idempotente: ignora se já existe.
  const checkDb = `docker exec nimbus-postgres psql -U nimbus -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'"`;
  let exists = false;
  try {
    const out = execSync(checkDb, { stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
    exists = out === "1";
  } catch (err) {
    console.error("[e2e:setup] erro consultando DB:", err.stderr?.toString() || err.message);
    throw err;
  }
  if (!exists) {
    execSync(
      `docker exec nimbus-postgres psql -U nimbus -c "CREATE DATABASE ${DB_NAME} OWNER nimbus"`,
      { stdio: "pipe" },
    );
  }

  // 2. Limpa schema (DROP + CREATE public). Cada run começa zerado.
  try {
    execSync(
      `docker exec nimbus-postgres psql -U nimbus -d ${DB_NAME} -c "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO nimbus"`,
      { stdio: "pipe" },
    );
  } catch (err) {
    console.warn("[e2e:setup] reset schema falhou (continuando):", err.stderr?.toString() || err.message);
  }

  // 3. Migra
  execSync("npx prisma migrate deploy", {
    cwd: backendDir,
    env: { ...process.env, DATABASE_URL },
    stdio: "pipe",
  });

  console.log(`[e2e:setup] DB ${DB_NAME} pronto (exists=${exists})`);
}
