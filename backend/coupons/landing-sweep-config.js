// A config da varredura em lote dos cupons (coupons/landing-sweep.js) — quanto ela
// pode pedir ao Mercado Livre por rodada.
//
// Mora em app_config pelo mesmo motivo do repasse/coupon-autotest-config.js: cada
// passo é uma chamada à API de link curto com a conta do sistema (a mesma do Hub),
// e o número certo só se descobre olhando o ML reagir. Apertar o freio não pode
// depender de deploy.
//
// Chave PRÓPRIA, e não campos novos em `ml-cupons-config` (coupons/sync.js): aquela
// é a config da rodada do admin, e um PUT de um formulário apagaria os campos do
// outro.
//
// Este módulo não conhece banco, ML nem navegador: ele só guarda números.
const appConfig = require("../config");

const CONFIG_KEY = "ml-cupons-landing-sweep";

const DEFAULTS = {
  enabled: true,

  // Entre rodadas. Com 60 cupons por rodada a cada 30 min são ~120 links curtos por
  // hora — a fila de ~2.800 cupons medida em 19/09 anda inteira em um dia.
  intervaloMs: 30 * 60_000,
  // Cupons lidos por rodada. Cada um são DUAS requisições (link curto + landing),
  // ~1,5 s medidos, sem navegador.
  maxPorRodada: 60,
  // Espaço entre um cupom e o próximo (mais um jitter de até o mesmo tanto). Não há
  // rate limit nenhum dentro do `vitrinePelaLanding` — rajada é o que acorda o anti-robô.
  pausaMs: 2_000,
  // Depois de quanto tempo a landing de um cupom é lida de novo. A prévia muda (o ML
  // roda os produtos), e o cupom que não trouxe nada merece outra chance — mas não
  // a cada rodada, senão ele empurraria a fila pra trás.
  refazerHoras: 24,

  // Trazer para o catálogo os MLBs das amostras (as 4 miniaturas do card), que
  // chegam sem nome nem preço (coupons/enrich-samples.js). Mesma API de link curto.
  enriquecerAmostras: true,
  maxAmostrasPorRodada: 60,
  // Anúncio que não abriu (pausado, sem estoque) só é tentado de novo depois disto.
  refazerAmostraDias: 7,

  // O breaker: quanto a varredura fica parada depois de levar CAPTCHA/muro.
  pausaAposBloqueioMin: 60,
};

// Faixas do saneamento. O corpo do PUT chega cru do admin e estes números viram
// `setInterval` e laço de requisição — um zero ou negativo aqui é uma rajada.
const FAIXAS = {
  intervaloMs: [60_000, 24 * 3600_000],
  maxPorRodada: [1, 500],
  pausaMs: [0, 120_000],
  refazerHoras: [1, 24 * 30],
  maxAmostrasPorRodada: [0, 500],
  refazerAmostraDias: [1, 90],
  pausaAposBloqueioMin: [0, 1440],
};

const BOOLEANOS = ["enabled", "enriquecerAmostras"];

// Checkbox de formulário chega como "true"/"on"/1 dependendo do caminho; um
// `!!v` cru transformaria a string "false" em true.
function saneiaBooleano(v, padrao) {
  if (typeof v === "boolean") return v;
  if (v == null) return padrao;
  if (typeof v === "number") return v !== 0;
  const s = String(v).trim().toLowerCase();
  if (["true", "1", "on", "sim", "yes"].includes(s)) return true;
  if (["false", "0", "off", "nao", "não", "no"].includes(s)) return false;
  return padrao;
}

function saneiaNumero(v, padrao, [min, max]) {
  const n = typeof v === "number" ? v : parseInt(v, 10);
  if (!Number.isFinite(n)) return padrao;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

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

module.exports = { CONFIG_KEY, DEFAULTS, FAIXAS, sanitize, readConfig, writeConfig, saneiaBooleano, saneiaNumero };
