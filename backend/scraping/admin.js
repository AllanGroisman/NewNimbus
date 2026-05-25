const { scrapeOfertas, CATEGORIES, STORES } = require("./scraper");
const catalog = require("../catalog");
const appConfig = require("../config");
const adminNotifier = require("../notifications/admin-notifier");

const DEFAULT_CONFIG = {
  enabled: false,
  intervalMinutes: 360,                                  // 6h
  categories: Object.keys(CATEGORIES),                   // todas
  sources: Object.keys(STORES),                          // ml, amazon
  limitPerCategory: 200,
  pruneAfterDays: 30,
};

// _status vive em memória mas tem cópia persistida em appConfig (chave STATUS_KEY)
// pra sobreviver a reboots do backend. `running` e `nextRunAt` não são persistidos
// (transitórios — reset no boot).
const STATUS_KEY = "scraper-status";

let _status = {
  running: false,
  canceling: false,         // pedido de cancelamento em andamento
  lastRun: null,            // ISO
  lastDuration: null,       // ms
  lastResult: null,         // { inserted, updated, total, perCategory: { gamer-ml: { ... } } }
  lastError: null,
  nextRunAt: null,
};

let _interval = null;
let _runPromise = null;
let _cancelRequested = false;

function loadPersistedStatus() {
  const saved = appConfig.get(STATUS_KEY);
  if (saved && typeof saved === "object") {
    _status.lastRun = saved.lastRun || null;
    _status.lastDuration = saved.lastDuration || null;
    _status.lastResult = saved.lastResult || null;
    _status.lastError = saved.lastError || null;
  }
}

function persistStatus() {
  appConfig.set(STATUS_KEY, {
    lastRun: _status.lastRun,
    lastDuration: _status.lastDuration,
    lastResult: _status.lastResult,
    lastError: _status.lastError,
  });
}

function readConfig() {
  const raw = appConfig.get("scraper-config");
  if (!raw) return { ...DEFAULT_CONFIG };
  return { ...DEFAULT_CONFIG, ...raw };
}

function writeConfig(cfg) {
  const merged = { ...readConfig(), ...cfg };
  // Validações básicas
  merged.intervalMinutes = Math.max(5, Number(merged.intervalMinutes) || DEFAULT_CONFIG.intervalMinutes);
  merged.limitPerCategory = Math.max(10, Number(merged.limitPerCategory) || DEFAULT_CONFIG.limitPerCategory);
  merged.categories = Array.isArray(merged.categories)
    ? merged.categories.filter(c => CATEGORIES[c])
    : DEFAULT_CONFIG.categories;
  merged.sources = Array.isArray(merged.sources)
    ? merged.sources.filter(s => STORES[s])
    : DEFAULT_CONFIG.sources;
  merged.enabled = !!merged.enabled;
  merged.pruneAfterDays = Math.max(1, Number(merged.pruneAfterDays) || DEFAULT_CONFIG.pruneAfterDays);

  appConfig.set("scraper-config", merged);
  scheduleNext();
  return merged;
}

function status() {
  const cfg = readConfig();
  return {
    config: cfg,
    ..._status,
  };
}

// Roda uma vez: para cada (categoria × loja), faz scrape e dá upsert no catálogo.
async function runOnce() {
  if (_runPromise) return _runPromise;
  const cfg = readConfig();
  if (!cfg.categories.length || !cfg.sources.length) {
    throw new Error("Configure ao menos 1 categoria e 1 loja");
  }

  _cancelRequested = false;
  _runPromise = (async () => {
    _status.running = true;
    _status.canceling = false;
    _status.lastError = null;
    const t0 = Date.now();
    const perCategory = {};
    let totalInserted = 0, totalUpdated = 0;
    let cancelled = false;

    try {
      outer:
      for (const cat of cfg.categories) {
        for (const src of cfg.sources) {
          // Cancelamento: verificado entre cada (categoria × loja). Não interrompe
          // um scrape já em andamento, mas impede que os próximos comecem.
          if (_cancelRequested) { cancelled = true; break outer; }
          const tag = `${cat}-${src}`;
          try {
            console.log(`[admin-scraper] ${tag}: iniciando...`);
            const products = await scrapeOfertas({
              category: cat,
              sources: [src],
              limit: cfg.limitPerCategory,
            });
            // Marca a categoria EXPLICITAMENTE — o scraper às vezes devolve categoria
            // como objeto {label, mlCode, ...}; aqui forçamos string id.
            const tagged = products.map(p => ({ ...p, category: cat }));
            const r = await catalog.upsertProducts(tagged);
            perCategory[tag] = { ok: true, count: products.length, inserted: r.inserted, updated: r.updated };
            totalInserted += r.inserted;
            totalUpdated += r.updated;
            console.log(`[admin-scraper] ${tag}: +${r.inserted} novos, ${r.updated} atualizados`);
          } catch (err) {
            console.error(`[admin-scraper] ${tag} falhou:`, err.message);
            perCategory[tag] = { ok: false, error: err.message };
          }
        }
      }

      if (cancelled) {
        // Run incompleto: NÃO faz prune/purge. O purge remove tudo que não foi
        // visto hoje — se rodasse aqui, apagaria categorias que nem chegaram a ser
        // scrapeadas por causa do cancelamento. Reporta só o que entrou até agora.
        console.log(`[admin-scraper] cancelado pelo admin — pulando prune/purge`);
        const total = await catalog.getStats().then(s => s.total).catch(() => null);
        _status.lastResult = {
          inserted: totalInserted,
          updated: totalUpdated,
          total,
          pruned: 0,
          cancelled: true,
          perCategory,
        };
      } else {
        // Limpa produtos antigos (limite máximo, default 30 dias)
        const pruned = await catalog.prune(cfg.pruneAfterDays);
        console.log(`[admin-scraper] prune: -${pruned.removed} antigos, total ${pruned.total}`);

        // Após cada run, descarta tudo que NÃO foi visto hoje — assim o catálogo
        // só guarda o que veio na rodada atual (e em rodadas anteriores do mesmo dia).
        // Isso atende ao requisito "ao realizar um scrap, exclui itens do dia anterior"
        // e elimina duplicatas residuais (a chave já é única, mas variantes antigas somem).
        const startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);
        const purged = await catalog.pruneBeforeDate(startOfToday);
        if (purged.removed > 0) {
          console.log(`[admin-scraper] purge dia anterior: -${purged.removed}, total ${purged.total}`);
        }

        _status.lastResult = {
          inserted: totalInserted,
          updated: totalUpdated,
          total: purged.total,
          pruned: pruned.removed + purged.removed,
          perCategory,
        };
      }
    } catch (err) {
      _status.lastError = err.message;
      console.error(`[admin-scraper] erro fatal:`, err.message);
    } finally {
      _status.running = false;
      _status.canceling = false;
      _cancelRequested = false;
      _status.lastRun = new Date().toISOString();
      _status.lastDuration = Date.now() - t0;
      _runPromise = null;
      persistStatus();
      scheduleNext();
      adminNotifier.notifyScrapingResult(_status).catch(err =>
        console.error("[admin-scraper] notifyScrapingResult:", err.message)
      );
    }
    return _status.lastResult;
  })();
  return _runPromise;
}

// Solicita o cancelamento do run em andamento. O scrape atual (categoria × loja)
// termina, mas os próximos não começam — o run encerra logo em seguida.
// Retorna { ok, message }.
function cancel() {
  if (!_status.running) {
    return { ok: false, message: "Nenhum scraping em execução" };
  }
  _cancelRequested = true;
  _status.canceling = true;
  console.log("[admin-scraper] cancelamento solicitado");
  return { ok: true, message: "Cancelamento solicitado — encerrando após o item atual" };
}

// Agenda o próximo run baseado em `lastRun + intervalMinutes`, não em `now`.
// Se já passou da hora (ex: backend ficou off, ou está bootando depois do prazo),
// dispara imediatamente. Caso contrário, agenda só o restante do intervalo.
// Usa setTimeout single-shot — o `finally` de runOnce reagenda via scheduleNext().
function scheduleNext() {
  if (_interval) { clearTimeout(_interval); _interval = null; }
  const cfg = readConfig();
  if (!cfg.enabled) {
    _status.nextRunAt = null;
    return;
  }
  const intervalMs = cfg.intervalMinutes * 60 * 1000;
  const lastMs = _status.lastRun ? new Date(_status.lastRun).getTime() : 0;
  const dueAt = lastMs ? lastMs + intervalMs : Date.now() + intervalMs;
  const delay = Math.max(0, dueAt - Date.now());

  _status.nextRunAt = new Date(Date.now() + delay).toISOString();
  _interval = setTimeout(() => {
    runOnce().catch(err => console.error("[admin-scraper] tick:", err.message));
  }, delay);
}

function start() {
  loadPersistedStatus();
  scheduleNext();
  // Não dispara automático no boot — admin clica "rodar agora" quando quiser
}

function stop() {
  if (_interval) { clearTimeout(_interval); _interval = null; }
}

module.exports = {
  readConfig,
  writeConfig,
  status,
  runOnce,
  cancel,
  start,
  stop,
  DEFAULT_CONFIG,
  AVAILABLE_CATEGORIES: Object.keys(CATEGORIES),
  AVAILABLE_SOURCES: Object.keys(STORES),
};
