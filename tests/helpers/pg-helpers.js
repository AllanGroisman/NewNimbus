// Helpers de PG para os testes — limpeza de todas as tabelas entre testes e
// disconnect global no teardown.
//
// POR QUE NÃO TRUNCATE (era o que estava aqui antes):
// TRUNCATE recria o arquivo de cada tabela e faz fsync. Nesta stack (Postgres
// em Docker com fsync=on) isso mediu ~4,3 s por chamada — e a chamada roda num
// beforeEach de CADA teste, o que sozinho colocava a suíte inteira acima de
// 50 min. O mesmo trabalho com DELETE mede ~5 ms. Ver tests/TIMING.md.
//
// `SET LOCAL session_replication_role = replica` desliga as FK triggers só
// dentro da transação, então a ordem dos DELETEs não importa (era o papel do
// CASCADE) e não há risco de violação de chave estrangeira no meio da limpeza.
//
// Sequences: TRUNCATE ... RESTART IDENTITY zerava os autoincrementos. O DELETE
// não zera, então fazemos isso à parte — mas só quando alguma linha foi de fato
// apagada.

import "./env.js";
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

const backendDir = path.resolve(__dirname, "..", "..", "backend");
const { prisma, disconnect } = require(path.join(backendDir, "db.js"));

// Tabelas que a limpeza NÃO deve tocar.
const KEEP = new Set(["_prisma_migrations"]);

// A lista vem do próprio banco, não de uma constante mantida à mão. A versão
// anterior era manual e já tinha ficado desatualizada: `repasse_capture_log`
// nunca era limpa e vazava linhas de um teste pro outro.
let tableCache = null;

async function tables(db) {
  if (tableCache) return tableCache;
  const rows = await db.$queryRawUnsafe(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
  );
  tableCache = rows.map(r => r.tablename).filter(t => !KEEP.has(t));
  return tableCache;
}

let guardChecked = false;

async function assertTestDatabase(db) {
  if (guardChecked) return;
  // GUARDA DE SEGURANÇA: só limpamos um banco de TESTE. Se por qualquer motivo
  // (ex.: loadEnv sobrescrevendo DATABASE_URL) o client conectar no banco de DEV
  // (nimbus) ou PROD, abortamos — apagar ali destruiria dados reais.
  const [{ current_database: dbName }] = await db.$queryRawUnsafe("SELECT current_database()");
  if (!/test/i.test(dbName)) {
    throw new Error(
      `[pg-helpers] RECUSADO limpar banco "${dbName}" — não parece banco de teste. ` +
      `A suite deve rodar contra nimbus_test (veja tests/helpers/env.js). Abortando pra proteger dados.`
    );
  }
  guardChecked = true;
}

async function truncateAll() {
  const db = prisma();
  await assertTestDatabase(db);
  const list = await tables(db);

  // Uma ida só ao banco: o bloco DO roda numa transação própria. Antes eram
  // ~25 statements num $transaction do Prisma (uma volta cada, ~16 ms com as
  // tabelas vazias) e mais um bloco de ALTER SEQUENCE quando havia linhas.
  // `setval(..., 1, false)` faz o mesmo que `ALTER SEQUENCE ... RESTART` sem ser DDL.
  await db.$executeRawUnsafe(`
    DO $$
    DECLARE removed bigint := 0; n bigint;
    BEGIN
      SET LOCAL session_replication_role = replica;
      ${list.map(t => `DELETE FROM "${t}"; GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;`).join("\n      ")}
      IF removed > 0 THEN
        PERFORM setval(format('%I.%I', schemaname, sequencename)::regclass, 1, false)
          FROM pg_sequences WHERE schemaname = 'public';
      END IF;
    END $$;
  `);
}

async function disconnectDb() {
  await disconnect();
}

// Dá assinatura ativa a um usuário de teste — sem ela o plano efetivo é "free"
// (0 campanhas/números) e qualquer PUT /api/state com campanhas leva 402.
async function seedSubscription(userId, planId = "pro", status = "active") {
  const db = prisma();
  const currentPeriodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  return db.subscription.upsert({
    where: { userId },
    create: { userId, planId, status, currentPeriodEnd },
    update: { planId, status, currentPeriodEnd },
  });
}

export { truncateAll, disconnectDb, seedSubscription, tables };
