// As palavras que fazem o repasse reconhecer o PREÇO escrito na legenda do grupo
// líder ("Por: R$ 1.520", "R$ 1.520 no Pix").
//
// Existe por causa da Shopee: a API de afiliados só devolve o preço de vitrine, e
// o preço com Pix + cupom (o que o grupo líder divulga) só aparece na página, que
// barra navegador automático. O grupo líder já escreve esse preço no texto — então
// lemos de lá, do mesmo jeito que o cupom (coupon-words.js): a lista mora em
// app_config e o admin edita pela tela.
//
// Este módulo NÃO conhece mensagem nem loja: só guarda a config e monta a regex.
// Quem lê a legenda e decide se troca o preço é o capture.js.
const appConfig = require("../config");
const { accentInsensitive, semAcento } = require("./coupon-words");

const CONFIG_KEY = "repasse-price-config";

const DEFAULTS = {
  // Palavra que precisa vir logo ANTES do valor. "r$" cobre "De R$ 1.999" e
  // "R$1.520"; as outras pegam quem escreve o número solto ("por 1520").
  triggers: ["r$", "por", "pix", "apenas", "só", "sai"],
  // Palavras coladas no valor (as 2 antes ou a 1ª depois) que mostram que ele
  // NÃO é o preço do produto: "R$ 20 OFF", "desconto de R$ 50", "frete R$ 15",
  // "economize R$ 200". "cupom" fica de fora de propósito: "Com cupom: R$ 1.520"
  // é exatamente o preço que queremos; o "cupom de R$ 20" é barrado pelo minPct.
  // Parcela ("12x de R$ 145") é regra fixa no capture.js, não precisa estar aqui.
  ignore: ["off", "desconto", "frete", "cashback", "economize", "economia", "parcela", "parcelas", "juros"],
  // O preço do texto só vale se for menor que o da Shopee e pelo menos esta
  // porcentagem dele — abaixo disso é parcela, frete ou erro de digitação.
  minPct: 50,
};

const MAX_WORDS = 40;
const MAX_WORD_LEN = 30;
const PCT_FLOOR = 1;
const PCT_CEIL = 99;

function saneiaLista(v, padrao) {
  if (!Array.isArray(v)) return [...padrao];
  const out = [];
  for (const item of v) {
    const w = String(item ?? "").trim().toLowerCase().slice(0, MAX_WORD_LEN);
    if (w && !out.includes(w)) out.push(w);
    if (out.length >= MAX_WORDS) break;
  }
  return out;
}

function sanitize(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const triggers = saneiaLista(src.triggers, DEFAULTS.triggers);
  const n = parseInt(src.minPct, 10);
  return {
    // Lista vazia desligaria a detecção sem avisar ninguém — cai no default.
    triggers: triggers.length ? triggers : [...DEFAULTS.triggers],
    ignore: saneiaLista(src.ignore, DEFAULTS.ignore),
    minPct: Number.isFinite(n) ? Math.min(PCT_CEIL, Math.max(PCT_FLOOR, n)) : DEFAULTS.minPct,
  };
}

function readConfig() {
  return sanitize(appConfig.get(CONFIG_KEY));
}

function writeConfig(patch) {
  const cfg = sanitize({ ...readConfig(), ...(patch && typeof patch === "object" ? patch : {}) });
  appConfig.set(CONFIG_KEY, cfg);
  return cfg;
}

// Cache de UMA entrada chaveado pelo valor (mesmo motivo do coupon-words: o
// worker recarrega o app_config a cada 30s e a edição tem que pegar sozinha).
let _cache = null;

function compile(cfg) {
  const conf = sanitize(cfg);
  const chave = JSON.stringify(conf);
  if (_cache && _cache.chave === chave) return _cache.compilado;
  const gatilhos = conf.triggers.map(accentInsensitive).join("|");
  const compilado = {
    // Testada contra o texto que vem ANTES do número: o gatilho como palavra
    // inteira ("por", não "compor"), seguido só de pontuação/espaço/emoji
    // ("Por: *R$ ", "pix 👉 ").
    before: new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${gatilhos})[^\\p{L}\\p{N}]{0,10}$`, "iu"),
    ignore: new Set(conf.ignore.map(w => semAcento(w).toLowerCase())),
    // Gatilhos que são palavra ("por", "pix") — o "r$" não entra, não é palavra.
    triggerWords: new Set(conf.triggers.map(w => semAcento(w).toLowerCase()).filter(w => /^\p{L}+$/u.test(w))),
    minPct: conf.minPct,
  };
  _cache = { chave, compilado };
  return compilado;
}

module.exports = { CONFIG_KEY, DEFAULTS, readConfig, writeConfig, sanitize, compile };
