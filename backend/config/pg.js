const { prisma } = require("../db");

// Cache write-through em memória. Mantemos a interface SÍNCRONA pra não obrigar
// affiliate.js / admin-scraper.js a virar async (e suas rotas idem).
// Boot: chamar `warmup()` antes de iniciar scheduler/scraper.
const _cache = new Map();

// key -> promise do upsert em vôo. Serve pra (a) `flush()` confirmar gravação
// antes de responder ao admin e (b) o auto-refresh não pisar numa escrita recente.
const _pending = new Map();

let _refreshTimer = null;

// Keys que vivem em app_config mas têm dono próprio (auth lê `jwt_secret` direto
// do banco; `affiliate` é legado do storage per-user). Ficam fora do cache pra
// não duplicar dado sensível/grande a cada refresh.
const NOT_OURS = ["jwt_secret", "affiliate"];

function get(key) {
  return _cache.has(key) ? _cache.get(key) : null;
}

// Sync: atualiza cache na hora e dispara o upsert. Quem precisa de confirmação
// (rotas PUT do admin) chama `await flush()` antes de responder.
function set(key, value) {
  _cache.set(key, value);
  const p = prisma().appConfig.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  }).finally(() => {
    if (_pending.get(key) === p) _pending.delete(key);
  });
  // Evita unhandled rejection — o erro é reportado por flush() e logado aqui.
  p.catch(err => console.error(`[app-config] set("${key}") falhou:`, err.message));
  _pending.set(key, p);
}

function del(key) {
  _cache.delete(key);
  const p = prisma().appConfig.delete({ where: { key } })
    .finally(() => {
      if (_pending.get(key) === p) _pending.delete(key);
    });
  p.catch(err => {
    if (err.code !== "P2025") console.error(`[app-config] del("${key}") falhou:`, err.message);
  });
  // P2025 (linha inexistente) não é erro real: não deve reprovar o flush().
  _pending.set(key, p.catch(err => { if (err.code !== "P2025") throw err; }));
}

// Espera as gravações em vôo terminarem. Retorna { ok, errors: [{key, message}] }.
async function flush() {
  const entries = [..._pending.entries()];
  if (!entries.length) return { ok: true, errors: [] };
  const results = await Promise.allSettled(entries.map(([, p]) => p));
  const errors = [];
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      // Erro do Prisma vem multiline e verboso; a UI mostra isso pro admin.
      const raw = r.reason?.message || String(r.reason);
      const line = raw.split("\n").map(s => s.trim()).find(Boolean) || "erro desconhecido";
      errors.push({ key: entries[i][0], message: line.slice(0, 200) });
    }
  });
  return { ok: errors.length === 0, errors };
}

// Pré-carrega o cache. Sem argumento carrega a tabela INTEIRA — a lista de keys
// hardcoded que existia aqui vivia desatualizando (ml/amazon-scraper-filters
// ficaram de fora e voltavam ao default a cada restart). A tabela é key-value
// pequena (~15 linhas), carregar tudo é trivial.
async function warmup(keys = null) {
  const where = Array.isArray(keys) && keys.length
    ? { key: { in: keys } }
    : { key: { notIn: NOT_OURS } };
  const rows = await prisma().appConfig.findMany({ where });
  for (const r of rows) _cache.set(r.key, r.value);
}

// Recarrega o cache periodicamente. O cache é por processo e server.js/worker.js
// rodam separados em modo redis: sem isso, travar uma loja no admin (server) só
// chegava no worker depois de reiniciá-lo.
function startAutoRefresh(intervalMs = 30_000) {
  if (_refreshTimer) return;
  _refreshTimer = setInterval(async () => {
    try {
      const rows = await prisma().appConfig.findMany({ where: { key: { notIn: NOT_OURS } } });
      // Não sobrescreve key com escrita em vôo — senão o refresh reverteria um
      // valor recém-salvo pelo valor antigo lido antes do upsert commitar.
      for (const r of rows) if (!_pending.has(r.key)) _cache.set(r.key, r.value);
    } catch (err) {
      console.error("[app-config] auto-refresh falhou:", err.message);
    }
  }, intervalMs);
  _refreshTimer.unref?.();
}

function stopAutoRefresh() {
  if (_refreshTimer) { clearInterval(_refreshTimer); _refreshTimer = null; }
}

// Só pra testes: a suíte de integração roda vários arquivos no mesmo processo
// (isolate: false) e limpa o banco entre eles. Sem esvaziar o cache, uma loja
// trancada num arquivo continuaria trancada no seguinte. Espera as gravações em
// vôo antes, pra nenhuma cair no banco depois da limpeza do próximo arquivo.
async function resetForTests() {
  await flush();
  _cache.clear();
}

module.exports = { get, set, del, flush, warmup, startAutoRefresh, stopAutoRefresh, resetForTests };
