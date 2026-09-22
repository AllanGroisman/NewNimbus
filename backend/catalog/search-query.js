// A sintaxe da busca por palavras-chave — uma regra só pro sistema inteiro: a aba
// de busca de produtos, o preenchimento da fila (os dois via catalog/pg.js) e o
// filtro em memória do scraper (scraping/scraper.js:applyFilters).
//
//   fone bluetooth        → o nome tem TODAS as palavras, em qualquer ordem
//   notebook, monitor     → vírgula separa ALTERNATIVAS (um grupo OU outro)
//   "sem fio"             → frase exata, como um pedaço contínuo do nome
//   -infantil             → fora quem tem a palavra (vale pra todos os grupos)
//
// Acento e caixa não contam dos dois lados: o nome é gravado normalizado na
// coluna `nameSearch` (catalog/pg.js:toRow) e os termos passam pela mesma função.
const { semAcento } = require("../repasse/coupon-words");

function normalizeText(s) {
  return semAcento(s).toLowerCase().replace(/\s+/g, " ").trim();
}

// Tokens: frase entre aspas, vírgula (separador de grupo) ou palavra solta. O `-`
// colado na frente vira exclusão — de palavra ou de frase (-"sem fio").
const TOKEN_RE = /(-?)"([^"]*)"?|(,)|([^\s,"]+)/g;

function parseSearch(raw) {
  const groups = [];
  const excludes = [];
  let atual = { words: [], phrases: [] };
  const fecha = () => {
    if (atual.words.length || atual.phrases.length) groups.push(atual);
    atual = { words: [], phrases: [] };
  };

  const texto = normalizeText(raw);
  for (const m of texto.matchAll(TOKEN_RE)) {
    if (m[3]) { fecha(); continue; }
    if (m[2] !== undefined) {
      const frase = m[2].trim();
      if (!frase) continue;
      if (m[1]) excludes.push(frase);
      else atual.phrases.push(frase);
      continue;
    }
    const tok = m[4];
    if (tok.startsWith("-")) {
      const w = tok.replace(/^-+/, "");
      if (w) excludes.push(w);
      continue;
    }
    atual.words.push(tok);
  }
  fecha();
  return { groups, excludes };
}

function isEmptySearch(parsed) {
  return !parsed || (!parsed.groups.length && !parsed.excludes.length);
}

// Versão em memória, pro filtro do scraper. `name` pode vir cru.
function matchesSearch(name, parsed) {
  if (isEmptySearch(parsed)) return true;
  const n = normalizeText(name);
  if (parsed.excludes.some(x => n.includes(x))) return false;
  if (!parsed.groups.length) return true;
  return parsed.groups.some(g =>
    g.words.every(w => n.includes(w)) && g.phrases.every(p => n.includes(p)));
}

// Termo → padrão de LIKE, com os curingas do usuário escapados (o `\` é o escape
// padrão do LIKE no Postgres).
function likePattern(term) {
  return "%" + String(term).replace(/[\\%_]/g, "\\$&") + "%";
}

module.exports = { normalizeText, parseSearch, isEmptySearch, matchesSearch, likePattern };
