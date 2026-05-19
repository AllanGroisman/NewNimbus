// globalSetup do vitest — roda 1× antes da suite inteira, em processo separado.
// Aplica migrations no DB de teste pra garantir schema atualizado.

import { execSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendDir = path.resolve(__dirname, "..", "..", "backend");

const TEST_DATABASE_URL =
  process.env.NIMBUS_TEST_DATABASE_URL ||
  "postgresql://nimbus:nimbus_dev@localhost:5432/nimbus_test?schema=public";

export async function setup() {
  // Aplica migrations no DB de teste. Idempotente — sai rápido se já tá no head.
  try {
    execSync("npx prisma migrate deploy", {
      cwd: backendDir,
      env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
      stdio: "pipe",
    });
  } catch (err) {
    // Se já estiver aplicado, prisma sai com sucesso. Se falhar de verdade,
    // re-lança pra a suite abortar com mensagem clara.
    const msg = err.stderr?.toString() || err.message;
    if (!/already.*applied/i.test(msg)) {
      console.error("[global-setup] prisma migrate deploy falhou:\n", msg);
      throw err;
    }
  }
}

export async function teardown() {
  // No-op por enquanto — não derrubamos o container do PG (é dev).
}
