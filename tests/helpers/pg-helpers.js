// Helpers de PG para os testes — truncate de todas as tabelas entre testes
// (mais rápido que dropar/recriar schema) e disconnect global no teardown.
//
// Ordem do TRUNCATE não importa porque usamos CASCADE.

import "./env.js";
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

const backendDir = path.resolve(__dirname, "..", "..", "backend");
const { prisma, disconnect } = require(path.join(backendDir, "db.js"));

// Lista exaustiva — sincronizar com schema.prisma. Se uma tabela nova entrar,
// adicionar aqui pra ser limpa entre testes.
const TABLES = [
  "subscriptions",
  "webhook_events",
  "email_log",
  "group_history",
  "group_queue",
  "group_pending",
  "groups",
  "whatsapp_groups",
  "whatsapp_numbers",
  "baileys_auth",
  "affiliate_config",
  "user_state",
  "users",
  "catalog_products",
  "app_config",
];

async function truncateAll() {
  const db = prisma();

  // GUARDA DE SEGURANÇA: só truncamos um banco de TESTE. Se por qualquer motivo
  // (ex.: loadEnv sobrescrevendo DATABASE_URL) o client conectar no banco de DEV
  // (nimbus) ou PROD, abortamos — truncar ali apagaria dados reais.
  const [{ current_database: dbName }] = await db.$queryRawUnsafe("SELECT current_database()");
  if (!/test/i.test(dbName)) {
    throw new Error(
      `[pg-helpers] RECUSADO truncar banco "${dbName}" — não parece banco de teste. ` +
      `A suite deve rodar contra nimbus_test (veja tests/helpers/env.js). Abortando pra proteger dados.`
    );
  }

  const list = TABLES.map(t => `"${t}"`).join(", ");
  await db.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
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

export { truncateAll, disconnectDb, seedSubscription, TABLES };
