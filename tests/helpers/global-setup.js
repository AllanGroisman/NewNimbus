// globalSetup do vitest — roda 1× antes da suite (integration/journey), em
// processo separado, antes de qualquer worker existir.
//
// Faz duas coisas:
//   1. Aplica as migrations no banco molde (`nimbus_test`).
//   2. Garante N cópias dele (`nimbus_test_1..N`) — um banco por worker, que é
//      o que permite rodar os arquivos em paralelo. Ver helpers/env.js.
//
// As cópias são reaproveitadas entre execuções: só recriamos quando o molde
// ganhou migration nova. `CREATE DATABASE ... TEMPLATE` custa ~1,8 s por cópia,
// então repetir isso a cada `npm test` seria desperdício.
//
// CREATE/DROP DATABASE não roda dentro de transação e precisa estar conectado a
// OUTRO banco, por isso abrimos um PrismaClient avulso apontado pro `postgres`.
// (O backend não tem o driver `pg` solto — só o @prisma/client.)

import { execSync } from "child_process";
import { readdirSync } from "fs";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { BASE_URL, SHARDS } from "./env.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendDir = path.resolve(__dirname, "..", "..", "backend");
const require = createRequire(import.meta.url);

const TEMPLATE = "nimbus_test";

function pgUrl(dbName) {
  return BASE_URL.replace(/\/nimbus_test(\?|$)/, `/${dbName}$1`);
}

function newClient(dbName) {
  const { PrismaClient } = require(path.join(backendDir, "node_modules", "@prisma", "client"));
  return new PrismaClient({ datasourceUrl: pgUrl(dbName) });
}

async function withClient(dbName, fn) {
  const client = newClient(dbName);
  try {
    return await fn(client);
  } finally {
    await client.$disconnect().catch(() => {});
  }
}

// Quantas migrations existem no disco. Se o molde já tem todas aplicadas,
// pular o `prisma migrate deploy` economiza ~2,9 s por execução da suíte.
// Só conta diretórios: uma migration EDITADA sem virar diretório novo não é
// detectada — nesse caso use NIMBUS_FORCE_MIGRATE=1.
function migrationsOnDisk() {
  const dir = path.join(backendDir, "prisma", "migrations");
  try {
    return readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).length;
  } catch {
    return null;
  }
}

function migrateTemplate() {
  try {
    execSync("npx prisma migrate deploy", {
      cwd: backendDir,
      env: { ...process.env, DATABASE_URL: pgUrl(TEMPLATE) },
      stdio: "pipe",
    });
  } catch (err) {
    const msg = err.stderr?.toString() || err.message;
    if (!/already.*applied/i.test(msg)) {
      console.error("[global-setup] prisma migrate deploy falhou:\n", msg);
      throw err;
    }
  }
}

// Assinatura do schema = quantas migrations o banco tem aplicadas com sucesso.
// Shard com a mesma contagem do molde está em dia e pode ser reusado como está.
// O filtro importa: uma migration que já falhou e foi revertida deixa uma linha
// extra em _prisma_migrations, e contar cru daria um número maior que o de
// diretórios no disco.
async function migrationCount(dbName) {
  try {
    return await withClient(dbName, async (c) => {
      const rows = await c.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM _prisma_migrations
         WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`
      );
      return Number(rows[0].n);
    });
  } catch {
    return null; // banco não existe, ou existe sem schema
  }
}

async function ensureShards() {
  const templateCount = await migrationCount(TEMPLATE);

  const stale = [];
  for (let i = 1; i <= SHARDS; i++) {
    const name = `${TEMPLATE}_${i}`;
    if ((await migrationCount(name)) !== templateCount) stale.push(name);
  }
  if (stale.length === 0) return;

  await withClient("postgres", async (admin) => {
    for (const name of stale) {
      // Derruba conexões penduradas antes do DROP (ex.: execução anterior morta).
      await admin.$executeRawUnsafe(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
         WHERE datname = '${name}' AND pid <> pg_backend_pid()`
      );
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}"`);
      await admin.$executeRawUnsafe(`CREATE DATABASE "${name}" TEMPLATE "${TEMPLATE}"`);
    }
  });
}

export async function setup() {
  const onDisk = migrationsOnDisk();
  const applied = await migrationCount(TEMPLATE);
  const upToDate = onDisk !== null && applied !== null && onDisk === applied;

  if (process.env.NIMBUS_FORCE_MIGRATE === "1" || !upToDate) migrateTemplate();
  await ensureShards();
}

export async function teardown() {
  // No-op — os shards são reaproveitados na próxima execução.
}
