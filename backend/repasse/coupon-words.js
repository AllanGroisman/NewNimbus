// As palavras que fazem o repasse reconhecer um cupom escrito na legenda.
//
// Até aqui isso era uma regex fixa dentro do capture.js: mudar "cupom | código |
// voucher" exigia editar o código e subir deploy. Agora a lista mora em
// app_config (key abaixo) e o admin edita pela tela — mesmo padrão de
// scraper-config e ml-cupons-config.
//
// Este módulo NÃO conhece mensagem nem WhatsApp: ele só guarda a config e monta
// a regex. Quem lê a legenda e decide é o capture.js.
const appConfig = require("../config");

const CONFIG_KEY = "repasse-coupon-config";

const DEFAULTS = {
  // Palavra que precisa vir ANTES do código pra ele ser reconhecido. Sem gatilho
  // qualquer palavra da frase viraria cupom.
  triggers: ["cupom", "código", "voucher"],
  // Palavras que aparecem depois do gatilho mas não são código ("use o cupom
  // AQUI"). A heurística de forma já barra as minúsculas; esta lista pega as que
  // vêm gritadas em caixa alta, que passariam.
  ignore: ["aqui", "abaixo", "acima", "link", "descricao", "promo"],
  minLen: 4,
  maxLen: 20,
};

// Limites do saneamento. Existem porque o corpo do PUT chega cru do admin e essa
// config vira uma regex — lista sem teto é regex gigante rodando a cada mensagem.
const MAX_WORDS = 40;
const MAX_WORD_LEN = 30;
const LEN_FLOOR = 2;
const LEN_CEIL = 60;

// Vogais e consoantes que o português acentua. Serve pra "codigo" digitado sem
// acento casar com "código" escrito na legenda (e vice-versa) sem o admin
// precisar saber que existe uma regex do outro lado.
const ACCENT_CLASS = {
  a: "[aáàâãä]", e: "[eéèêë]", i: "[iíìîï]",
  o: "[oóòôõö]", u: "[uúùûü]", c: "[cç]", n: "[nñ]",
};

function semAcento(s) {
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

// Palavra do admin → pedaço de regex. Escapa os metacaracteres ANTES de trocar
// as letras: sem isso um "c+" digitado por engano derrubaria a captura inteira
// com "Invalid regular expression".
function accentInsensitive(word) {
  const cru = semAcento(word).toLowerCase();
  const escapado = cru.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return escapado.replace(/[aeioucn]/g, ch => ACCENT_CLASS[ch] || ch);
}

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

function saneiaNumero(v, padrao) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return padrao;
  return Math.min(LEN_CEIL, Math.max(LEN_FLOOR, n));
}

// Mescla o que veio (config salva ou corpo de rota) sobre os defaults e devolve
// algo sempre seguro pra virar regex.
function sanitize(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const triggers = saneiaLista(src.triggers, DEFAULTS.triggers);
  const minLen = saneiaNumero(src.minLen, DEFAULTS.minLen);
  const maxLen = saneiaNumero(src.maxLen, DEFAULTS.maxLen);
  return {
    // Lista vazia desligaria a detecção sem avisar ninguém — cai no default.
    triggers: triggers.length ? triggers : [...DEFAULTS.triggers],
    ignore: saneiaLista(src.ignore, DEFAULTS.ignore),
    minLen,
    // Um máximo menor que o mínimo não acha nada; o mínimo manda.
    maxLen: Math.max(minLen, maxLen),
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

// Cache de UMA entrada, chaveado pelo valor da config. Chavear pelo valor (e não
// guardar numa variável de módulo) é o que faz a edição do admin pegar sozinha:
// o capture.js roda no worker, que recarrega o app_config a cada 30s — se a
// regex ficasse presa na primeira compilação, só um restart mudaria a detecção.
let _cache = null;

// O que pode separar gatilho e código (ver compile).
const SEP = "[^\\p{L}\\p{N}]{0,10}";

function compile(cfg) {
  const conf = sanitize(cfg);
  const chave = JSON.stringify(conf);
  if (_cache && _cache.chave === chave) return _cache.compilado;

  const gatilhos = conf.triggers.map(accentInsensitive).join("|");
  const compilado = {
    // Mesma forma de sempre: gatilho, o conector opcional "de desconto" (ligação
    // de frase, não gatilho — por isso continua fixo), pontuação opcional e o
    // candidato. O comprimento final é conferido no capture.js.
    //
    // O candidato casa UM caractere a mais que o máximo de propósito: assim uma
    // palavra maior que o limite chega inteira lá e é RECUSADA, em vez de vir
    // cortada no tamanho certo e passar. Cupom truncado é pior que cupom
    // nenhum — ia parar na mensagem enviada ao cliente como código inválido.
    //
    // Entre o gatilho e o código aceita qualquer coisa que não seja letra nem
    // número, com teto curto: a legenda real vem como "Cupom: *X*", "cupom 👉 X",
    // "cupom `X`", "cupom \"X\"". Antes só passava espaço, ":" ou "-", e o negrito
    // do WhatsApp sozinho já fazia o cupom sumir. A flag "u" é o que faz um emoji
    // contar como um caractere só nesse teto.
    re: new RegExp(
      `(?:${gatilhos})${SEP}(?:de\\s+desconto${SEP})?([A-Za-z0-9][A-Za-z0-9._-]{1,${conf.maxLen}})`,
      "giu",
    ),
    ignore: new Set(conf.ignore.map(w => semAcento(w).toLowerCase())),
    minLen: conf.minLen,
    maxLen: conf.maxLen,
  };
  _cache = { chave, compilado };
  return compilado;
}

module.exports = {
  CONFIG_KEY,
  DEFAULTS,
  readConfig,
  writeConfig,
  sanitize,
  compile,
  // exportados p/ testes
  accentInsensitive,
  semAcento,
};
