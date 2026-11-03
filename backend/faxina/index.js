// Aba Admin › Faxina: duas rotinas, cada uma com liga/desliga e agenda própria.
//
//   limpeza — rápida: apaga os cupons do ML que não funcionam mais (vencidos ou com
//             a palavra testada como inválida), esquece da lista do repasse os
//             cupons capturados com palavra inválida, e apaga os produtos que não
//             aparecem em scraping há X dias.
//   rebusca — lenta, em segundo plano: visita cada produto do catálogo na loja,
//             atualiza preço/foto e apaga o que saiu de venda (faxina/rebusca.js).
//
// Mesmo desenho do scraping do admin (scraping/admin.js): config e último
// resultado em app_config, timers de setTimeout fatiados e status em memória que a
// tela consulta. Roda só no processo do server — a re-busca abre Chrome (Amazon) e
// não pode correr em dois processos ao mesmo tempo.
const appConfig = require("../config");
const schedule = require("../scraping/schedule");
const rebusca = require("./rebusca");

const CONFIG_KEY = "faxina-config";
const STATUS_KEY = "faxina-status";
const MAX_TIMER_MS = 15 * 60 * 1000;

const AGENDA_PADRAO = { enabled: false, scheduleMode: "times", intervalMinutes: 1440, times: ["04:00"] };
const DEFAULT_CONFIG = {
  limpeza: { ...AGENDA_PADRAO, diasProdutoAntigo: 30 },
  rebusca: { ...AGENDA_PADRAO, times: ["02:00"], pausaMs: 2000 },
};

const ROTINAS = ["limpeza", "rebusca"];

const _status = {
  limpeza: { running: false, lastRun: null, lastResult: null, lastError: null, nextRunAt: null },
  rebusca: { running: false, canceling: false, progress: null, lastRun: null, lastResult: null, lastError: null, nextRunAt: null },
};
const _timers = {};
let _cancelarRebusca = false;

function loadPersistedStatus() {
  const saved = appConfig.get(STATUS_KEY);
  if (!saved || typeof saved !== "object") return;
  for (const r of ROTINAS) {
    if (!saved[r]) continue;
    _status[r].lastRun = saved[r].lastRun || null;
    _status[r].lastResult = saved[r].lastResult || null;
    _status[r].lastError = saved[r].lastError || null;
  }
}

function persistStatus() {
  const out = {};
  for (const r of ROTINAS) {
    out[r] = { lastRun: _status[r].lastRun, lastResult: _status[r].lastResult, lastError: _status[r].lastError };
  }
  appConfig.set(STATUS_KEY, out);
}

function readConfig() {
  const raw = appConfig.get(CONFIG_KEY) || {};
  return {
    limpeza: { ...DEFAULT_CONFIG.limpeza, ...(raw.limpeza || {}) },
    rebusca: { ...DEFAULT_CONFIG.rebusca, ...(raw.rebusca || {}) },
  };
}

function normalizarAgenda(cfg, padrao) {
  return {
    ...cfg,
    enabled: !!cfg.enabled,
    scheduleMode: cfg.scheduleMode === "interval" ? "interval" : "times",
    times: schedule.normalizeTimes(cfg.times),
    intervalMinutes: Math.max(30, Number(cfg.intervalMinutes) || padrao.intervalMinutes),
  };
}

function writeConfig(patch = {}) {
  const atual = readConfig();
  const limpeza = normalizarAgenda({ ...atual.limpeza, ...(patch.limpeza || {}) }, DEFAULT_CONFIG.limpeza);
  limpeza.diasProdutoAntigo = Math.min(365, Math.max(1, Math.round(Number(limpeza.diasProdutoAntigo) || DEFAULT_CONFIG.limpeza.diasProdutoAntigo)));
  const rb = normalizarAgenda({ ...atual.rebusca, ...(patch.rebusca || {}) }, DEFAULT_CONFIG.rebusca);
  rb.pausaMs = Math.min(60000, Math.max(500, Math.round(Number(rb.pausaMs) || DEFAULT_CONFIG.rebusca.pausaMs)));
  const cfg = {
    limpeza: { enabled: limpeza.enabled, scheduleMode: limpeza.scheduleMode, intervalMinutes: limpeza.intervalMinutes, times: limpeza.times, diasProdutoAntigo: limpeza.diasProdutoAntigo },
    rebusca: { enabled: rb.enabled, scheduleMode: rb.scheduleMode, intervalMinutes: rb.intervalMinutes, times: rb.times, pausaMs: rb.pausaMs },
  };
  appConfig.set(CONFIG_KEY, cfg);
  for (const r of ROTINAS) scheduleNext(r);
  return cfg;
}

function status() {
  return { config: readConfig(), limpeza: { ..._status.limpeza }, rebusca: { ..._status.rebusca } };
}

// ── Limpeza ───────────────────────────────────────────────────────────────

function cortePara(dias) {
  return new Date(Date.now() - dias * 24 * 60 * 60 * 1000);
}

// Os cupons capturados pelo repasse cuja palavra o ML já disse que não vale. O
// mesmo filtro "Inválido" + "tudo" da aba Admin › Cupom › Repasse.
async function cuponsRepasseInvalidos() {
  const repasseCoupons = require("../repasse/coupons");
  const linhas = await repasseCoupons.aggregate({ days: "tudo" });
  return linhas.filter(l => l.verdict === "invalid").map(l => l.code);
}

// O que a limpeza apagaria agora, sem apagar nada.
async function previaLimpeza() {
  const coupons = require("../coupons");
  const catalog = require("../catalog");
  const { diasProdutoAntigo } = readConfig().limpeza;
  const [cupons, repasse, antigos] = await Promise.all([
    coupons.apagarCuponsMortos({ simular: true }),
    cuponsRepasseInvalidos(),
    catalog.contarAntesDe(cortePara(diasProdutoAntigo)),
  ]);
  return { cupons, cuponsRepasse: repasse.length, produtosAntigos: antigos, diasProdutoAntigo };
}

async function rodarLimpeza() {
  const st = _status.limpeza;
  if (st.running) throw new Error("A limpeza já está rodando.");
  st.running = true;
  const inicio = Date.now();
  try {
    const coupons = require("../coupons");
    const catalog = require("../catalog");
    const repasseCoupons = require("../repasse/coupons");
    const { diasProdutoAntigo } = readConfig().limpeza;

    const cupons = await coupons.apagarCuponsMortos();
    const repasse = await repasseCoupons.forgetCoupons(await cuponsRepasseInvalidos());
    const antigos = await catalog.pruneBeforeDate(cortePara(diasProdutoAntigo), { keepCouponLinked: true });

    st.lastResult = {
      cupons: cupons.cupons,
      cuponsVencidos: cupons.vencidos,
      cuponsPalavraInvalida: cupons.palavraInvalida,
      produtosDaVitrine: cupons.produtos,
      cuponsRepasse: repasse.cupons,
      produtosAntigos: antigos.removed,
      diasProdutoAntigo,
      duracaoMs: Date.now() - inicio,
    };
    st.lastError = null;
    console.log(`[faxina] limpeza: ${cupons.cupons} cupons, ${cupons.produtos} produtos de vitrine, ${repasse.cupons} cupons do repasse, ${antigos.removed} produtos antigos`);
    return st.lastResult;
  } catch (err) {
    st.lastError = err.message;
    console.error("[faxina] limpeza falhou:", err.message);
    throw err;
  } finally {
    st.running = false;
    st.lastRun = new Date().toISOString();
    persistStatus();
    scheduleNext("limpeza");
  }
}

// ── Re-busca ──────────────────────────────────────────────────────────────

// Enquanto o scraping do admin roda, a re-busca espera: os dois abrem Chrome e
// batem nas mesmas lojas.
async function aguardarScraping() {
  const adminScraper = require("../scraping/admin");
  while (adminScraper.status().running && !_cancelarRebusca) {
    if (_status.rebusca.progress) _status.rebusca.progress.current = "esperando o scraping do admin terminar…";
    await new Promise(r => setTimeout(r, 30_000));
  }
}

async function rodarRebusca() {
  const st = _status.rebusca;
  if (st.running) throw new Error("A re-busca já está rodando.");
  st.running = true;
  st.canceling = false;
  st.progress = { total: 0, done: 0, atualizados: 0, apagados: 0, pulados: 0, current: "contando produtos…" };
  _cancelarRebusca = false;
  const inicio = Date.now();
  try {
    const { pausaMs } = readConfig().rebusca;
    const r = await rebusca.rodar({
      pausaMs,
      ctl: {
        deveParar: () => _cancelarRebusca,
        aguardarVez: aguardarScraping,
        progresso: (p) => { st.progress = { ...p }; },
      },
    });
    st.lastResult = {
      total: r.total, conferidos: r.done, atualizados: r.atualizados, apagados: r.apagados, pulados: r.pulados,
      porLoja: r.porLoja, lojasParadas: r.lojasParadas, cancelado: r.cancelado, duracaoMs: Date.now() - inicio,
    };
    st.lastError = null;
    console.log(`[faxina] re-busca${r.cancelado ? " (cancelada)" : ""}: ${r.done}/${r.total} conferidos, ${r.atualizados} atualizados, ${r.apagados} apagados, ${r.pulados} pulados`);
    return st.lastResult;
  } catch (err) {
    st.lastError = err.message;
    console.error("[faxina] re-busca falhou:", err.message);
    throw err;
  } finally {
    st.running = false;
    st.canceling = false;
    st.progress = null;
    st.lastRun = new Date().toISOString();
    persistStatus();
    scheduleNext("rebusca");
  }
}

function cancelarRebusca() {
  if (!_status.rebusca.running) return false;
  _cancelarRebusca = true;
  _status.rebusca.canceling = true;
  return true;
}

// ── Agenda ────────────────────────────────────────────────────────────────

const RODAR = { limpeza: rodarLimpeza, rebusca: rodarRebusca };

// Mesmo mecanismo do scheduleNext do scraping (scraping/admin.js): timer fatiado
// em MAX_TIMER_MS, próximo horário a partir do lastRun persistido.
function scheduleNext(rotina) {
  if (_timers[rotina]) { clearTimeout(_timers[rotina]); _timers[rotina] = null; }
  const st = _status[rotina];
  const cfg = readConfig()[rotina];
  if (!cfg.enabled) { st.nextRunAt = null; return; }
  const plan = schedule.nextRun(cfg, st.lastRun, new Date());
  if (!plan) { st.nextRunAt = null; return; }
  const delay = Math.max(0, plan.at.getTime() - Date.now());
  st.nextRunAt = plan.at.toISOString();
  _timers[rotina] = setTimeout(() => {
    if (delay > MAX_TIMER_MS) return scheduleNext(rotina);
    if (st.running) return;
    RODAR[rotina]().catch(err => console.error(`[faxina] ${rotina} agendada falhou:`, err.message));
  }, Math.min(delay, MAX_TIMER_MS));
  _timers[rotina].unref?.();
}

function start() {
  loadPersistedStatus();
  for (const r of ROTINAS) scheduleNext(r);
}

function stop() {
  for (const r of ROTINAS) if (_timers[r]) { clearTimeout(_timers[r]); _timers[r] = null; }
}

module.exports = {
  start,
  stop,
  status,
  readConfig,
  writeConfig,
  previaLimpeza,
  rodarLimpeza,
  rodarRebusca,
  cancelarRebusca,
  DEFAULT_CONFIG,
};
