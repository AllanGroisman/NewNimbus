// Storage per-user em Postgres (tabela affiliate_config).
// Cache sync write-through (Map<userId, raw>). Mantemos interface SÍNCRONA pra
// affiliate.js não precisar virar async — IO é fire-and-forget.

const { prisma } = require("../../db");

const _cache = new Map();

// userId → upsert/delete em vôo, e quando foi a última escrita deste processo.
// O auto-refresh pula esses usuários: senão uma leitura que começou antes da
// gravação devolveria o valor antigo por cima do recém-salvo.
const _pending = new Map();
const _writtenAt = new Map();

let _refreshTimer = null;

function track(userId, p) {
  _writtenAt.set(userId, Date.now());
  const done = p.finally(() => { if (_pending.get(userId) === done) _pending.delete(userId); });
  done.catch(() => {});
  _pending.set(userId, done);
}

function getRaw(userId) {
  if (!userId) return {};
  return _cache.get(userId) || {};
}

function setRaw(userId, value) {
  if (!userId) throw new Error("setRaw exige userId");
  _cache.set(userId, value);
  const p = prisma().affiliateConfig.upsert({
    where: { userId },
    create: { userId, data: value },
    update: { data: value },
  });
  p.catch(err => console.error(`[affiliate-store] set("${userId}") falhou:`, err.message));
  track(userId, p);
}

function clear(userId) {
  if (!userId) return;
  _cache.delete(userId);
  const p = prisma().affiliateConfig.delete({ where: { userId } });
  p.catch(err => {
    if (err.code !== "P2025") console.error(`[affiliate-store] clear("${userId}") falhou:`, err.message);
  });
  track(userId, p);
}

// Espera as gravações em vôo deste processo (os testes precisam do banco em dia).
async function flush() {
  await Promise.allSettled([..._pending.values()]);
}

async function warmup() {
  const rows = await prisma().affiliateConfig.findMany();
  for (const r of rows) _cache.set(r.userId, r.data || {});
}

// Relê a tabela e aplica no cache o que mudou. Devolve os userIds alterados
// (inclusive os que sumiram do banco), e chama `onChange` pra cada um.
async function refresh(onChange = null) {
  const inicio = Date.now();
  const rows = await prisma().affiliateConfig.findMany();
  const recente = (userId) => _pending.has(userId) || (_writtenAt.get(userId) || 0) >= inicio;
  const mudou = [];
  const vistos = new Set();
  for (const r of rows) {
    vistos.add(r.userId);
    if (recente(r.userId)) continue;
    const data = r.data || {};
    if (JSON.stringify(_cache.get(r.userId)) === JSON.stringify(data)) continue;
    _cache.set(r.userId, data);
    mudou.push(r.userId);
  }
  for (const userId of [..._cache.keys()]) {
    if (vistos.has(userId) || recente(userId)) continue;
    _cache.delete(userId);
    mudou.push(userId);
  }
  if (onChange) {
    for (const userId of mudou) {
      try { onChange(userId); } catch (err) { console.error("[affiliate-store] onChange falhou:", err.message); }
    }
  }
  return mudou;
}

// O cache é por processo, e quem grava é o server (rotas da aba de afiliado)
// enquanto quem gera o link é o worker. Sem isso, trocar a TAG ou recolar o
// cookie só chegava no worker depois de reiniciá-lo.
function startAutoRefresh(intervalMs = 30_000, onChange = null) {
  if (_refreshTimer) return;
  _refreshTimer = setInterval(() => {
    refresh(onChange).catch(err => console.error("[affiliate-store] auto-refresh falhou:", err.message));
  }, intervalMs);
  _refreshTimer.unref?.();
}

function stopAutoRefresh() {
  if (_refreshTimer) { clearInterval(_refreshTimer); _refreshTimer = null; }
}

module.exports = { getRaw, setRaw, clear, warmup, flush, refresh, startAutoRefresh, stopAutoRefresh };
