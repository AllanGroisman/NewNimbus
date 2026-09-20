// A config do teste automático de cupom do repasse — o que o job de
// coupon-autotest.js pode gastar por rodada.
//
// Mora em app_config (chave abaixo) e não em constantes do módulo pelo mesmo
// motivo do coupon-words.js: o custo aqui é Chrome aberto na conta do ML, e o
// número certo só se descobre olhando o ML reagir. Sem isso, apertar o freio
// exigiria editar código e subir deploy — justamente no momento em que o ML está
// barrando e ninguém quer esperar um deploy.
//
// Chave PRÓPRIA, e não campos novos em `repasse-coupon-config`: o sanitize daquela
// é específico de listas de palavras que viram regex, e misturar as duas deixaria
// um PUT de um formulário apagando os campos do outro.
//
// Este módulo não conhece banco, ML nem navegador: ele só guarda números.
const appConfig = require("../config");

const CONFIG_KEY = "repasse-coupon-autotest";

const DEFAULTS = {
  enabled: true,

  // Entre rodadas. 15 min com `maxPorRodada: 5` dá ~20 palavras/hora no pior caso
  // — e como o cache de palavra é de 12h, o normal é a rodada não achar trabalho.
  intervaloMs: 15 * 60_000,
  // Palavras testadas por rodada. Cada uma é um Chrome inteiro, aberto e fechado,
  // de 15 a 50s (scraping/ml-cupons.js:checkCouponWord).
  maxPorRodada: 5,
  // Espaço entre uma palavra e a próxima. Existe porque não há rate limit nenhum
  // dentro do checkWord: as pausas do ml-cupons.js são internas a uma varredura de
  // vitrine, e o único espaçamento entre PALAVRAS até aqui era humano (o admin
  // clicando na tela). Rajada de Chrome é o que acorda o anti-robô.
  pausaEntrePalavrasMs: 20_000,

  // Janela de captura que alimenta a fila de trabalho. Mesmo default do
  // repasse/coupons.js:aggregate, pra tela e job olharem o mesmo período.
  diasDeBusca: 90,
  // Só testa código visto ao menos N vezes. Subir isto é o filtro mais barato
  // contra ruído: palavra que apareceu uma vez só e nunca mais raramente paga o
  // Chrome que custa.
  minCapturas: 1,

  // Trazer a campanha da palavra que o ML confirmou (`ml_coupons`).
  importarCampanha: true,
  // Raspar a vitrine de produtos da campanha (`ml_coupon_products`). É o que faz o
  // sistema saber A QUE produtos o cupom se aplica — sem ela o quick-check fica em
  // "sem-vitrine" pra sempre e o desconto nunca entra na conta do envio.
  rasparVitrine: true,
  // Importação é minutos por campanha E a única ESCRITA que o sistema faz na conta
  // do ML (o clique em "Eu quero", ver coupons/sync.js:importCampaign). Uma por
  // rodada de propósito: o resto da fila espera a próxima.
  maxImportsPorRodada: 1,

  // Teto de retentativas por palavra. Vale para o "indeterminado" (o ML não chegou
  // a avaliar), que é o único veredito que volta pra fila: `invalid` é resposta
  // fechada e `valid` não precisa de segunda opinião.
  maxTentativas: 3,
  // Quanto esperar antes de insistir num "indeterminado". Precisa existir porque
  // coupons/pg.js:findCodeCheck devolve null pra indeterminado — ou seja, engasgo
  // do ML NÃO entra no cache de 12h, e sem esta espera o job reabriria Chrome na
  // mesma palavra a cada rodada, pra sempre.
  esperaAposIndeterminadoHoras: 6,
  // O breaker: quanto o job fica parado depois de levar CAPTCHA/muro de login.
  // Insistir em bloqueio é o caminho mais curto pra queimar a conta do sistema.
  pausaAposBloqueioMin: 60,
};

// Faixas do saneamento. O corpo do PUT chega cru do admin e estes números viram
// `setInterval` e laço de Chrome — um zero ou um negativo aqui é uma rajada.
const FAIXAS = {
  intervaloMs: [60_000, 24 * 3600_000],
  maxPorRodada: [1, 50],
  pausaEntrePalavrasMs: [0, 600_000],
  diasDeBusca: [1, 3650],
  minCapturas: [1, 1000],
  maxImportsPorRodada: [0, 20],
  maxTentativas: [1, 20],
  esperaAposIndeterminadoHoras: [0, 720],
  pausaAposBloqueioMin: [0, 1440],
};

const BOOLEANOS = ["enabled", "importarCampanha", "rasparVitrine"];

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

// Mescla o que veio (config salva ou corpo de rota) sobre os defaults e devolve
// algo sempre seguro pra virar timer e laço.
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
