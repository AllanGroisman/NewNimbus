#!/usr/bin/env node
// Migra sessões Baileys de auth_states/<userId>/<numberId>/*.json pra Postgres
// (tabela baileys_auth). Idempotente — re-rodar sobrescreve.
//
// Uso:
//   node scripts/migrate-auth-to-pg.js              # commit
//   node scripts/migrate-auth-to-pg.js --dry-run    # preview
//
// Pré-requisitos:
//   STORAGE_BACKEND=pg
//   DATABASE_URL definida e schema migrado (npx prisma migrate dev/deploy)

require("dotenv").config();

if ((process.env.STORAGE_BACKEND || "json").toLowerCase() !== "pg") {
  console.error("Defina STORAGE_BACKEND=pg pra rodar este script.");
  process.exit(1);
}

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { BufferJSON } = require("@whiskeysockets/baileys");
const { prisma } = require("../db");

const AUTH_DIR = path.join(__dirname, "..", "auth_states");
const DRY = process.argv.includes("--dry-run");

// Mapping: nome do arquivo (sem .json) → { keyType, keyId }
//   "creds.json"                 → creds, ""
//   "pre-key-1234.json"          → pre-key, 1234
//   "session-12345@s.json"       → session, 12345@s
//   "sender-key-...json"         → sender-key, ...
//   "app-state-sync-key-...json" → app-state-sync-key, ...
//   "app-state-sync-version-..." → app-state-sync-version, ...
function parseFilename(filename) {
  if (!filename.endsWith(".json")) return null;
  const base = filename.slice(0, -5);
  if (base === "creds") return { keyType: "creds", keyId: "" };
  // tipos conhecidos do baileys
  const types = ["pre-key", "session", "sender-key-memory", "sender-key", "app-state-sync-version", "app-state-sync-key"];
  for (const t of types) {
    if (base.startsWith(t + "-")) {
      return { keyType: t, keyId: base.slice(t.length + 1) };
    }
  }
  // fallback genérico
  const dash = base.lastIndexOf("-");
  if (dash > 0) return { keyType: base.slice(0, dash), keyId: base.slice(dash + 1) };
  return { keyType: base, keyId: "" };
}

async function migrateSession(userId, numberId) {
  const dir = path.join(AUTH_DIR, userId, numberId);
  const sessionId = `${userId}::${numberId}`;
  const files = await fsp.readdir(dir);
  let count = 0;
  for (const filename of files) {
    const parsed = parseFilename(filename);
    if (!parsed) { console.warn(`  skip: ${filename}`); continue; }
    const full = path.join(dir, filename);
    const raw = await fsp.readFile(full, "utf8");
    // Validate JSON parses (com BufferJSON.reviver) — confirma integridade
    try {
      JSON.parse(raw, BufferJSON.reviver);
    } catch (e) {
      console.warn(`  ${filename}: JSON inválido — pulando (${e.message})`);
      continue;
    }
    if (DRY) {
      console.log(`  [dry] ${parsed.keyType}/${parsed.keyId || "(empty)"}  ← ${filename}`);
      count++;
      continue;
    }
    await prisma().baileysAuth.upsert({
      where: { sessionId_keyType_keyId: { sessionId, keyType: parsed.keyType, keyId: parsed.keyId } },
      create: { sessionId, keyType: parsed.keyType, keyId: parsed.keyId, value: raw },
      update: { value: raw },
    });
    count++;
  }
  return count;
}

async function main() {
  if (!fs.existsSync(AUTH_DIR)) {
    console.log("Sem auth_states/ — nada a migrar.");
    return;
  }
  const userDirs = (await fsp.readdir(AUTH_DIR, { withFileTypes: true }))
    .filter(d => d.isDirectory()).map(d => d.name);
  let total = 0;
  for (const userId of userDirs) {
    const userPath = path.join(AUTH_DIR, userId);
    const numbers = (await fsp.readdir(userPath, { withFileTypes: true }))
      .filter(d => d.isDirectory()).map(d => d.name);
    for (const numberId of numbers) {
      console.log(`Sessão ${userId}::${numberId}`);
      const c = await migrateSession(userId, numberId);
      console.log(`  → ${c} chaves`);
      total += c;
    }
  }
  console.log(`\n${DRY ? "[dry-run] " : ""}Total: ${total} chaves migradas`);
  console.log(`\nPróximo passo:`);
  console.log(`  - Reinicie o worker — ele vai começar a usar baileys_auth automaticamente`);
  console.log(`  - Quando confirmar que sessão tá funcionando, mover auth_states/ pra backup`);
}

main()
  .catch(err => { console.error("Falha:", err); process.exit(1); })
  .finally(() => prisma().$disconnect());
