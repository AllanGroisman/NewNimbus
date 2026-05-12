const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const DATA_DIR = process.env.NIMBUS_DATA_DIR || path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Mapeamento key → arquivo. Mantém compat com arquivos legados.
const KEY_TO_FILE = {
  "affiliate": path.join(DATA_DIR, "affiliate.json"),
  "scraper-config": path.join(DATA_DIR, "scraper-config.json"),
};

function fileFor(key) {
  if (!KEY_TO_FILE[key]) {
    throw new Error(`[app-config] key desconhecida: ${key}`);
  }
  return KEY_TO_FILE[key];
}

// Cache em memória — populado por warmup() no boot e atualizado em todo set/del.
// affiliate.js e admin-scraper.js consomem get() de forma SÍNCRONA, então o IO
// real fica restrito ao boot e ao próximo write.
const _cache = new Map();

function get(key) {
  if (_cache.has(key)) return _cache.get(key);
  // Fallback síncrono pra primeira leitura (caso warmup ainda não tenha rodado)
  const f = fileFor(key);
  if (!fs.existsSync(f)) { _cache.set(key, null); return null; }
  try {
    const v = JSON.parse(fs.readFileSync(f, "utf-8"));
    _cache.set(key, v);
    return v;
  } catch (err) {
    console.warn(`[app-config] ${key} corrompido: ${err.message}`);
    _cache.set(key, null);
    return null;
  }
}

function set(key, value, opts = {}) {
  // Atualiza cache imediatamente; persiste em disco fire-and-forget (erro logado).
  _cache.set(key, value);
  const f = fileFor(key);
  const tmp = f + ".tmp";
  const writeOpts = opts.mode ? { mode: opts.mode } : undefined;
  fsp.writeFile(tmp, JSON.stringify(value, null, 2), writeOpts)
    .then(() => fsp.rename(tmp, f))
    .catch(err => console.error(`[app-config] set("${key}") falhou:`, err.message));
}

function del(key) {
  _cache.delete(key);
  const f = fileFor(key);
  fsp.unlink(f).catch(err => {
    if (err.code !== "ENOENT") console.error(`[app-config] del("${key}") falhou:`, err.message);
  });
}

// Pré-carrega o cache lendo os arquivos uma vez. Chamado no boot do server.
async function warmup(keys = ["affiliate", "scraper-config"]) {
  for (const k of keys) {
    const f = fileFor(k);
    try {
      const raw = await fsp.readFile(f, "utf-8");
      _cache.set(k, JSON.parse(raw));
    } catch (err) {
      _cache.set(k, null); // ENOENT ou corrompido — tratado como vazio
    }
  }
}

module.exports = { get, set, del, warmup };
