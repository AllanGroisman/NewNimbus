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

// Campos por grupo que SÓ o scheduler escreve — preservados em todo save.
const OPS_FIELDS = ["queue", "pending", "history", "sentToday", "sentWeek", "weekData", "lastSend", "avgDiscount"];

function fileFor(userId) {
  const safe = String(userId).replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(STATE_DIR, `${safe}.json`);
}

// Mutex por userId — serializa leituras+escritas. Evita corrida entre
// frontend (auto-save com debounce) e scheduler (loop periódico).
const locks = new Map();
function withLock(userId, fn) {
  const prev = locks.get(userId) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(userId, next.catch(() => {}));
  return next;
}

function readFromDisk(userId) {
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

function writeToDisk(userId, state) {
  const f = fileFor(userId);
  const tmp = f + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, f);
}

function loadState(userId) {
  return readFromDisk(userId);
}

// Save vindo do frontend — preserva campos operacionais do disco
function saveState(userId, incoming) {
  if (!incoming || typeof incoming !== "object") throw new Error("state inválido");
  return withLock(userId, () => {
    const existing = readFromDisk(userId);
    const existingGroupsById = new Map((existing.groups || []).map(g => [g.id, g]));

    const mergedGroups = (incoming.groups || []).map(g => {
      const old = existingGroupsById.get(g.id);
      if (!old) return g;
      const preserved = {};
      for (const f of OPS_FIELDS) {
        if (old[f] !== undefined) preserved[f] = old[f];
      }
      return { ...g, ...preserved };
    });

    const merged = {
      ...EMPTY_STATE,
      ...existing,
      ...incoming,
      groups: mergedGroups,
      updatedAt: new Date().toISOString(),
    };
    writeToDisk(userId, merged);
    return merged;
  });
}

// Save vindo do scheduler — atualiza um campo específico de um grupo,
// preservando tudo que o frontend pode ter mexido.
function updateGroupOps(userId, groupId, patch) {
  return withLock(userId, () => {
    const state = readFromDisk(userId);
    const i = (state.groups || []).findIndex(g => g.id === groupId);
    if (i < 0) return null;
    state.groups[i] = { ...state.groups[i], ...patch };
    state.updatedAt = new Date().toISOString();
    writeToDisk(userId, state);
    return state.groups[i];
  });
}

function listAllUserIds() {
  if (!fs.existsSync(STATE_DIR)) return [];
  return fs.readdirSync(STATE_DIR)
    .filter(f => f.endsWith(".json") && !f.endsWith(".tmp"))
    .map(f => f.replace(/\.json$/, ""));
}

function clearState(userId) {
  return withLock(userId, () => {
    const f = fileFor(userId);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  });
}

// Devolve apenas dados operacionais (para polling do frontend)
function loadOps(userId) {
  const s = readFromDisk(userId);
  const groups = (s.groups || []).map(g => {
    const ops = { id: g.id };
    for (const f of OPS_FIELDS) ops[f] = g[f];
    return ops;
  });
  return { groups, updatedAt: s.updatedAt || null };
}

module.exports = {
  loadState,
  saveState,
  updateGroupOps,
  loadOps,
  clearState,
  listAllUserIds,
  OPS_FIELDS,
};
