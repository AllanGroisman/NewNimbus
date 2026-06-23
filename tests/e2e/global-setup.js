// Setup do DB de E2E — cria + migra o nimbus_test_e2e.
// IMPORTANTE: roda como passo SEPARADO (node e2e/global-setup.js) ANTES do
// `playwright test`, porque o webServer do Playwright sobe o backend que precisa
// do DB já existente — se isso ficasse no globalSetup, o backend tentaria conectar
// antes do DB existir e crasharia. Os scripts test:e2e* encadeiam este arquivo.

import { execSync } from "child_process";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

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

// Permite rodar direto: `node e2e/global-setup.js` (usado pelos scripts test:e2e*).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  globalSetup()
    .then(() => process.exit(0))
    .catch((err) => { console.error("[e2e:setup] falhou:", err.message); process.exit(1); });
}
