// A config da aba Admin › Scraping Cupons › Cupons Teste (coupons/preco-teste.js):
// quais envios recentes conferir no checkout do ML e em que ritmo. Só entra envio
// com cupom: o teste digita o código no checkout, e sem código não há o que testar.
//
// Mesmo molde do checkout-lote-config.js: tudo passa pelo `sanitize`, valor fora
// da faixa vira o limite e chave velha some. Cada produto conferido é um checkout
// aberto na conta do ML do admin — menos pausa é mais chance de CAPTCHA.
const appConfig = require("../config");

function saneiaBooleano(v, padrao) {
  if (typeof v === "boolean") return v;
  if (v == null) return padrao;
  if (typeof v === "number") return v !== 0;
  const s = String(v).trim().toLowerCase();
  if (["true", "1", "on", "sim", "yes"].includes(s)) return true;
  if (["false", "0", "off", "nao", "não", "no"].includes(s)) return false;
  return padrao;
}

function saneiaNumero(v, padrao, [min, max], { inteiro = true } = {}) {
  const n = typeof v === "number" ? v : Number(String(v ?? "").replace(",", "."));
  if (v == null || v === "" || !Number.isFinite(n)) return padrao;
  const dentro = Math.min(max, Math.max(min, n));
  return inteiro ? Math.trunc(dentro) : Math.round(dentro * 100) / 100;
}

const CONFIG_KEY = "cupons-teste-config";

const DEFAULTS = {
  // Envios de quantos dias atrás entram na conferência.
  dias: 3,
  // Teto de produtos por rodada.
  maxProdutos: 20,
  // Só as campanhas de repasse.
  soRepasse: false,
  // Campanhas escolhidas (ids). Vazio = todas.
  campanhas: [],
  // Diferença em R$ entre o prometido e o que o ML cobra que ainda conta como "ok".
  toleranciaReais: 0.1,
  // Pausa entre um produto e o próximo.
  pausaEntreMs: 15000,
  // O mesmo produto com o mesmo cupom enviado em vários grupos é conferido uma vez.
  umPorProduto: true,
};

const FAIXAS = {
  dias: [1, 30],
  maxProdutos: [1, 200],
  toleranciaReais: [0, 50],
  pausaEntreMs: [0, 120000],
};

const DECIMAIS = new Set(["toleranciaReais"]);
const BOOLEANOS = ["soRepasse", "umPorProduto"];

function saneiaCampanhas(v) {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map(x => String(x ?? "").trim()).filter(x => /^\d{1,20}$/.test(x)))].slice(0, 500);
}

function sanitize(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const out = {};
  for (const [k, faixa] of Object.entries(FAIXAS)) {
    out[k] = saneiaNumero(src[k], DEFAULTS[k], faixa, { inteiro: !DECIMAIS.has(k) });
  }
  for (const k of BOOLEANOS) out[k] = saneiaBooleano(src[k], DEFAULTS[k]);
  out.campanhas = saneiaCampanhas(src.campanhas);
  return out;
}

function readConfig() {
  return sanitize(appConfig.get(CONFIG_KEY));
}

function writeConfig(patch) {
  const cfg = sanitize({ ...readConfig(), ...(patch && typeof patch === "object" ? patch : {}) });
  appConfig.set(CONFIG_KEY, cfg);
  return cfg;
}

module.exports = { CONFIG_KEY, DEFAULTS, FAIXAS, sanitize, readConfig, writeConfig };
