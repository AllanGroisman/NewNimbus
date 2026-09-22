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
  pausing: false,           // pedido de pausa em andamento
  progress: null,           // { total, done, current, inserted, updated, failed, ... } enquanto roda
  lastRun: null,            // ISO
  lastDuration: null,       // ms
  lastResult: null,         // { inserted, updated, total, perCategory: { gamer-ml: { ... } } }
  lastError: null,
  nextRunAt: null,
};

let _interval = null;
let _runPromise = null;
let _cancelRequested = false;
let _pauseRequested = false;

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
    paused: pausedSummary(),
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

// ── Checkpoint (pausar/retomar) ─────────────────────────────────────────────
// A unidade de trabalho é um passo (categoria × loja). Depois de cada passo o
// run grava onde está em CHECKPOINT_KEY — não só na pausa: um restart do backend
// no meio da rodada também deixa um run retomável. O checkpoint leva um retrato
// da config do início, pra retomar a MESMA lista de passos mesmo que o admin
// mexa na config durante a pausa. Some quando o run conclui ou é cancelado.
const CHECKPOINT_KEY = "scraper-checkpoint";

function buildSteps(categories, sources) {
  const steps = [];
  for (const cat of categories || []) {
    for (const src of sources || []) steps.push({ cat, src, tag: `${cat}-${src}` });
  }
  return steps;
}

// Só retoma run começado no mesmo dia (hora local). Retomar uma pausa de ontem
// misturaria preço velho com novo — aí é melhor começar do zero.
function isResumable(cp, now = new Date()) {
  if (!cp || !Array.isArray(cp.done) || !cp.startedAt) return false;
  const started = new Date(cp.startedAt);
  if (isNaN(started)) return false;
  return started.getFullYear() === now.getFullYear()
    && started.getMonth() === now.getMonth()
    && started.getDate() === now.getDate();
}

// Início do dia em que o run COMEÇOU — não de "agora". Um run retomado não pode
// apagar no purge o que ele mesmo coletou antes da pausa.
function purgeCutoff(cp, now = new Date()) {
  const base = cp && cp.startedAt ? new Date(cp.startedAt) : new Date(now);
  const d = isNaN(base) ? new Date(now) : base;
  d.setHours(0, 0, 0, 0);
  return d;
}

function readCheckpoint() {
  const cp = appConfig.get(CHECKPOINT_KEY);
  return cp && typeof cp === "object" && Array.isArray(cp.done) ? cp : null;
}

function saveCheckpoint(cp) { appConfig.set(CHECKPOINT_KEY, cp); }
function clearCheckpoint() { if (appConfig.get(CHECKPOINT_KEY)) appConfig.del(CHECKPOINT_KEY); }

function newCheckpoint(cfg) {
  return {
    startedAt: new Date().toISOString(),
    categories: [...cfg.categories],
    sources: [...cfg.sources],
    limitsBySource: { ...(cfg.limitsBySource || {}) },
    limitPerCategory: cfg.limitPerCategory,
    done: [],
    perCategory: {},
    inserted: 0,
    updated: 0,
    elapsedMs: 0,
    pausedAt: null,
  };
}

// Resumo do run pausado/interrompido pra UI. null se não há nada a retomar ou
// se um run está rodando (aí quem descreve é `progress`).
function pausedSummary() {
  if (_status.running) return null;
  const cp = readCheckpoint();
  if (!cp) return null;
  return {
    done: cp.done.length,
    total: buildSteps(cp.categories, cp.sources).length,
    startedAt: cp.startedAt,
    pausedAt: cp.pausedAt,
    interrupted: !cp.pausedAt,          // backend reiniciou no meio, sem pausa pedida
    resumable: isResumable(cp),
    inserted: cp.inserted,
    updated: cp.updated,
  };
}

// Roda uma vez: para cada (categoria × loja), faz scrape e dá upsert no catálogo.
// `resume`: continua o run pausado/interrompido se ele é de hoje (isResumable);
// senão começa do zero.
async function runOnce({ resume = false } = {}) {
  if (_runPromise) return _runPromise;
  let cp = resume ? readCheckpoint() : null;
  const resumed = isResumable(cp);
  if (!resumed) {
    const cfg = readConfig();
    if (!cfg.categories.length || !cfg.sources.length) {
      throw new Error("Configure ao menos 1 categoria e 1 loja");
    }
    cp = newCheckpoint(cfg);
  }
  cp.pausedAt = null;
  saveCheckpoint(cp);

  _cancelRequested = false;
  _pauseRequested = false;
  _runPromise = (async () => {
    _status.running = true;
    _status.canceling = false;
    _status.pausing = false;
    _status.lastError = null;
    const t0 = Date.now();
    const baseElapsed = cp.elapsedMs || 0;
    const steps = buildSteps(cp.categories, cp.sources);
    const doneSet = new Set(cp.done);
    const pending = steps.filter(s => !doneSet.has(s.tag));
    const perCategory = cp.perCategory;
    let outcome = "done";            // "done" | "paused" | "cancelled"
    let sessionSteps = 0;

    _status.progress = {
      total: steps.length,
      done: cp.done.length,
      current: null,
      inserted: cp.inserted,
      updated: cp.updated,
      failed: Object.values(perCategory).filter(r => !r.ok).length,
      startedAt: cp.startedAt,
      sessionStartedAt: new Date(t0).toISOString(),
      avgStepMs: null,
      resumed,
    };
    if (resumed) console.log(`[admin-scraper] retomando run de ${cp.startedAt}: ${cp.done.length}/${steps.length} passos feitos`);

    try {
      for (const { cat, src, tag } of pending) {
        // Cancelar/pausar: verificado entre cada (categoria × loja). Não interrompe
        // um scrape já em andamento, mas impede que os próximos comecem.
        if (_cancelRequested) { outcome = "cancelled"; break; }
        if (_pauseRequested) { outcome = "paused"; break; }
        _status.progress.current = { cat, src, tag, startedAt: new Date().toISOString() };
        try {
          console.log(`[admin-scraper] ${tag}: iniciando...`);
          // scrapeOfertas engole o erro de cada loja e devolve [] — sem coletar
          // `storeErrors` uma loja fora do ar viraria "ok, 0 produtos".
          const storeErrors = [];
          const storeStats = [];
          const products = await scrapeOfertas({
            category: cat,
            sources: [src],
            limit: (cp.limitsBySource && cp.limitsBySource[src]) || cp.limitPerCategory,
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
          cp.inserted += r.inserted;
          cp.updated += r.updated;
          console.log(`[admin-scraper] ${tag}: +${r.inserted} novos, ${r.updated} atualizados`);
        } catch (err) {
          console.error(`[admin-scraper] ${tag} falhou:`, err.message);
          perCategory[tag] = { ok: false, error: err.message };
          _status.progress.failed++;
        }
        cp.done.push(tag);
        cp.elapsedMs = baseElapsed + (Date.now() - t0);
        saveCheckpoint(cp);
        sessionSteps++;
        Object.assign(_status.progress, {
          done: cp.done.length,
          current: null,
          inserted: cp.inserted,
          updated: cp.updated,
          avgStepMs: Math.round((Date.now() - t0) / sessionSteps),
        });
      }
      // Pedido que chegou durante o último passo: não há mais nada a pausar.
      if (outcome === "done" && _cancelRequested) outcome = "cancelled";

      if (outcome === "done") {
        const deadStoresError = summarizeDeadStores(perCategory);
        if (deadStoresError) {
          _status.lastError = deadStoresError;
          console.error(`[admin-scraper] ${deadStoresError}`);
        }
      }

      if (outcome === "paused") {
        // Run incompleto, mas guardado: sem prune/purge (ver cancelamento abaixo).
        // O checkpoint já tem tudo até o último passo; só marca a pausa.
        cp.pausedAt = new Date().toISOString();
        saveCheckpoint(cp);
        console.log(`[admin-scraper] pausado em ${cp.done.length}/${steps.length} passos`);
        const total = await catalog.getStats().then(s => s.total).catch(() => null);
        _status.lastResult = {
          inserted: cp.inserted,
          updated: cp.updated,
          total,
          pruned: 0,
          paused: true,
          perCategory,
        };
      } else if (outcome === "cancelled") {
        // Run incompleto: NÃO faz prune/purge. O purge remove tudo que não foi
        // visto hoje — se rodasse aqui, apagaria categorias que nem chegaram a ser
        // scrapeadas por causa do cancelamento. Reporta só o que entrou até agora.
        clearCheckpoint();
        console.log(`[admin-scraper] cancelado pelo admin — pulando prune/purge`);
        const total = await catalog.getStats().then(s => s.total).catch(() => null);
        _status.lastResult = {
          inserted: cp.inserted,
          updated: cp.updated,
          total,
          pruned: 0,
          cancelled: true,
          perCategory,
        };
      } else {
        // Limpa produtos antigos (limite máximo, default 30 dias)
        const pruned = await catalog.prune(readConfig().pruneAfterDays);
        console.log(`[admin-scraper] prune: -${pruned.removed} antigos, total ${pruned.total}`);

        // Após cada run, descarta tudo que NÃO foi visto no dia em que o run
        // começou — assim o catálogo só guarda o que veio na rodada atual (e em
        // rodadas anteriores do mesmo dia). Isso atende ao requisito "ao realizar
        // um scrap, exclui itens do dia anterior" e elimina duplicatas residuais.
        // Run retomado depois da meia-noite usa o dia do início (purgeCutoff) —
        // senão apagaria o que ele mesmo coletou antes da pausa.
        //
        // NÃO afrouxar isso pra "salvar" a Amazon num dia de bloqueio: preço velho é
        // exatamente o bug que a conferência na página do produto veio corrigir.
        // Catálogo vazio é falha visível e alertada; preço errado vai calado pro grupo.
        //
        // Produto de vitrine de cupom ainda válido fica (keepCouponLinked): ele é
        // renovado pela colheita de cupons, não pelo scraping.
        const purged = await catalog.pruneBeforeDate(purgeCutoff(cp), { keepCouponLinked: true });
        if (purged.removed > 0 || purged.kept > 0) {
          console.log(`[admin-scraper] purge dia anterior: -${purged.removed}, protegidos (cupom) ${purged.kept || 0}, total ${purged.total}`);
        }
        clearCheckpoint();

        _status.lastResult = {
          inserted: cp.inserted,
          updated: cp.updated,
          total: purged.total,
          pruned: pruned.removed + purged.removed,
          prunedOld: pruned.removed,
          purged: purged.removed,
          keptCoupon: purged.kept || 0,
          perCategory,
        };
      }
    } catch (err) {
      // Erro fatal: o checkpoint fica — o run pode ser retomado.
      _status.lastError = err.message;
      console.error(`[admin-scraper] erro fatal:`, err.message);
    } finally {
      _status.running = false;
      _status.canceling = false;
      _status.pausing = false;
      _status.progress = null;
      _cancelRequested = false;
      _pauseRequested = false;
      _status.lastRun = new Date().toISOString();
      // Run concluído conta o tempo de todas as sessões; pausado, só a desta.
      _status.lastDuration = outcome === "done" ? baseElapsed + (Date.now() - t0) : Date.now() - t0;
      _runPromise = null;
      persistStatus();
      scheduleNext();
      // Pausa não é resultado — o aviso sai quando o run terminar de fato.
      if (outcome !== "paused") {
        adminNotifier.notifyScrapingResult(_status).catch(err =>
          console.error("[admin-scraper] notifyScrapingResult:", err.message)
        );
      }
    }
    return _status.lastResult;
  })();
  return _runPromise;
}

// Solicita o cancelamento do run em andamento. O scrape atual (categoria × loja)
// termina, mas os próximos não começam — o run encerra logo em seguida.
// Sem run rodando, descarta o run pausado (se houver). Retorna { ok, message }.
function cancel() {
  if (!_status.running) {
    if (readCheckpoint()) {
      clearCheckpoint();
      console.log("[admin-scraper] run pausado descartado");
      return { ok: true, message: "Run pausado descartado — o próximo começa do zero" };
    }
    return { ok: false, message: "Nenhum scraping em execução" };
  }
  _cancelRequested = true;
  _status.canceling = true;
  console.log("[admin-scraper] cancelamento solicitado");
  return { ok: true, message: "Cancelamento solicitado — encerrando após o item atual" };
}

// Pausa o run em andamento depois do passo atual, guardando o progresso
// (checkpoint) pra retomar com runOnce({ resume: true }). Retorna { ok, message }.
function pause() {
  if (!_status.running) {
    return { ok: false, message: "Nenhum scraping em execução" };
  }
  _pauseRequested = true;
  _status.pausing = true;
  const cur = _status.progress && _status.progress.current;
  console.log("[admin-scraper] pausa solicitada");
  return { ok: true, message: `Pausa solicitada — pausando após ${cur ? cur.tag : "o item atual"}` };
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
      : () => runOnce({ resume: true }).catch(err => console.error("[admin-scraper] tick:", err.message)),
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
  pause,
  start,
  stop,
  summarizeDeadStores,
  emptySweepReason,
  buildSteps,
  isResumable,
  purgeCutoff,
  CHECKPOINT_KEY,
  DEFAULT_CONFIG,
  AVAILABLE_CATEGORIES: Object.keys(CATEGORIES),
  AVAILABLE_SOURCES: Object.keys(STORES),
};
