// ScrapTester — monitor de saúde do scraping.
//
// De tempos em tempos puxa uma AMOSTRA pequena de produtos de cada loja (mesmo
// caminho de código que alimenta o catálogo: scrapeOfertas) e mede, campo a campo,
// quantos produtos vieram com o dado preenchido. Se um site muda o layout e o
// scraper para de pegar avaliação/vendas/preço, a cobertura daquele campo despenca
// e o admin é avisado pelas notificações de WhatsApp.
//
// Nada é gravado no catálogo — é só leitura/diagnóstico.
const { scrapeOfertas, CATEGORIES, STORES } = require("./scraper");
const appConfig = require("../config");
const adminNotifier = require("../notifications/admin-notifier");

const CONFIG_KEY = "scrap-tester-config";
const STATUS_KEY = "scrap-tester-status";
const HISTORY_KEY = "scrap-tester-history";
const HISTORY_MAX = 20;

// Campos verificados. Nem todo campo existe em toda loja — `applies` evita alarme
// falso (ex: Shopee nunca traz `seller`, Amazon não traz `sold`).
//
//   minPct      cobertura mínima esperada na amostra; abaixo disso vira alerta.
//   minPctBy    limiar diferente para uma loja específica (sobrepõe minPct).
//   critical    sem esse campo o produto é inutilizável → falha grave.
//   altKey      nome alternativo do campo em outra loja (sold ↔ soldCount).
//   zeroIsValid 0 é um valor legítimo (desconto zero, zero vendas), não ausência.
//   boolField   booleano: "presente" = campo definido, não `=== true`.
//
// Notas de aplicabilidade (verificadas no código dos extratores):
// - `reviewsCount`: o ML tirou o nº de avaliações dos cards de ofertas (só sobrou
//   nota + vendas), e a Affiliate API da Shopee não expõe — só a Amazon tem.
// - Amazon: nota, vendas, vendedor e frete só existem nos produtos ENRIQUECIDOS
//   (limite configurável em Admin → Amazon), por isso limiares baixos.
// - `freeShipping` da Shopee não existe na Affiliate API.
const FIELD_SPECS = [
  { key: "name",          label: "Nome",             applies: ["ml", "amazon", "shopee"], minPct: 100, critical: true },
  { key: "link",          label: "Link",             applies: ["ml", "amazon", "shopee"], minPct: 100, critical: true },
  { key: "img",           label: "Imagem",           applies: ["ml", "amazon", "shopee"], minPct: 90,  critical: true },
  { key: "price",         label: "Preço",            applies: ["ml", "amazon", "shopee"], minPct: 100, critical: true },
  { key: "originalPrice", label: "Preço original",   applies: ["ml", "amazon", "shopee"], minPct: 50 },
  { key: "discount",      label: "Desconto",         applies: ["ml", "amazon", "shopee"], minPct: 50, zeroIsValid: true },
  { key: "rating",        label: "Avaliação",        applies: ["ml", "amazon", "shopee"], minPct: 80, minPctBy: { amazon: 40 } },
  { key: "reviewsCount",  label: "Nº de avaliações", applies: ["amazon"],                 minPct: 40 },
  { key: "sold",          label: "Nº de vendas",     applies: ["ml", "amazon", "shopee"], minPct: 70, minPctBy: { amazon: 30 }, altKey: "soldCount", zeroIsValid: true },
  { key: "seller",        label: "Vendedor",         applies: ["ml", "amazon", "shopee"], minPct: 50, minPctBy: { amazon: 30 } },
  { key: "freeShipping",  label: "Frete grátis",     applies: ["ml", "amazon"],           minPct: 0, boolField: true },
];

const SPEC_BY_KEY = Object.fromEntries(FIELD_SPECS.map(s => [s.key, s]));

const DEFAULT_CONFIG = {
  enabled: false,
  intervalMinutes: 720,                  // 12h
  sources: Object.keys(STORES),
  category: "eletronicos",
  sampleSize: 10,
  // Limiares personalizados por loja+campo: { "amazon.rating": 30 }. Vazio = usa minPct do spec.
  thresholds: {},
};

let _status = {
  running: false,
  canceling: false,
  lastRun: null,
  lastDuration: null,
  lastError: null,
  nextRunAt: null,
  perSource: null,      // { ml: { ok, sampled, fields, missing, criticalMissing, error, sample } }
  overall: null,        // "ok" | "warn" | "fail"
  category: null,
  categoryLabel: null,
  sampleSize: null,
};

let _timer = null;
let _runPromise = null;
let _cancelRequested = false;

// ── Config / status ────────────────────────────────────────────────────────

function readConfig() {
  const raw = appConfig.get(CONFIG_KEY);
  if (!raw || typeof raw !== "object") return { ...DEFAULT_CONFIG, thresholds: {} };
  return { ...DEFAULT_CONFIG, ...raw, thresholds: { ...(raw.thresholds || {}) } };
}

function writeConfig(cfg) {
  const merged = { ...readConfig(), ...cfg };
  merged.enabled = !!merged.enabled;
  merged.intervalMinutes = Math.max(15, Number(merged.intervalMinutes) || DEFAULT_CONFIG.intervalMinutes);
  merged.sampleSize = Math.min(50, Math.max(3, Number(merged.sampleSize) || DEFAULT_CONFIG.sampleSize));
  merged.sources = Array.isArray(merged.sources)
    ? merged.sources.filter(s => STORES[s])
    : DEFAULT_CONFIG.sources;
  merged.category = CATEGORIES[merged.category] ? merged.category : DEFAULT_CONFIG.category;

  // Limiares: só aceita "loja.campo" conhecido, valor 0-100.
  const rawTh = (merged.thresholds && typeof merged.thresholds === "object") ? merged.thresholds : {};
  merged.thresholds = {};
  for (const [k, v] of Object.entries(rawTh)) {
    const [src, field] = String(k).split(".");
    if (!STORES[src] || !SPEC_BY_KEY[field]) continue;
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    merged.thresholds[k] = Math.min(100, Math.max(0, Math.round(n)));
  }

  appConfig.set(CONFIG_KEY, merged);
  scheduleNext();
  return merged;
}

function loadPersistedStatus() {
  const saved = appConfig.get(STATUS_KEY);
  if (saved && typeof saved === "object") {
    _status.lastRun = saved.lastRun || null;
    _status.lastDuration = saved.lastDuration || null;
    _status.lastError = saved.lastError || null;
    _status.perSource = saved.perSource || null;
    _status.overall = saved.overall || null;
    _status.category = saved.category || null;
    _status.categoryLabel = saved.categoryLabel || null;
    _status.sampleSize = saved.sampleSize || null;
  }
}

function persistStatus() {
  appConfig.set(STATUS_KEY, {
    lastRun: _status.lastRun,
    lastDuration: _status.lastDuration,
    lastError: _status.lastError,
    perSource: _status.perSource,
    overall: _status.overall,
    category: _status.category,
    categoryLabel: _status.categoryLabel,
    sampleSize: _status.sampleSize,
  });
}

function readHistory() {
  const raw = appConfig.get(HISTORY_KEY);
  return Array.isArray(raw) ? raw : [];
}

// Guarda só o essencial (sem a amostra de produtos) pra dar pra ver quando um
// campo começou a falhar.
function pushHistory(entry) {
  const next = [entry, ...readHistory()].slice(0, HISTORY_MAX);
  appConfig.set(HISTORY_KEY, next);
  return next;
}

function status() {
  return { config: readConfig(), fieldSpecs: FIELD_SPECS, ..._status };
}

// ── Avaliação da amostra ───────────────────────────────────────────────────

function specsForSource(source) {
  return FIELD_SPECS.filter(s => s.applies.includes(source));
}

// Limiar efetivo: o que o admin editou na tela > o padrão da loja (minPctBy) >
// o padrão do campo.
function thresholdFor(cfg, source, spec) {
  const custom = cfg.thresholds && cfg.thresholds[`${source}.${spec.key}`];
  if (Number.isFinite(custom)) return custom;
  const byStore = spec.minPctBy && spec.minPctBy[source];
  return Number.isFinite(byStore) ? byStore : spec.minPct;
}

// Um campo está "presente" se o scraper conseguiu extrair algo utilizável dele.
function isPresent(product, spec) {
  let v = product[spec.key];
  if ((v === undefined || v === null) && spec.altKey) v = product[spec.altKey];

  if (spec.boolField) return v !== undefined && v !== null;
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.trim() !== "";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return false;
    return spec.zeroIsValid ? true : v !== 0;
  }
  if (typeof v === "boolean") return true;
  return true;
}

// Calcula a cobertura de cada campo aplicável a uma loja.
// Retorna { fields, missing, criticalMissing, status }.
function evaluateSample(source, products, cfg) {
  const total = products.length;
  const fields = {};
  const missing = [];
  const criticalMissing = [];

  for (const spec of specsForSource(source)) {
    const present = products.reduce((n, p) => n + (isPresent(p, spec) ? 1 : 0), 0);
    const pct = total > 0 ? Math.round((present / total) * 100) : 0;
    const minPct = thresholdFor(cfg, source, spec);
    const below = pct < minPct;
    const st = below ? (spec.critical ? "fail" : "warn") : "ok";

    fields[spec.key] = { label: spec.label, present, total, pct, minPct, status: st, critical: !!spec.critical };
    if (below) {
      missing.push(spec.key);
      if (spec.critical) criticalMissing.push(spec.key);
    }
  }

  const st = criticalMissing.length > 0 ? "fail" : (missing.length > 0 ? "warn" : "ok");
  return { fields, missing, criticalMissing, status: st };
}

const SEVERITY = { ok: 0, warn: 1, fail: 2 };

function worstStatus(list) {
  return list.reduce((acc, s) => (SEVERITY[s] > SEVERITY[acc] ? s : acc), "ok");
}

// Recorta os campos relevantes de um produto pra inspeção manual na tela.
function sampleProduct(p) {
  const out = {};
  for (const spec of FIELD_SPECS) {
    out[spec.key] = p[spec.key] ?? (spec.altKey ? p[spec.altKey] : undefined) ?? null;
  }
  return out;
}

// ── Execução ───────────────────────────────────────────────────────────────

// Roda o teste uma vez: para cada loja habilitada, puxa uma amostra e avalia.
// Lojas são testadas em SEQUÊNCIA pra não disparar ML + Amazon + Shopee ao mesmo
// tempo e aumentar a chance de bloqueio.
async function runOnce() {
  if (_runPromise) return _runPromise;
  const cfg = readConfig();
  if (!cfg.sources.length) throw new Error("Configure ao menos 1 loja");

  _cancelRequested = false;
  _runPromise = (async () => {
    _status.running = true;
    _status.canceling = false;
    _status.lastError = null;
    _status.category = cfg.category;
    _status.categoryLabel = CATEGORIES[cfg.category]?.label || cfg.category;
    _status.sampleSize = cfg.sampleSize;
    const t0 = Date.now();
    const perSource = {};

    try {
      for (const src of cfg.sources) {
        // Cancelamento cooperativo: o scrape em andamento termina, os próximos não começam.
        if (_cancelRequested) break;
        const label = STORES[src]?.label || src;
        try {
          console.log(`[scrap-tester] ${src}: amostrando ${cfg.sampleSize} produtos (${cfg.category})...`);
          const products = await scrapeOfertas({
            category: cfg.category,
            sources: [src],
            limit: cfg.sampleSize,
          });

          if (!products.length) {
            // Amostra vazia é falha crítica: normalmente é CAPTCHA / login wall.
            perSource[src] = {
              label, ok: false, sampled: 0, fields: {}, missing: [], criticalMissing: [],
              status: "fail", error: "Nenhum produto retornado (possível bloqueio ou seletor quebrado)",
              sample: [],
            };
            console.warn(`[scrap-tester] ${src}: amostra vazia`);
            continue;
          }

          const evaluated = evaluateSample(src, products, cfg);
          perSource[src] = {
            label, ok: true, sampled: products.length, error: null,
            ...evaluated,
            sample: products.slice(0, 3).map(sampleProduct),
          };
          console.log(`[scrap-tester] ${src}: ${products.length} produtos, status ${evaluated.status}` +
            (evaluated.missing.length ? ` — falhas: ${evaluated.missing.join(", ")}` : ""));
        } catch (err) {
          console.error(`[scrap-tester] ${src} falhou:`, err.message);
          perSource[src] = {
            label, ok: false, sampled: 0, fields: {}, missing: [], criticalMissing: [],
            status: "fail", error: err.message, sample: [],
          };
        }
      }

      _status.perSource = perSource;
      _status.overall = worstStatus(Object.values(perSource).map(r => r.status));
    } catch (err) {
      _status.lastError = err.message;
      _status.overall = "fail";
      console.error("[scrap-tester] erro fatal:", err.message);
    } finally {
      _status.running = false;
      _status.canceling = false;
      _cancelRequested = false;
      _status.lastRun = new Date().toISOString();
      _status.lastDuration = Date.now() - t0;
      _runPromise = null;
      persistStatus();
      pushHistory({
        at: _status.lastRun,
        durationMs: _status.lastDuration,
        overall: _status.overall,
        category: _status.category,
        categoryLabel: _status.categoryLabel,
        sampleSize: _status.sampleSize,
        perSource: Object.fromEntries(Object.entries(_status.perSource || {}).map(([src, r]) => [
          src,
          { ok: r.ok, sampled: r.sampled, status: r.status, missing: r.missing, error: r.error },
        ])),
      });
      scheduleNext();
      adminNotifier.notifyScrapTesterResult(_status).catch(err =>
        console.error("[scrap-tester] notifyScrapTesterResult:", err.message)
      );
    }
    return _status;
  })();
  return _runPromise;
}

function cancel() {
  if (!_status.running) return { ok: false, message: "Nenhum teste em execução" };
  _cancelRequested = true;
  _status.canceling = true;
  console.log("[scrap-tester] cancelamento solicitado");
  return { ok: true, message: "Cancelamento solicitado — encerrando após a loja atual" };
}

// Mesma mecânica do admin-scraper: setTimeout single-shot baseado em
// `lastRun + intervalMinutes`, reagendado pelo `finally` de runOnce().
function scheduleNext() {
  if (_timer) { clearTimeout(_timer); _timer = null; }
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
  _timer = setTimeout(() => {
    runOnce().catch(err => console.error("[scrap-tester] tick:", err.message));
  }, delay);
}

function start() {
  loadPersistedStatus();
  scheduleNext();
}

function stop() {
  if (_timer) { clearTimeout(_timer); _timer = null; }
}

module.exports = {
  readConfig,
  writeConfig,
  status,
  readHistory,
  runOnce,
  cancel,
  start,
  stop,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  // expostos pros testes unitários
  isPresent,
  evaluateSample,
  worstStatus,
  AVAILABLE_CATEGORIES: Object.entries(CATEGORIES).map(([id, c]) => ({ id, label: c.label })),
  AVAILABLE_SOURCES: Object.entries(STORES).map(([id, s]) => ({ id, label: s.label })),
};
