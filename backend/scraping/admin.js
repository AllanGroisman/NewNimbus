const { scrapeOfertas, CATEGORIES, STORES } = require("./scraper");
const catalog = require("../catalog");
const appConfig = require("../config");
const adminNotifier = require("../notifications/admin-notifier");
const schedule = require("./schedule");

const DEFAULT_CONFIG = {
  enabled: false,
  scheduleMode: "interval",                              // "interval" | "times"
  intervalMinutes: 360,                                  // 6h (modo "interval")
  times: [],                                             // "HH:MM" do dia (modo "times")
  categories: Object.keys(CATEGORIES),                   // todas
  sources: Object.keys(STORES),                          // ml, amazon
  limitPerCategory: 200,                                 // fallback (compat com configs antigas)
  limitsBySource: Object.fromEntries(Object.keys(STORES).map(s => [s, 200])),  // limite por loja
  pruneAfterDays: 30,
};

// _status vive em memória mas tem cópia persistida em appConfig (chave STATUS_KEY)
// pra sobreviver a reboots do backend. `running` e `nextRunAt` não são persistidos
// (transitórios — reset no boot).
const STATUS_KEY = "scraper-status";

// Fatia máxima de um setTimeout de agendamento (ver scheduleNext).
const MAX_TIMER_MS = 15 * 60 * 1000;

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
  merged.scheduleMode = merged.scheduleMode === "times" ? "times" : "interval";
  merged.times = schedule.normalizeTimes(merged.times);
  // O intervalo é validado nos dois modos de propósito: alternar pra horários e
  // voltar não pode apagar o valor que o admin tinha escolhido.
  merged.intervalMinutes = Math.max(5, Number(merged.intervalMinutes) || DEFAULT_CONFIG.intervalMinutes);
  merged.limitPerCategory = Math.max(10, Number(merged.limitPerCategory) || DEFAULT_CONFIG.limitPerCategory);
  // Limite por loja: para cada loja conhecida, garante um número >= 10 (default 200).
  const srcLimits = (merged.limitsBySource && typeof merged.limitsBySource === "object") ? merged.limitsBySource : {};
  merged.limitsBySource = {};
  for (const s of Object.keys(STORES)) {
    merged.limitsBySource[s] = Math.max(10, Number(srcLimits[s]) || DEFAULT_CONFIG.limitsBySource[s]);
  }
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

// Puro/testável: a partir do perCategory (chaves "<categoria>-<loja>"), aponta as
// lojas que falharam em TODAS as suas categorias — sinal de loja fora do ar, não
// de oscilação. Devolve a mensagem de erro da rodada, ou null se está tudo bem.
//
// É o aviso que faltava quando o Chrome sumiu do servidor: o ML ficou horas sem
// coletar nada e o status continuava gravando sucesso.
function summarizeDeadStores(perCategory) {
  const bySource = {};
  for (const [tag, r] of Object.entries(perCategory || {})) {
    const src = tag.slice(tag.lastIndexOf("-") + 1);
    bySource[src] = bySource[src] || { total: 0, failed: 0, sample: null };
    bySource[src].total++;
    if (!r.ok) {
      bySource[src].failed++;
      bySource[src].sample = bySource[src].sample || r.error;
    }
  }
  const dead = Object.entries(bySource)
    .filter(([, s]) => s.total > 0 && s.failed === s.total)
    .map(([src, s]) => `${src}: ${s.sample}`);
  return dead.length ? `loja(s) sem coletar nada nesta rodada — ${dead.join(" ; ")}` : null;
}

// Motivo de uma varredura ter voltado vazia, a partir do `stats` que a loja reporta.
// Sem isso o admin recebia sempre "loja bloqueando, layout mudou ou filtro restritivo"
// e tinha que adivinhar qual dos três era. Pura → testável.
function emptySweepReason(stats) {
  const s = (stats || [])[0];
  if (!s) return "nenhum produto retornado (loja bloqueando, layout mudou ou filtro restritivo demais)";
  if (!s.harvested) return "a vitrine de ofertas não devolveu nenhum produto (layout mudou?)";
  if (!s.verified) return `0 aprovados — nenhum dos ${s.harvested} produtos teve o preço confirmado na página (Amazon bloqueando ou layout do bloco de preço mudou)`;
  return `0 aprovados — ${s.verified} produtos com preço confirmado, todos cortados pelos filtros de qualidade (revise Admin → Amazon)`;
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
            // scrapeOfertas engole o erro de cada loja e devolve [] — sem coletar
            // `storeErrors` uma loja fora do ar viraria "ok, 0 produtos".
            const storeErrors = [];
            const storeStats = [];
            const products = await scrapeOfertas({
              category: cat,
              sources: [src],
              limit: (cfg.limitsBySource && cfg.limitsBySource[src]) || cfg.limitPerCategory,
              errors: storeErrors,
              stats: storeStats,
            });
            if (storeErrors.length) throw new Error(storeErrors.map(e => e.error).join(" | "));
            // Varredura vazia é falha, não sucesso: uma loja que muda o HTML, bloqueia
            // o robô ou perde o Chrome devolve 0 produtos sem lançar erro. Só é
            // legítimo zerar quando o filtro do admin é restritivo — e aí o alerta
            // avisando é preferível ao silêncio de um scraping quebrado há dias.
            // Bloqueio já vem como erro tipado acima (storeErrors), então o que sobra
            // aqui é diagnosticável: o `stats` diz onde os produtos morreram.
            if (products.length === 0) throw new Error(emptySweepReason(storeStats));
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

      const deadStoresError = summarizeDeadStores(perCategory);
      if (deadStoresError) {
        _status.lastError = deadStoresError;
        console.error(`[admin-scraper] ${deadStoresError}`);
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
        //
        // NÃO afrouxar isso pra "salvar" a Amazon num dia de bloqueio: preço velho é
        // exatamente o bug que a conferência na página do produto veio corrigir.
        // Catálogo vazio é falha visível e alertada; preço errado vai calado pro grupo.
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

// Agenda o próximo run (ver scraping/schedule.js: intervalo a partir do lastRun,
// ou o próximo horário fixo do dia). Se já passou da hora — backend off, ou
// bootando depois do prazo — dispara imediatamente.
//
// setTimeout single-shot, mas com teto: espera longa é fatiada em pedaços de
// MAX_TIMER_MS que só reagendam. Um timer de 12h erra o alvo com drift de
// relógio ou máquina suspensa, e em horário fixo errar significa perder o slot.
function scheduleNext() {
  if (_interval) { clearTimeout(_interval); _interval = null; }
  const cfg = readConfig();
  if (!cfg.enabled) {
    _status.nextRunAt = null;
    return;
  }
  const plan = schedule.nextRun(cfg, _status.lastRun, new Date());
  if (!plan) {              // modo horários sem nenhum horário: nada a agendar
    _status.nextRunAt = null;
    return;
  }
  const delay = Math.max(0, plan.at.getTime() - Date.now());
  _status.nextRunAt = plan.at.toISOString();
  _interval = setTimeout(
    delay > MAX_TIMER_MS
      ? scheduleNext
      : () => runOnce().catch(err => console.error("[admin-scraper] tick:", err.message)),
    Math.min(delay, MAX_TIMER_MS)
  );
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
  summarizeDeadStores,
  emptySweepReason,
  DEFAULT_CONFIG,
  AVAILABLE_CATEGORIES: Object.keys(CATEGORIES),
  AVAILABLE_SOURCES: Object.keys(STORES),
};
