const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const DATA_DIR = process.env.NIMBUS_DATA_DIR || path.join(__dirname, "..", "data");
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

async function readFromDisk(userId) {
  const f = fileFor(userId);
  try {
    const raw = JSON.parse(await fsp.readFile(f, "utf-8"));
    return { ...EMPTY_STATE, ...raw };
  } catch (err) {
    if (err.code === "ENOENT") return { ...EMPTY_STATE };
    console.warn(`[storage] state corrompido para ${userId}: ${err.message}`);
    return { ...EMPTY_STATE };
  }
}

async function writeToDisk(userId, state) {
  const f = fileFor(userId);
  const tmp = f + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(state, null, 2));
  await fsp.rename(tmp, f);
}

async function loadState(userId) {
  return readFromDisk(userId);
}

// Save vindo do frontend — preserva campos operacionais do disco
function saveState(userId, incoming) {
  if (!incoming || typeof incoming !== "object") throw new Error("state inválido");
  return withLock(userId, async () => {
    const existing = await readFromDisk(userId);
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
    await writeToDisk(userId, merged);
    return merged;
  });
}

// Save vindo do scheduler — atualiza um campo específico de um grupo,
// preservando tudo que o frontend pode ter mexido.
function updateGroupOps(userId, groupId, patch) {
  return withLock(userId, async () => {
    const state = await readFromDisk(userId);
    const i = (state.groups || []).findIndex(g => g.id === groupId);
    if (i < 0) return null;
    state.groups[i] = { ...state.groups[i], ...patch };
    state.updatedAt = new Date().toISOString();
    await writeToDisk(userId, state);
    return state.groups[i];
  });
}

async function listAllUserIds() {
  try {
    const files = await fsp.readdir(STATE_DIR);
    return files
      .filter(f => f.endsWith(".json") && !f.endsWith(".tmp"))
      .map(f => f.replace(/\.json$/, ""));
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

function clearState(userId) {
  return withLock(userId, async () => {
    const f = fileFor(userId);
    await fsp.unlink(f).catch(err => { if (err.code !== "ENOENT") throw err; });
  });
}

// Devolve apenas dados operacionais (para polling do frontend)
async function loadOps(userId) {
  const s = await readFromDisk(userId);
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
