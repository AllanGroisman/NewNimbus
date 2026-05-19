// Persistência JSON do módulo billing.
// Arquivo único subscriptions.json — uma row por usuário (1:1).
// webhook_events.json — set de event.id já processados (idempotência).

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const DATA_DIR = process.env.NIMBUS_DATA_DIR || path.join(__dirname, "..", "data");
const SUBS_FILE = path.join(DATA_DIR, "subscriptions.json");
const WH_FILE = path.join(DATA_DIR, "webhook_events.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Cache em memória + write atômico via .tmp
let _subsCache = null;
let _whCache = null;

function readSubs() {
  if (_subsCache) return _subsCache;
  try { _subsCache = JSON.parse(fs.readFileSync(SUBS_FILE, "utf-8")); }
  catch { _subsCache = []; }
  return _subsCache;
}

async function writeSubs(rows) {
  _subsCache = rows;
  const tmp = SUBS_FILE + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(rows, null, 2));
  await fsp.rename(tmp, SUBS_FILE);
}

function readWh() {
  if (_whCache) return _whCache;
  try { _whCache = JSON.parse(fs.readFileSync(WH_FILE, "utf-8")); }
  catch { _whCache = {}; }
  return _whCache;
}

async function writeWh(map) {
  _whCache = map;
  const tmp = WH_FILE + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(map, null, 2));
  await fsp.rename(tmp, WH_FILE);
}

function makeSub({ userId, planId = "free", status = "inactive", currentPeriodEnd = null, ...rest }) {
  return {
    id: rest.id || cryptoRandom(),
    userId,
    stripeCustomerId: rest.stripeCustomerId || null,
    stripeSubscriptionId: rest.stripeSubscriptionId || null,
    planId,
    status,
    currentPeriodEnd: currentPeriodEnd ? new Date(currentPeriodEnd).toISOString() : null,
    cancelAtPeriodEnd: !!rest.cancelAtPeriodEnd,
    createdAt: rest.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function cryptoRandom() {
  return require("crypto").randomUUID();
}

async function getByUserId(userId) {
  return readSubs().find(s => s.userId === userId) || null;
}

async function getByCustomerId(stripeCustomerId) {
  if (!stripeCustomerId) return null;
  return readSubs().find(s => s.stripeCustomerId === stripeCustomerId) || null;
}

async function getBySubscriptionId(stripeSubscriptionId) {
  if (!stripeSubscriptionId) return null;
  return readSubs().find(s => s.stripeSubscriptionId === stripeSubscriptionId) || null;
}

// Cria sub se não existir; retorna a row.
async function ensureForUser(userId, defaults = {}) {
  const rows = readSubs();
  let row = rows.find(s => s.userId === userId);
  if (row) return row;
  row = makeSub({ userId, ...defaults });
  rows.push(row);
  await writeSubs(rows);
  return row;
}

async function update(userId, patch) {
  const rows = readSubs();
  const i = rows.findIndex(s => s.userId === userId);
  if (i < 0) {
    const row = makeSub({ userId, ...patch });
    rows.push(row);
    await writeSubs(rows);
    return row;
  }
  rows[i] = { ...rows[i], ...patch, updatedAt: new Date().toISOString() };
  if (patch.currentPeriodEnd) {
    rows[i].currentPeriodEnd = new Date(patch.currentPeriodEnd).toISOString();
  }
  await writeSubs(rows);
  return rows[i];
}

// Idempotência de webhook: retorna true se já vimos esse event.id antes.
async function isWebhookProcessed(eventId) {
  const m = readWh();
  return !!m[eventId];
}

async function markWebhookProcessed(eventId, type) {
  const m = readWh();
  if (m[eventId]) return false;
  m[eventId] = { type, processedAt: new Date().toISOString() };
  await writeWh(m);
  return true;
}

module.exports = {
  getByUserId,
  getByCustomerId,
  getBySubscriptionId,
  ensureForUser,
  update,
  isWebhookProcessed,
  markWebhookProcessed,
};
