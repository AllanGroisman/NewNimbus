// Interruptores de função (admin → Gerais). Servem pra esconder uma função nova
// de todo mundo se ela não estiver funcionando como esperado, sem deploy.
//
// Mora no app_config (chave abaixo) — o worker recarrega a cada 30s, então
// desligar aqui vale na captura do repasse sem restart.
const appConfig = require("./config");

const FEATURE_FLAGS_KEY = "feature-flags";

// Toda chave conhecida e o seu padrão. Chave fora daqui é ignorada no write.
const DEFAULTS = {
  // Lista branca/negra de palavras do repasse (repasse/word-filter.js).
  repasseWordFilter: true,
};

function sanitize(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const out = {};
  for (const [k, padrao] of Object.entries(DEFAULTS)) {
    out[k] = typeof src[k] === "boolean" ? src[k] : padrao;
  }
  return out;
}

function readFlags() {
  return sanitize(appConfig.get(FEATURE_FLAGS_KEY));
}

function writeFlags(patch) {
  const flags = sanitize({ ...readFlags(), ...(patch && typeof patch === "object" ? patch : {}) });
  appConfig.set(FEATURE_FLAGS_KEY, flags);
  return flags;
}

function isOn(name) {
  return readFlags()[name] === true;
}

module.exports = { FEATURE_FLAGS_KEY, DEFAULTS, readFlags, writeFlags, isOn, sanitize };
