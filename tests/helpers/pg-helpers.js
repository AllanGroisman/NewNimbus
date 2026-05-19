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
  const list = TABLES.map(t => `"${t}"`).join(", ");
  await db.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

async function disconnectDb() {
  await disconnect();
}

export { truncateAll, disconnectDb, TABLES };
