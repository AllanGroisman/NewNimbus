// Setup de ambiente — DEVE ser importado ANTES de qualquer modulo do backend.
// A partir desta versão, a suite roda em modo PG (STORAGE_BACKEND=pg) contra
// um database separado (`nimbus_test`) na mesma instância Postgres do dev.
//
// Pré-requisitos:
//   - Postgres rodando em localhost:5432 (docker compose up -d)
//   - Database `nimbus_test` criada com schema migrado (npm test cuida disso
//     via prisma migrate deploy no setup global)
//
// Isolamento: cada arquivo de teste roda em worker isolado (vitest pool=forks +
// isolate=true). O helper `truncateAll()` em pg-helpers.js limpa todas as
// tabelas antes de cada teste pra garantir que workers paralelos não vejam
// dados uns dos outros. Único compartilhado é o schema.

import os from "os";
import path from "path";
import fs from "fs";
import crypto from "crypto";

const TMP_ROOT = path.join(os.tmpdir(), `nimbus-test-${crypto.randomBytes(6).toString("hex")}`);
fs.mkdirSync(TMP_ROOT, { recursive: true });

const TEST_DATABASE_URL =
  process.env.NIMBUS_TEST_DATABASE_URL ||
  "postgresql://nimbus:nimbus_dev@localhost:5432/nimbus_test?schema=public";

process.env.NODE_ENV = "test";
process.env.STORAGE_BACKEND = "pg";
process.env.QUEUE_BACKEND = "memory";
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.NIMBUS_DATA_DIR = TMP_ROOT; // ainda usado por auth_states (Baileys) e jwt secret
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-only-for-tests";
process.env.LOG_LEVEL = process.env.LOG_LEVEL || "error";

export { TMP_ROOT, TEST_DATABASE_URL };
