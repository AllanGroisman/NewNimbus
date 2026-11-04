// Lista branca e lista negra de palavras do repasse, por campanha.
//
//   scraping.repasse.allowWords = ["fone", "notebook"]  → só entra produto cujo
//                                                         nome tenha UMA delas
//   scraping.repasse.blockWords = ["infantil"]           → nome com uma delas sai
//
// A negra ganha da branca. Lista vazia não filtra nada. Compara o NOME do
// produto (o que veio da página da loja), sem acento nem caixa, pelo começo da
// palavra: "fone" pega "fones", mas "pc" não pega "upc".
//
// Quem decide é o capture.js; este módulo é puro (só lê a flag do admin).
const { normalizeText } = require("../catalog/search-query");
const featureFlags = require("../feature-flags");

const MAX_WORDS = 40;
const MAX_WORD_LEN = 30;

// Tudo que não é letra nem número vira espaço: "fone-de-ouvido" vira três
// palavras e a pontuação do nome não atrapalha o começo de palavra.
function tokensText(s) {
  return " " + normalizeText(s).replace(/[^\p{L}\p{N}]+/gu, " ").trim() + " ";
}

function sanitizeWords(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    const w = String(item ?? "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, MAX_WORD_LEN).trim();
    if (w && !out.includes(w)) out.push(w);
    if (out.length >= MAX_WORDS) break;
  }
  return out;
}

// Listas da campanha. Com a função desligada no admin, volta tudo vazio — as
// listas salvas ficam guardadas, só não valem.
function wordFilterOf(group) {
  if (!featureFlags.isOn("repasseWordFilter")) return { allow: [], block: [] };
  const rp = group?.scraping?.repasse || {};
  return { allow: sanitizeWords(rp.allowWords), block: sanitizeWords(rp.blockWords) };
}

function hasWord(haystack, word) {
  const w = tokensText(word).trim();
  if (!w) return false;
  return haystack.includes(" " + w);
}

function checkName(name, { allow = [], block = [] } = {}) {
  const n = tokensText(name);
  const proibida = block.find(w => hasWord(n, w));
  if (proibida) return { ok: false, list: "block", reason: `palavra da lista negra: "${proibida}"` };
  if (allow.length) {
    const achada = allow.find(w => hasWord(n, w));
    if (!achada) return { ok: false, list: "allow", reason: "nenhuma palavra da lista branca no nome" };
    return { ok: true, reason: `tem "${achada}" da lista branca` };
  }
  return { ok: true, reason: "nenhuma palavra da lista negra" };
}

function isActive(filter) {
  return !!(filter && (filter.allow?.length || filter.block?.length));
}

module.exports = { sanitizeWords, wordFilterOf, checkName, isActive, MAX_WORDS, MAX_WORD_LEN };
