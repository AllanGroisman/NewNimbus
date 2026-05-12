const { prisma } = require("../db");

// Cache write-through em memória. Mantemos a interface SÍNCRONA pra não obrigar
// affiliate.js / admin-scraper.js a virar async (e suas rotas idem).
// Boot: chamar `warmup()` antes de iniciar scheduler/scraper.
const _cache = new Map();

function get(key) {
  return _cache.has(key) ? _cache.get(key) : null;
}

// Sync: atualiza cache na hora; persistência DB é fire-and-forget (erro logado).
function set(key, value) {
  _cache.set(key, value);
  prisma().appConfig.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  }).catch(err => console.error(`[app-config] set("${key}") falhou:`, err.message));
}

function del(key) {
  _cache.delete(key);
  prisma().appConfig.delete({ where: { key } })
    .catch(err => {
      if (err.code !== "P2025") console.error(`[app-config] del("${key}") falhou:`, err.message);
    });
}

// Pré-carrega keys conhecidas. Chamar no boot do server.
async function warmup(keys = ["affiliate", "scraper-config"]) {
  const rows = await prisma().appConfig.findMany({ where: { key: { in: keys } } });
  for (const r of rows) _cache.set(r.key, r.value);
  // Marca keys ausentes como null no cache pra get() ser sempre determinístico
  for (const k of keys) if (!_cache.has(k)) _cache.set(k, null);
}

module.exports = { get, set, del, warmup };
