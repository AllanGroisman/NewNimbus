// Layout compartilhado dos e-mails transacionais.
//
// Mesmo visual dos e-mails de token (auth/mailer.js): bloco sans-serif de 480px,
// botão azul, rodapé cinza pequeno. Aqui o HTML é montado por função em vez de
// escrito à mão em cada template — assim todo valor interpolado passa por esc()
// e um template novo não tem como esquecer.

const BLUE  = "#2563EB"; // ação normal
const AMBER = "#B45309"; // aviso de cobrança em risco (cartão falhou, carência)

// Escapa para contexto de texto/atributo HTML. `null`/`undefined` viram "" em
// vez de "null"/"undefined" no corpo do e-mail.
function esc(v) {
  if (v === null || v === undefined) return "";
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// URL em href: encodeURI normaliza espaços/acentos, esc protege o atributo.
function escUrl(u) {
  return esc(encodeURI(String(u || "")));
}

function paragraphsHtml(paragraphs) {
  return (paragraphs || [])
    .filter(Boolean)
    .map(p => `<p style="margin:0 0 16px;color:#555;line-height:1.5">${p}</p>`)
    .join("\n        ");
}

// `paragraphs` aceita HTML já montado pelo template (com <strong>), então cabe
// ao template escapar o que vem de fora — daí `esc` ser exportado.
function baseLayout({ title, greeting, paragraphs, cta, footnote, tone }) {
  const color = tone === "warn" ? AMBER : BLUE;
  // Saudação em linha própria: "Senha alterada, Ana" leria mal como título.
  const hello = greeting
    ? `<p style="margin:0 0 16px;color:#555;line-height:1.5">Olá, ${esc(greeting)}!</p>`
    : "";
  const button = cta
    ? `<a href="${escUrl(cta.url)}" style="display:inline-block;padding:12px 28px;background:${color};color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:15px">
          ${esc(cta.label)}
        </a>`
    : "";
  const foot = footnote
    ? `<p style="margin:24px 0 0;font-size:12px;color:#888">${footnote}</p>`
    : "";

  return `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 16px;color:#1a1a1a">
        <h2 style="margin:0 0 16px">${esc(title)}</h2>
        ${hello}
        ${paragraphsHtml(paragraphs)}
        ${button}
        ${foot}
      </div>`;
}

// Versão texto puro do mesmo conteúdo — clientes que não renderizam HTML e
// filtros de spam que penalizam e-mail só-HTML. Tira as tags que os templates
// usam nos parágrafos (<strong>, <a>) em vez de exigir dois textos por e-mail.
function stripTags(s) {
  return String(s || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function baseText({ title, greeting, paragraphs, cta, footnote }) {
  const lines = [title, ""];
  if (greeting) lines.push(`Olá, ${greeting}!`, "");
  for (const p of (paragraphs || []).filter(Boolean)) lines.push(stripTags(p), "");
  if (cta) lines.push(`${cta.label}: ${cta.url}`, "");
  if (footnote) lines.push(stripTags(footnote));
  return lines.join("\n").trim();
}

// Atalho: todo template devolve { subject, html, text } a partir do mesmo bloco.
function render(block) {
  return {
    subject: block.subject,
    html: baseLayout(block),
    text: baseText(block),
  };
}

module.exports = { esc, escUrl, baseLayout, baseText, render, BLUE, AMBER };
