const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const STATE_DIR = path.join(DATA_DIR, "state");

if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });

const EMPTY_STATE = {
  groups: [],
  numbers: [],
  whatsappGroups: [],
  settings: {},
};

function fileFor(userId) {
  // userId vem de uuid → seguro como nome de arquivo, mas sanitiza por garantia
  const safe = String(userId).replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(STATE_DIR, `${safe}.json`);
}

function loadState(userId) {
  const f = fileFor(userId);
  if (!fs.existsSync(f)) return { ...EMPTY_STATE };
  try {
    const raw = JSON.parse(fs.readFileSync(f, "utf-8"));
    return { ...EMPTY_STATE, ...raw };
  } catch (err) {
    console.warn(`[storage] state corrompido para ${userId}: ${err.message}`);
    return { ...EMPTY_STATE };
  }
}

function saveState(userId, state) {
  if (!state || typeof state !== "object") throw new Error("state inválido");
  const merged = { ...EMPTY_STATE, ...state, updatedAt: new Date().toISOString() };
  const f = fileFor(userId);
  // grava em arquivo temporário e renomeia → evita corromper se cair no meio
  const tmp = f + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2));
  fs.renameSync(tmp, f);
  return merged;
}

function clearState(userId) {
  const f = fileFor(userId);
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

module.exports = { loadState, saveState, clearState };
