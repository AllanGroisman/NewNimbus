// O ritmo da sonda do checkout em lote (coupons/checkout-lote.js), ajustável na
// tela. Mesmo formato do landing-sweep-config.js: o que está gravado passa sempre
// pelo `sanitize`, então valor fora da faixa vira o limite e chave velha some.
//
// Todos os números valem para a CONTA do ML, que é a mesma do Hub: mais abas e
// menos pausa são mais produtos por minuto e mais chance de CAPTCHA.
const appConfig = require("../config");
const { saneiaBooleano, saneiaNumero } = require("./landing-sweep-config");

const CONFIG_KEY = "ml-cupons-sonda-lote";

const DEFAULTS = {
  // Quantas abas sondam ao mesmo tempo. Com mais de uma, o plano B do carrinho fica
  // desligado (extension/checkout.js: `semCarrinho`) — o carrinho é um só.
  paralelo: 1,
  // Entre um produto e o próximo, em CADA aba.
  pausaMs: 5000,
  // Os tempos de dentro da sonda (extension/checkout.js: `lerTempos`).
  settleMs: 1500,          // a página assentar depois de uma ação
  esperaCheckoutMs: 30000, // teto para a tela do checkout terminar de montar
  esperaNavMs: 20000,      // teto para sair da página do produto rumo ao checkout
  // Parar a sonda assim que a página dos cupons foi lida, sem abrir o popup.
  modoRapido: true,
};

const FAIXAS = {
  paralelo: [1, 8],
  pausaMs: [0, 60000],
  settleMs: [300, 5000],
  esperaCheckoutMs: [5000, 60000],
  esperaNavMs: [5000, 60000],
};

const BOOLEANOS = ["modoRapido"];

function sanitize(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const out = {};
  for (const k of BOOLEANOS) out[k] = saneiaBooleano(src[k], DEFAULTS[k]);
  for (const [k, faixa] of Object.entries(FAIXAS)) out[k] = saneiaNumero(src[k], DEFAULTS[k], faixa);
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
