// Monta o e-mail final: bloco do catálogo + override do Admin + variáveis.
//
// Fluxo: catalog.default → override salvo em app_config ("email-templates") →
// substituição de {variaveis} → layout.render() → { subject, html, text }.
//
// Dois modos de substituição, porque layout.js escapa alguns campos e outros não:
//   - texto puro (subject, title, greeting, rótulo do botão): o layout escapa
//     depois, então aqui vai texto cru, só sem os marcadores de negrito;
//   - HTML (parágrafos e rodapé): o layout insere como veio, então é AQUI que
//     tudo é escapado. Nada que o admin digite chega como HTML no e-mail.
//
// Um valor de variável pode vir como { __html, __text } quando o código precisa
// injetar marcação de verdade (o link clicável dos e-mails de token). Só o
// código produz isso — nunca o texto editado na tela.

const appConfig = require("../../config");
const layout = require("./layout");
const catalog = require("./catalog");

const CONFIG_KEY = "email-templates";

// Campos que o Admin pode sobrescrever. Qualquer outra chave enviada é ignorada.
const FIELDS = ["subject", "title", "greeting", "paragraphs", "ctaLabel", "footnote", "tone"];

// ── Substituição ──────────────────────────────────────────────────────────

// *texto* → <strong>texto</strong>. Não atravessa quebra de linha pra um
// asterisco solto não engolir o resto do e-mail.
function bold(s) {
  return s.replace(/\*([^*\n]+)\*/g, "<strong>$1</strong>");
}

function stripBold(s) {
  return s.replace(/\*([^*\n]+)\*/g, "$1");
}

function valueHtml(v) {
  if (v && typeof v === "object" && "__html" in v) return String(v.__html);
  return bold(layout.esc(v === undefined || v === null ? "" : String(v)));
}

function valuePlain(v) {
  if (v && typeof v === "object") {
    if ("__text" in v) return String(v.__text);
    if ("__html" in v) return String(v.__html).replace(/<[^>]+>/g, "");
  }
  return stripBold(v === undefined || v === null ? "" : String(v));
}

// Troca {chave} pelos valores. Variável desconhecida vira "" — um {typo} não
// pode vazar chaves no e-mail do cliente.
function substituir(tpl, vars, valor) {
  return String(tpl || "").replace(/\{(\w+)\}/g, (_, key) => valor(vars[key]));
}

// Campos que o layout escapa depois (assunto, título, saudação, botão): texto
// cru, só sem os marcadores de negrito.
function fillPlain(tpl, vars) {
  return stripBold(substituir(tpl, vars, valuePlain)).replace(/\s+/g, " ").trim();
}

// Campos que o layout insere como vieram (parágrafos e rodapé). O gabarito é
// escapado ANTES da substituição: assim só o texto do admin passa pelo esc(), e
// os valores — que já saíram prontos de valueHtml() — não são escapados 2x.
function fillHtml(tpl, vars) {
  const gabarito = bold(layout.esc(String(tpl || ""))).replace(/\n/g, "<br>");
  return substituir(gabarito, vars, valueHtml);
}

// ── Override salvo pelo Admin ─────────────────────────────────────────────

function overrides() {
  const raw = appConfig.get(CONFIG_KEY);
  return raw && typeof raw === "object" ? raw : {};
}

// Bloco efetivo de um e-mail: o padrão do catálogo com o override por cima,
// campo a campo (um override antigo sem `footnote` não apaga o rodapé padrão).
function blockFor(key) {
  const spec = catalog.get(key);
  if (!spec) return null;
  const ov = overrides()[key] || {};
  const block = { ...spec.default, paragraphs: [...spec.default.paragraphs] };
  for (const f of FIELDS) {
    if (ov[f] === undefined) continue;
    if (f === "paragraphs") {
      if (Array.isArray(ov.paragraphs)) block.paragraphs = ov.paragraphs.map(p => String(p ?? ""));
    } else {
      block[f] = String(ov[f] ?? "");
    }
  }
  return block;
}

// Os 4 e-mails de link não podem ser desligados: sem "confirme seu e-mail" o
// cadastro não fecha, e sem "redefinir senha" quem esqueceu a senha fica de fora.
function isEnabled(key) {
  const spec = catalog.get(key);
  if (!spec || !spec.canDisable) return true;
  return overrides()[key]?.enabled !== false;
}

// ── Render ────────────────────────────────────────────────────────────────

// `vars` são os valores já prontos (o código resolve datas, plurais e frases
// condicionais antes de chegar aqui). `ctaUrl` só é passado pelos e-mails de
// token — o resto tem o link fixo declarado no catálogo.
function renderEmail(key, vars = {}, opts = {}) {
  const spec = catalog.get(key);
  if (!spec) throw new Error(`[email] e-mail desconhecido no catálogo: ${key}`);
  const block = opts.block || blockFor(key);

  // Parágrafo que usa uma variável condicional sem valor some inteiro: falar em
  // "campanhas pausadas" quando nada foi pausado sobraria uma frase quebrada.
  const vazias = spec.variables
    .filter(v => v.condicional && !String(vars[v.name] ?? "").trim())
    .map(v => `{${v.name}}`);

  const paragraphs = block.paragraphs
    .filter(p => !vazias.some(token => String(p).includes(token)))
    .map(p => fillHtml(p, vars))
    .map(p => p.trim())
    .filter(Boolean);

  const ctaLabel = fillPlain(block.ctaLabel, vars);
  const ctaUrl = opts.ctaUrl || spec.ctaUrl || "";
  const greeting = fillPlain(block.greeting, vars);
  const footnote = fillHtml(block.footnote, vars).trim();

  return layout.render({
    subject: fillPlain(block.subject, vars),
    title: fillPlain(block.title, vars),
    greeting,
    paragraphs,
    cta: ctaLabel && ctaUrl ? { label: ctaLabel, url: ctaUrl } : null,
    footnote: footnote || null,
    tone: block.tone === "warn" ? "warn" : "normal",
  });
}

// ── API do Admin ──────────────────────────────────────────────────────────

function getTemplates() {
  const templates = {};
  for (const key of catalog.KEYS) {
    templates[key] = { ...blockFor(key), enabled: isEnabled(key) };
  }
  return { templates, defaults: catalog.defaults(), meta: catalog.meta(), groups: catalog.GROUPS };
}

// Guarda só o que o admin mandou, campo a campo, depois de normalizar. Chave
// desconhecida é erro (dedo trocado no front não deve virar lixo no banco).
function saveTemplates(body) {
  const incoming = (body && body.templates) || {};
  const next = {};

  for (const [key, value] of Object.entries(incoming)) {
    const spec = catalog.get(key);
    if (!spec) throw new Error(`E-mail desconhecido: ${key}`);
    if (!value || typeof value !== "object") continue;

    const saved = {};
    for (const f of FIELDS) {
      if (value[f] === undefined) continue;
      if (f === "paragraphs") {
        if (!Array.isArray(value.paragraphs)) throw new Error(`Parágrafos inválidos em "${spec.label}"`);
        saved.paragraphs = value.paragraphs.map(p => String(p ?? "").trim()).filter(Boolean);
      } else if (f === "tone") {
        saved.tone = value.tone === "warn" ? "warn" : "normal";
      } else {
        saved[f] = String(value[f] ?? "").trim();
      }
    }
    if (!String(saved.subject ?? spec.default.subject).trim()) {
      throw new Error(`O assunto de "${spec.label}" não pode ficar vazio`);
    }
    // Só os 16 avisos podem ser desligados; nos de link o campo é ignorado.
    if (spec.canDisable && value.enabled !== undefined) saved.enabled = !!value.enabled;

    next[key] = saved;
  }

  appConfig.set(CONFIG_KEY, next);
  return getTemplates();
}

// Valores de exemplo do catálogo, prontos pra render (o {link} dos e-mails de
// token vira âncora). Usado pela pré-visualização e pelo envio de teste.
function exampleVars(key) {
  const spec = catalog.get(key);
  if (!spec) throw new Error(`E-mail desconhecido: ${key}`);
  const vars = { ...spec.example };
  if (vars.link) vars.link = linkVar(String(vars.link));
  return vars;
}

// Pré-visualização de um bloco AINDA NÃO SALVO, com os valores de exemplo.
// Nada é gravado: o bloco vai direto pro render. Sem bloco, mostra o que está
// salvo hoje.
function renderPreview(key, block) {
  const spec = catalog.get(key);
  const vars = exampleVars(key);
  // Nos e-mails de token o botão aponta pro link gerado no envio; na prévia usa
  // o link de exemplo, senão o botão sumiria justo nos 4 mais importantes.
  const ctaUrl = spec.group === "token" ? String(spec.example.link || "") : undefined;

  if (!block || typeof block !== "object") return renderEmail(key, vars, { ctaUrl });

  const base = blockFor(key);
  const merged = { ...base };
  for (const f of FIELDS) {
    if (block[f] === undefined) continue;
    merged[f] = f === "paragraphs"
      ? (Array.isArray(block.paragraphs) ? block.paragraphs.map(p => String(p ?? "")) : base.paragraphs)
      : String(block[f] ?? "");
  }
  return renderEmail(key, vars, { block: merged, ctaUrl });
}

// Link clicável dos e-mails de token: no HTML vira âncora, no texto puro vira a
// URL crua (baseText tira as tags).
function linkVar(url) {
  const safe = layout.escUrl(url);
  return { __html: `<a href="${safe}" style="color:#2563EB">${layout.esc(url)}</a>`, __text: url };
}

module.exports = {
  CONFIG_KEY, FIELDS,
  renderEmail, renderPreview, exampleVars, blockFor, isEnabled,
  getTemplates, saveTemplates, linkVar,
};
