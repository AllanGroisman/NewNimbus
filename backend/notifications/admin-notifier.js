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
  afiliadoCookieExpirado: [
    "*[Nimbus] 🔑 Cookie de Afiliado Vencido*",
    "📅 {data}",
    "Conta: {tag}",
    "",
    "O Mercado Livre recusou o cookie ao gerar link de afiliado.",
    "Enquanto isso, os links dessa conta não são convertidos e os itens são descartados no envio.",
    "",
    "O que fazer: colar um cookie novo em Configurações › Afiliados.",
  ].join("\n"),
  afiliadoCookieOk: [
    "*[Nimbus] ✅ Cookie de Afiliado Normalizado*",
    "📅 {data}",
    "Conta: {tag}",
    "",
    "A geração de link de afiliado do Mercado Livre voltou a funcionar.",
  ].join("\n"),
  bloqueioDetectado: [
    "*[Nimbus] 🚧 Bloqueio no Scraping*",
    "📅 {data}",
    "Onde: {alvo}",
    "Motivo: {motivo}",
    "",
    "{o_que}",
    "",
    "{falhas} falhas seguidas, sem nenhum sucesso desde {desde}.",
    "{clientes}",
    "O que fazer: {o_que_fazer}",
  ].join("\n"),
  bloqueioNormalizado: [
    "*[Nimbus] ✅ Bloqueio Normalizado*",
    "📅 {data}",
    "Onde: {alvo}",
    "",
    "{motivo} parou de acontecer — o scraping voltou a passar.",
  ].join("\n"),
  cuponsListaFim: [
    "*[Nimbus] 🎟 Cupons · Etapa 1 (lista) concluída*",
    "📅 {data} · ⏱ {duracao}",
    "{origem}",
    "🎟 {cupons} cupons · {novos} novos · {atualizados} atualizados",
    "✅ {ativados} ativados · {de_loja} de loja",
    "{bloco_aviso}",
  ].join("\n"),
  cuponsProdutosFim: [
    "*[Nimbus] 🛍 Cupons · Etapa 2 (produtos) concluída*",
    "📅 {data} · ⏱ {duracao}",
    "{origem}",
    "✅ {ativados} ativados · {colhidos} de {tentados} vitrines colhidas",
    "📦 {produtos} produtos · {parciais} parciais · {vazias} vazias · {falharam} falharam",
    "{bloco_aviso}",
  ].join("\n"),
  cuponsTudoFim: [
    "*[Nimbus] 🎟 Cupons · Etapa 3 (buscar TUDO) concluída*",
    "📅 {data} · ⏱ {duracao}",
    "{origem}",
    "🎟 {cupons_na_lista} cupons na lista · {ciclos} ciclos",
    "✅ {ativados} ativados · 📦 {produtos} produtos em {colhidos} vitrines",
    "⏳ {ficaram_de_fora} ficaram sem vitrine",
    "{bloco_aviso}",
  ].join("\n"),
  cuponsErro: [
    "*[Nimbus] 🚨 Cupons · {etapa} interrompida*",
    "📅 {data} · ⏱ {duracao}",
    "{origem}",
    "{resumo}",
    "",
    "Motivo: {erro}",
  ].join("\n"),
  cuponsAgendaPulada: [
    "*[Nimbus] ⏭ Cupons · {etapa} das {horario} não rodou*",
    "📅 {data}",
    "Motivo: {motivo}",
    "",
    "A agenda dos cupons roda no Chrome do admin: deixe a aba Admin › Cupom › Cupons do ML aberta, com a extensão instalada.",
  ].join("\n"),
  test: [
    "*[Nimbus] 🔔 Teste de Notificação*",
    "📅 {data}",
    "As notificações do sistema estão configuradas corretamente.",
  ].join("\n"),
};

const TEMPLATE_KEYS = Object.keys(DEFAULT_TEMPLATES);

// As variáveis que todo aviso de fim de etapa de cupons tem.
const CUPONS_VARS_COMUNS = [
  { name: "data", desc: "Data/hora do fim da etapa" },
  { name: "duracao", desc: "Duração da etapa" },
  { name: "origem", desc: "Agendada (com o horário) ou manual" },
  { name: "bloco_aviso", desc: "Aviso que a etapa deixou (teto de páginas etc.), quando houver" },
];

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
  {
    key: "afiliadoCookieExpirado",
    label: "Cookie de afiliado vencido",
    variables: [
      { name: "data", desc: "Data/hora do aviso" },
      { name: "tag", desc: "TAG de afiliado da conta afetada" },
    ],
    example: { data: "25/08/2026 19:33", tag: "allangroisman" },
  },
  {
    key: "bloqueioDetectado",
    label: "Bloqueio de scraping detectado",
    variables: [
      { name: "data", desc: "Data/hora do aviso" },
      { name: "alvo", desc: "Onde travou (ex.: Repasse · Mercado Livre)" },
      { name: "motivo", desc: "Tipo do bloqueio (CAPTCHA, muro de login…)" },
      { name: "o_que", desc: "O que aconteceu, na linguagem do painel de Repasse" },
      { name: "o_que_fazer", desc: "A orientação — esperar ou agir" },
      { name: "falhas", desc: "Quantas falhas seguidas do mesmo tipo" },
      { name: "desde", desc: "Hora da primeira falha da sequência" },
      { name: "clientes", desc: "Clientes atingidos (vazio quando não se aplica)" },
    ],
    example: {
      data: "25/08/2026 15:12",
      alvo: "Repasse · Mercado Livre",
      motivo: "CAPTCHA",
      o_que: "A loja exigiu verificação anti-robô e a página do produto não abriu.",
      o_que_fazer: "Bloqueio passageiro — nada a fazer agora. Se durar horas seguidas, o jeito de raspar a página é que precisa mudar.",
      falhas: 90,
      desde: "25/08/2026 14:03",
      clientes: "Clientes atingidos: Allan, Marina\n",
    },
  },
  {
    key: "bloqueioNormalizado",
    label: "Bloqueio de scraping normalizado",
    variables: [
      { name: "data", desc: "Data/hora do aviso" },
      { name: "alvo", desc: "Onde havia travado" },
      { name: "motivo", desc: "Tipo do bloqueio que parou" },
    ],
    example: { data: "25/08/2026 17:40", alvo: "Repasse · Mercado Livre", motivo: "CAPTCHA" },
  },
  {
    key: "cuponsListaFim",
    label: "Cupons — Etapa 1 (lista) concluída",
    variables: [
      ...CUPONS_VARS_COMUNS,
      { name: "cupons", desc: "Cupons lidos na lista" },
      { name: "novos", desc: "Cupons novos" },
      { name: "atualizados", desc: "Cupons atualizados" },
      { name: "ativados", desc: "Cupons ativados (\"Eu quero\")" },
      { name: "de_loja", desc: "Cupons de uma loja só" },
    ],
    example: {
      data: "23/09/2026 08:00", duracao: "3m 12s", origem: "⏰ Agendada (08:00)",
      cupons: 1134, novos: 18, atualizados: 1116, ativados: 0, de_loja: 212, bloco_aviso: "",
    },
  },
  {
    key: "cuponsProdutosFim",
    label: "Cupons — Etapa 2 (produtos) concluída",
    variables: [
      ...CUPONS_VARS_COMUNS,
      { name: "ativados", desc: "Cupons ativados (\"Eu quero\")" },
      { name: "tentados", desc: "Vitrines tentadas" },
      { name: "colhidos", desc: "Vitrines colhidas" },
      { name: "produtos", desc: "Produtos gravados" },
      { name: "parciais", desc: "Vitrines lidas pela metade" },
      { name: "vazias", desc: "Vitrines sem produto" },
      { name: "falharam", desc: "Vitrines que falharam" },
    ],
    example: {
      data: "23/09/2026 09:00", duracao: "24m 40s", origem: "👆 Manual",
      ativados: 20, tentados: 60, colhidos: 55, produtos: 8210, parciais: 3, vazias: 4, falharam: 1, bloco_aviso: "",
    },
  },
  {
    key: "cuponsTudoFim",
    label: "Cupons — Etapa 3 (buscar TUDO) concluída",
    variables: [
      ...CUPONS_VARS_COMUNS,
      { name: "cupons_na_lista", desc: "Cupons lidos na lista" },
      { name: "ciclos", desc: "Ciclos da etapa 2" },
      { name: "ativados", desc: "Cupons ativados (\"Eu quero\")" },
      { name: "colhidos", desc: "Vitrines colhidas" },
      { name: "produtos", desc: "Produtos gravados" },
      { name: "ficaram_de_fora", desc: "Cupons tentados que não deram vitrine" },
    ],
    example: {
      data: "23/09/2026 03:00", duracao: "1h 12m", origem: "⏰ Agendada (03:00)",
      cupons_na_lista: 1134, ciclos: 4, ativados: 96, colhidos: 310, produtos: 41220, ficaram_de_fora: 7,
      bloco_aviso: "⚠️ A lista parou no teto de 40 páginas.",
    },
  },
  {
    key: "cuponsErro",
    label: "Cupons — etapa interrompida",
    variables: [
      ...CUPONS_VARS_COMUNS.filter(v => v.name !== "bloco_aviso"),
      { name: "etapa", desc: "Qual etapa (1, 2 ou 3)" },
      { name: "resumo", desc: "O que a etapa chegou a fazer antes de parar" },
      { name: "erro", desc: "Por que parou (muro de verificação do ML, erro, parada manual…)" },
    ],
    example: {
      data: "23/09/2026 09:00", duracao: "6m 03s", origem: "⏰ Agendada (09:00)", etapa: "Etapa 2 · Produtos",
      resumo: "✅ 8 ativados · 📦 1.240 produtos em 12 vitrines",
      erro: "o Mercado Livre pediu verificação e ninguém resolveu a tempo",
    },
  },
  {
    key: "cuponsAgendaPulada",
    label: "Cupons — horário agendado não rodou",
    variables: [
      { name: "data", desc: "Data/hora do aviso" },
      { name: "etapa", desc: "Qual etapa (1, 2 ou 3)" },
      { name: "horario", desc: "O horário agendado que se perdeu" },
      { name: "motivo", desc: "Por que não rodou" },
    ],
    example: {
      data: "23/09/2026 08:16", etapa: "Etapa 1 · Lista", horario: "08:00",
      motivo: "a aba de cupons do admin não estava aberta (ou ficou ocupada com outra rodada)",
    },
  },
  {
    key: "afiliadoCookieOk",
    label: "Cookie de afiliado normalizado",
    variables: [
      { name: "data", desc: "Data/hora do aviso" },
      { name: "tag", desc: "TAG de afiliado da conta afetada" },
    ],
    example: { data: "25/08/2026 20:10", tag: "allangroisman" },
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
    afiliadoCookie: true,
    bloqueios: true,
    cupons: true,
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

// Uma mensagem NOSSA que o destinatário pediu de volta muitas vezes: cada pedido
// é a prova de que alguém está vendo "Aguardando mensagem. Essa ação pode levar
// alguns instantes". Num grupo isso escala pelo número de participantes e passa
// despercebido — o envio some como "ok" e o problema só chega por reclamação.
// Quem conta e segura o gatilho é o whatsapp/msg-store.js; aqui é só o envio.
async function notifyRetryStorm({ id, retries, jid } = {}) {
  const cfg = readConfig();
  if (!cfg.events.errors) return;

  const lines = [
    "*[Nimbus] ⏳ Mensagem presa em \"Aguardando mensagem\"*",
    `📅 ${formatDate(new Date().toISOString())}`,
    `Destino: ${jid || "—"}`,
    `Mensagem: ${id}`,
    `Pedidos de reenvio: ${retries}`,
    "",
    "Cada pedido é um aparelho que não conseguiu abrir a mensagem.",
    "Ver backend/whatsapp/README.md → \"Aguardando mensagem\".",
  ];

  await send(lines.join("\n"));
}

async function notifySystemOnline() {
  const cfg = readConfig();
  if (!cfg.events.systemOnline) return;

  const template = cfg.templates.systemOnline || DEFAULT_TEMPLATES.systemOnline;
  await send(renderTemplate(template, { data: formatDate(new Date().toISOString()) }));
}

// Cookie de afiliado do ML vencido (HTTP 401/403 no createLink) e sua recuperação.
// Quem decide QUANDO chamar é o affiliate-alert.js — aqui é só o envio.
async function notifyMLCookieExpired({ tag } = {}) {
  const cfg = readConfig();
  if (!cfg.events.afiliadoCookie) return;
  const template = cfg.templates.afiliadoCookieExpirado || DEFAULT_TEMPLATES.afiliadoCookieExpirado;
  await send(renderTemplate(template, { data: formatDate(new Date().toISOString()), tag: tag || "—" }));
}

async function notifyMLCookieRecovered({ tag } = {}) {
  const cfg = readConfig();
  if (!cfg.events.afiliadoCookie) return;
  const template = cfg.templates.afiliadoCookieOk || DEFAULT_TEMPLATES.afiliadoCookieOk;
  await send(renderTemplate(template, { data: formatDate(new Date().toISOString()), tag: tag || "—" }));
}

// Bloqueio de scraping que se repete (repasse, Hub, cupons) e sua recuperação.
// Quem conta a sequência e segura o gatilho é o block-alert.js — aqui é só o envio.
async function notifyBlockDetected(vars = {}) {
  const cfg = readConfig();
  if (!cfg.events.bloqueios) return;
  const template = cfg.templates.bloqueioDetectado || DEFAULT_TEMPLATES.bloqueioDetectado;
  await send(renderTemplate(template, { data: formatDate(new Date().toISOString()), ...vars }));
}

async function notifyBlockRecovered(vars = {}) {
  const cfg = readConfig();
  if (!cfg.events.bloqueios) return;
  const template = cfg.templates.bloqueioNormalizado || DEFAULT_TEMPLATES.bloqueioNormalizado;
  await send(renderTemplate(template, { data: formatDate(new Date().toISOString()), ...vars }));
}

// ── Cupons do ML (task 4) ──────────────────────────────────────────────────

const ETAPAS_CUPONS = { lista: "Etapa 1 · Lista", produtos: "Etapa 2 · Produtos", tudo: "Etapa 3 · Buscar TUDO" };
const TEMPLATE_DO_BOTAO = { lista: "cuponsListaFim", produtos: "cuponsProdutosFim", tudo: "cuponsTudoFim" };

const numero = (n) => (Number(n) || 0).toLocaleString("pt-BR");

// Uma linha com o que a etapa fez — é o corpo do aviso de etapa interrompida.
function resumoCupons(botao, r = {}) {
  if (botao === "lista") return `🎟 ${numero(r.cupons)} cupons · ${numero(r.novos)} novos · ✅ ${numero(r.ativados)} ativados`;
  if (botao === "produtos") return `✅ ${numero(r.ativados)} ativados · 📦 ${numero(r.produtos)} produtos em ${numero(r.colhidos)} vitrines`;
  return `🎟 ${numero(r.cuponsNaLista)} cupons na lista · ✅ ${numero(r.ativados)} ativados · 📦 ${numero(r.produtos)} produtos em ${numero(r.colhidos)} vitrines`;
}

// As variáveis do aviso de fim de um botão, a partir do balanço dele
// (`ultimas[botao]` em coupons/sync.js). `slot` é o horário agendado, ou null
// quando a rodada foi manual.
function cuponsVars(botao, ultima, { slot = null } = {}) {
  const r = ultima?.resultado || {};
  return {
    data: formatDate(ultima?.at || new Date().toISOString()),
    duracao: formatDuration(ultima?.duracaoMs),
    origem: slot ? `⏰ Agendada (${slot})` : "👆 Manual",
    etapa: ETAPAS_CUPONS[botao] || botao,
    bloco_aviso: ultima?.erro ? `⚠️ ${ultima.erro}` : "",
    erro: ultima?.erro || "interrompida",
    resumo: resumoCupons(botao, r),
    cupons: numero(r.cupons),
    novos: numero(r.novos),
    atualizados: numero(r.atualizados),
    de_loja: numero(r.cuponsDeLojaIgnorados),
    ativados: numero(r.ativados),
    tentados: numero(r.tentados),
    colhidos: numero(r.colhidos),
    produtos: numero(r.produtos),
    parciais: numero(r.parciais),
    vazias: numero(r.vazias),
    falharam: numero(r.falharam),
    cupons_na_lista: numero(r.cuponsNaLista),
    ciclos: numero(r.ciclos),
    ficaram_de_fora: numero(r.ficaramDeFora),
  };
}

// Qual modelo vai. "Interrompida" é a etapa que PAROU (muro do ML, erro, Parar):
// um aviso sem parada (o teto de páginas da lista) sai no modelo normal, como bloco.
function templateDosCupons(botao, ultima) {
  return ultima?.interrompida ? "cuponsErro" : TEMPLATE_DO_BOTAO[botao];
}

async function notifyCuponsRodada(botao, ultima, { slot = null } = {}) {
  const cfg = readConfig();
  if (!cfg.events.cupons || !TEMPLATE_DO_BOTAO[botao] || !ultima) return;
  const key = templateDosCupons(botao, ultima);
  const template = cfg.templates[key] || DEFAULT_TEMPLATES[key];
  await send(renderTemplate(template, cuponsVars(botao, ultima, { slot })));
}

async function notifyCuponsAgendaPulada(botao, horario, motivo) {
  const cfg = readConfig();
  if (!cfg.events.cupons) return;
  const template = cfg.templates.cuponsAgendaPulada || DEFAULT_TEMPLATES.cuponsAgendaPulada;
  await send(renderTemplate(template, {
    data: formatDate(new Date().toISOString()),
    etapa: ETAPAS_CUPONS[botao] || botao,
    horario: horario || "—",
    motivo: motivo || "—",
  }));
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
    // Todas as variáveis do exemplo, não só a data: modelo novo com variável
    // própria (ex.: {tag}) sairia com o campo vazio na pré-visualização.
    vars = { ...ex };
  }
  return renderTemplate(src, vars);
}

module.exports = {
  readConfig, writeConfig, notifyMLCookieExpired, notifyMLCookieRecovered, notifyBlockDetected, notifyBlockRecovered, notifyScrapingResult, notifyScrapTesterResult, notifyError, notifySystemOnline, notifyRetryStorm, sendTest,
  notifyCuponsRodada, notifyCuponsAgendaPulada, cuponsVars, templateDosCupons,
  getTemplates, saveTemplates, renderPreview,
};
