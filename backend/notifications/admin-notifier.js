const appConfig = require("../config");
const whatsnimbus = require("./whatsnimbus");

const CONFIG_KEY = "admin-notifications-config";

// Modelos de texto das notificações, editáveis pelo Admin em "Modelos Notificações".
// Usam variáveis {chave} substituídas na hora do envio. Partes dinâmicas (loop por
// categoria, blocos condicionais) chegam prontas como variáveis de bloco.
const DEFAULT_TEMPLATES = {
  scrapingSuccess: [
    "*[Nimbus] ✅ Scraping Concluído*",
    "📅 {data}",
    "⏱ Duração: {duracao}",
    "{bloco_cancelado}📦 +{novos} novos · {atualizados} atualizados · {removidos} removidos",
    "🗄 Total no catálogo: {total} produtos",
    "{por_categoria}",
  ].join("\n"),
  scrapingError: [
    "*[Nimbus] ⚠️ Scraping com Erro*",
    "📅 {data}",
    "⏱ Duração: {duracao}",
    "{bloco_cancelado}📦 +{novos} novos · {atualizados} atualizados · {removidos} removidos",
    "🗄 Total no catálogo: {total} produtos",
    "{por_categoria}",
    "",
    "Erro: {erro}",
  ].join("\n"),
  scrapTesterOk: [
    "*[Nimbus] 🧪 Teste de Scraping — OK*",
    "📅 {data} · ⏱ {duracao}",
    "Amostra de {amostra} produtos ({categoria})",
    "{por_loja}",
    "",
    "Todos os campos vieram dentro do esperado.",
  ].join("\n"),
  scrapTesterAlert: [
    "*[Nimbus] 🧪 Teste de Scraping — Problemas*",
    "📅 {data} · ⏱ {duracao}",
    "Amostra de {amostra} produtos ({categoria})",
    "{por_loja}",
    "",
    "⚠️ *Campos com falha:*",
    "{problemas}",
  ].join("\n"),
  systemOnline: [
    "*[Nimbus] ✅ Sistema Online*",
    "📅 {data}",
    "Backend inicializado com sucesso.",
  ].join("\n"),
  test: [
    "*[Nimbus] 🔔 Teste de Notificação*",
    "📅 {data}",
    "As notificações do sistema estão configuradas corretamente.",
  ].join("\n"),
};

const TEMPLATE_KEYS = Object.keys(DEFAULT_TEMPLATES);

// Descreve cada modelo pra UI: rótulo, variáveis disponíveis e valores de exemplo
// usados na pré-visualização.
const TEMPLATE_META = [
  {
    key: "scrapingSuccess",
    label: "Scraping — Concluído",
    variables: [
      { name: "data", desc: "Data/hora da execução" },
      { name: "duracao", desc: "Duração do scraping" },
      { name: "novos", desc: "Qtd. de produtos novos" },
      { name: "atualizados", desc: "Qtd. de produtos atualizados" },
      { name: "removidos", desc: "Qtd. de produtos removidos" },
      { name: "total", desc: "Total no catálogo" },
      { name: "bloco_cancelado", desc: "Aviso de execução cancelada (quando houver)" },
      { name: "por_categoria", desc: "Lista por categoria e loja (modo detalhado)" },
    ],
    example: {
      data: "23/07/2026 14:30",
      duracao: "2m 15s",
      novos: 42,
      atualizados: 118,
      removidos: 7,
      total: 3540,
      cancelled: false,
      detailed: true,
      perCategory: {
        "eletronicos/amazon": { ok: true, inserted: 12, updated: 40 },
        "casa/shopee": { ok: false, error: "timeout" },
      },
    },
  },
  {
    key: "scrapingError",
    label: "Scraping — com Erro",
    variables: [
      { name: "data", desc: "Data/hora da execução" },
      { name: "duracao", desc: "Duração do scraping" },
      { name: "novos", desc: "Qtd. de produtos novos" },
      { name: "atualizados", desc: "Qtd. de produtos atualizados" },
      { name: "removidos", desc: "Qtd. de produtos removidos" },
      { name: "total", desc: "Total no catálogo" },
      { name: "bloco_cancelado", desc: "Aviso de execução cancelada (quando houver)" },
      { name: "por_categoria", desc: "Lista por categoria e loja (modo detalhado)" },
      { name: "erro", desc: "Mensagem do erro ocorrido" },
    ],
    example: {
      data: "23/07/2026 14:30",
      duracao: "1m 02s",
      novos: 5,
      atualizados: 11,
      removidos: 0,
      total: 3408,
      cancelled: false,
      detailed: true,
      perCategory: {
        "eletronicos/amazon": { ok: false, error: "captcha" },
      },
      error: "Falha ao conectar no Mercado Livre (timeout)",
    },
  },
  {
    key: "scrapTesterOk",
    label: "Teste de Scraping — OK",
    variables: [
      { name: "data", desc: "Data/hora do teste" },
      { name: "duracao", desc: "Duração do teste" },
      { name: "amostra", desc: "Qtd. de produtos amostrados por loja" },
      { name: "categoria", desc: "Categoria usada na amostra" },
      { name: "por_loja", desc: "Resumo por loja (cobertura dos campos)" },
      { name: "problemas", desc: "Lista de campos abaixo do limiar (vazio quando OK)" },
    ],
    example: {
      data: "27/07/2026 09:00", duracao: "1m 40s", amostra: 10, categoria: "Eletrônicos",
      overall: "ok",
      perSource: {
        ml:     { label: "Mercado Livre", ok: true, sampled: 10, status: "ok", missing: [], fields: {} },
        amazon: { label: "Amazon",        ok: true, sampled: 10, status: "ok", missing: [], fields: {} },
        shopee: { label: "Shopee",        ok: true, sampled: 10, status: "ok", missing: [], fields: {} },
      },
    },
  },
  {
    key: "scrapTesterAlert",
    label: "Teste de Scraping — Problemas",
    variables: [
      { name: "data", desc: "Data/hora do teste" },
      { name: "duracao", desc: "Duração do teste" },
      { name: "amostra", desc: "Qtd. de produtos amostrados por loja" },
      { name: "categoria", desc: "Categoria usada na amostra" },
      { name: "por_loja", desc: "Resumo por loja (cobertura dos campos)" },
      { name: "problemas", desc: "Lista de campos abaixo do limiar" },
    ],
    example: {
      data: "27/07/2026 09:00", duracao: "2m 05s", amostra: 10, categoria: "Eletrônicos",
      overall: "fail",
      perSource: {
        ml: { label: "Mercado Livre", ok: true, sampled: 10, status: "ok", missing: [], fields: {} },
        amazon: {
          label: "Amazon", ok: true, sampled: 10, status: "warn", missing: ["rating", "reviewsCount"],
          fields: {
            rating:       { label: "Avaliação",        pct: 0,  minPct: 60, status: "warn" },
            reviewsCount: { label: "Nº de avaliações", pct: 10, minPct: 60, status: "warn" },
          },
        },
        shopee: { label: "Shopee", ok: false, sampled: 0, status: "fail", missing: [], fields: {}, error: "Nenhum produto retornado (possível bloqueio)" },
      },
    },
  },
  {
    key: "systemOnline",
    label: "Sistema Online",
    variables: [{ name: "data", desc: "Data/hora do boot" }],
    example: { data: "23/07/2026 08:00" },
  },
  {
    key: "test",
    label: "Teste de Notificação",
    variables: [{ name: "data", desc: "Data/hora do teste" }],
    example: { data: "23/07/2026 14:30" },
  },
];

const DEFAULT_CONFIG = {
  enabled: false,
  groupJid: null,
  groupName: null,
  // "detailed" = totais + quebra por categoria/loja; "summary" = só totais.
  scrapingDetail: "detailed",
  events: {
    scraping: true,
    scrapTester: true,
    errors: true,
    systemOnline: true,
  },
  templates: { ...DEFAULT_TEMPLATES },
};

function readConfig() {
  const raw = appConfig.get(CONFIG_KEY);
  if (!raw || typeof raw !== "object") return { ...DEFAULT_CONFIG, templates: { ...DEFAULT_TEMPLATES } };
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    events: { ...DEFAULT_CONFIG.events, ...(raw.events || {}) },
    templates: { ...DEFAULT_TEMPLATES, ...(raw.templates || {}) },
  };
}

function writeConfig(cfg) {
  const current = readConfig();
  const next = {
    ...current,
    ...cfg,
    events: { ...current.events, ...(cfg.events || {}) },
    templates: { ...current.templates, ...(cfg.templates || {}) },
  };
  next.enabled = !!next.enabled;
  if (next.scrapingDetail !== "summary" && next.scrapingDetail !== "detailed") {
    next.scrapingDetail = "detailed";
  }
  appConfig.set(CONFIG_KEY, next);
  return next;
}

// Substitui {chave} pelos valores em `vars` (desconhecidas viram ""), depois limpa
// linhas em branco duplicadas (deixadas por variáveis de bloco vazias) e apara as pontas.
function renderTemplate(str, vars) {
  const text = String(str || "").replace(/\{(\w+)\}/g, (_, key) => {
    const v = vars[key];
    return v === undefined || v === null ? "" : String(v);
  });
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Monta o bloco "por categoria e loja" a partir do resultado do scraping.
function buildPerCategoryBlock(result, detailed) {
  if (!detailed || !result || !result.perCategory || Object.keys(result.perCategory).length === 0) {
    return "";
  }
  const lines = ["*Por categoria e loja:*"];
  for (const [tag, info] of Object.entries(result.perCategory)) {
    if (info.ok) {
      lines.push(`• ${tag}: +${info.inserted} novos · ${info.updated} atualiz.`);
    } else {
      lines.push(`• ${tag}: ❌ ${info.error || "erro"}`);
    }
  }
  return lines.join("\n");
}

// Reúne as variáveis de um resultado de scraping (usado no envio real e na pré-visualização).
function scrapingVars(status, detailed) {
  const r = status.lastResult;
  return {
    data: formatDate(status.lastRun),
    duracao: formatDuration(status.lastDuration),
    novos: r ? r.inserted : 0,
    atualizados: r ? r.updated : 0,
    removidos: r ? (r.pruned || 0) : 0,
    total: r ? r.total : 0,
    bloco_cancelado: r && r.cancelled ? "⛔ Execução cancelada (resultado parcial)\n" : "",
    por_categoria: buildPerCategoryBlock(r, detailed),
    erro: status.lastError || "",
  };
}

// ── ScrapTester ────────────────────────────────────────────────────────────

const STATUS_ICON = { ok: "✅", warn: "⚠️", fail: "❌" };

// "• Amazon: 10 produtos · ⚠️ avaliação 0%" — uma linha por loja.
function buildPerSourceBlock(status) {
  const perSource = (status && status.perSource) || {};
  const lines = [];
  for (const [src, r] of Object.entries(perSource)) {
    const label = r.label || src;
    const icon = STATUS_ICON[r.status] || "";
    if (!r.ok) {
      lines.push(`• ${label}: ❌ ${r.error || "falhou"}`);
      continue;
    }
    const problems = (r.missing || [])
      .map(k => `${(r.fields?.[k]?.label || k).toLowerCase()} ${r.fields?.[k]?.pct ?? 0}%`)
      .join(", ");
    lines.push(`• ${label}: ${icon} ${r.sampled} produtos${problems ? ` · ${problems}` : " · todos os campos ok"}`);
  }
  return lines.join("\n");
}

// Detalhamento dos campos abaixo do limiar, agrupado por loja.
function buildProblemsBlock(status) {
  const perSource = (status && status.perSource) || {};
  const lines = [];
  for (const [src, r] of Object.entries(perSource)) {
    const label = r.label || src;
    if (!r.ok) {
      lines.push(`*${label}* — não foi possível amostrar: ${r.error || "erro desconhecido"}`);
      continue;
    }
    if (!r.missing || r.missing.length === 0) continue;
    lines.push(`*${label}*`);
    for (const k of r.missing) {
      const f = r.fields?.[k] || {};
      const icon = STATUS_ICON[f.status] || "⚠️";
      lines.push(`  ${icon} ${f.label || k}: ${f.pct ?? 0}% dos produtos (esperado ≥ ${f.minPct ?? 0}%)`);
    }
  }
  return lines.join("\n");
}

function scrapTesterVars(status) {
  return {
    data: formatDate(status.lastRun),
    duracao: formatDuration(status.lastDuration),
    amostra: status.sampleSize ?? 0,
    categoria: status.categoryLabel || status.category || "—",
    por_loja: buildPerSourceBlock(status),
    problemas: buildProblemsBlock(status),
  };
}

async function notifyScrapTesterResult(status) {
  const cfg = readConfig();
  if (!cfg.events.scrapTester) return;

  // Enviado a cada rodada — o template muda conforme o resultado.
  const key = status.overall === "ok" ? "scrapTesterOk" : "scrapTesterAlert";
  const template = cfg.templates[key] || DEFAULT_TEMPLATES[key];

  await send(renderTemplate(template, scrapTesterVars(status)));
}

// Lazy-require pra não criar dependência circular no boot (wa precisa de auth, etc)
function getWa() {
  return require("../whatsapp");
}

async function send(text) {
  const cfg = readConfig();
  const wn = whatsnimbus.readConfig();
  if (!cfg.enabled || !wn.numberId || !cfg.groupJid) return;
  try {
    await getWa().sendText(whatsnimbus.WHATSNIMBUS_USER_ID, String(wn.numberId), cfg.groupJid, text);
  } catch (err) {
    console.error("[admin-notifier] falha ao enviar mensagem:", err.message);
  }
}

function formatDuration(ms) {
  if (!ms) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

async function notifyScrapingResult(status) {
  const cfg = readConfig();
  if (!cfg.events.scraping) return;

  const hasError = !!status.lastError;
  const detailed = (cfg.scrapingDetail || "detailed") !== "summary";
  const key = hasError ? "scrapingError" : "scrapingSuccess";
  const template = cfg.templates[key] || DEFAULT_TEMPLATES[key];

  await send(renderTemplate(template, scrapingVars(status, detailed)));
}

async function notifyError(context, err) {
  const cfg = readConfig();
  if (!cfg.events.errors) return;

  const lines = [
    "*[Nimbus] 🚨 Erro Crítico*",
    `📅 ${formatDate(new Date().toISOString())}`,
    `Contexto: ${context}`,
    `Erro: ${err?.message || String(err)}`,
  ];

  await send(lines.join("\n"));
}

async function notifySystemOnline() {
  const cfg = readConfig();
  if (!cfg.events.systemOnline) return;

  const template = cfg.templates.systemOnline || DEFAULT_TEMPLATES.systemOnline;
  await send(renderTemplate(template, { data: formatDate(new Date().toISOString()) }));
}

async function sendTest() {
  const cfg = readConfig();
  const wn = whatsnimbus.readConfig();
  if (!wn.numberId) {
    throw new Error("Conecte o WhatsNimbus antes de testar.");
  }
  if (!cfg.groupJid) {
    throw new Error("Configure o grupo antes de testar.");
  }

  const template = cfg.templates.test || DEFAULT_TEMPLATES.test;
  const text = renderTemplate(template, { data: formatDate(new Date().toISOString()) });

  // Força envio mesmo com enabled=false para testar a config
  try {
    await getWa().sendText(whatsnimbus.WHATSNIMBUS_USER_ID, String(wn.numberId), cfg.groupJid, text);
  } catch (err) {
    throw new Error(`Falha ao enviar: ${err.message}`);
  }
}

// ── Modelos editáveis (menu "Modelos Notificações") ────────────────────────

function getTemplates() {
  const cfg = readConfig();
  return {
    templates: { ...DEFAULT_TEMPLATES, ...cfg.templates },
    defaults: { ...DEFAULT_TEMPLATES },
    meta: TEMPLATE_META,
  };
}

function saveTemplates(body) {
  const incoming = (body && body.templates) || {};
  const templates = {};
  for (const key of TEMPLATE_KEYS) {
    const v = incoming[key];
    // String vazia é permitida (some com um trecho); só ignora chaves não enviadas.
    if (typeof v === "string") templates[key] = v;
  }
  const saved = writeConfig({ templates });
  return {
    templates: { ...DEFAULT_TEMPLATES, ...saved.templates },
    defaults: { ...DEFAULT_TEMPLATES },
    meta: TEMPLATE_META,
  };
}

// Renderiza um texto de modelo com os valores de exemplo do TEMPLATE_META.
function renderPreview(key, text) {
  const meta = TEMPLATE_META.find((m) => m.key === key);
  const src = typeof text === "string" ? text : (readConfig().templates[key] || DEFAULT_TEMPLATES[key] || "");
  if (!meta) return renderTemplate(src, {});

  const ex = meta.example || {};
  let vars;
  if (key === "scrapingSuccess" || key === "scrapingError") {
    const status = {
      lastRun: null,
      lastDuration: null,
      lastResult: {
        inserted: ex.novos, updated: ex.atualizados, pruned: ex.removidos,
        total: ex.total, cancelled: ex.cancelled, perCategory: ex.perCategory,
      },
      lastError: ex.error || "",
    };
    vars = scrapingVars(status, ex.detailed !== false);
    // Datas de exemplo vêm prontas (não passam pelo formatDate real).
    vars.data = ex.data;
    vars.duracao = ex.duracao;
  } else if (key === "scrapTesterOk" || key === "scrapTesterAlert") {
    vars = scrapTesterVars({
      lastRun: null, lastDuration: null,
      sampleSize: ex.amostra, categoryLabel: ex.categoria,
      overall: ex.overall, perSource: ex.perSource,
    });
    vars.data = ex.data;
    vars.duracao = ex.duracao;
  } else {
    vars = { data: ex.data };
  }
  return renderTemplate(src, vars);
}

module.exports = {
  readConfig, writeConfig, notifyScrapingResult, notifyScrapTesterResult, notifyError, notifySystemOnline, sendTest,
  getTemplates, saveTemplates, renderPreview,
};
