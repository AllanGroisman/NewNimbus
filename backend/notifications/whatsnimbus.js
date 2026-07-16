// WhatsNimbus — o WhatsApp DEDICADO do sistema, conectado pelo admin, que é o
// REMETENTE de todas as notificações pros usuários (ver user-notifier.js).
//
// A sessão não pertence a nenhum usuário real: usa um userId sintético fixo.
// Motivos:
//   - saveState() faz replace-all de whatsapp_numbers POR userId; se o número do
//     WhatsNimbus vivesse sob um admin real, um save do painel dele o apagaria.
//   - whatsapp_numbers tem FK pra users (onDelete: Cascade), então não dá pra
//     criar uma linha lá sob um id sintético — por isso o WhatsNimbus NÃO tem
//     linha em whatsapp_numbers; o número é whitelistado no restoreSessions()
//     via esta config (ver whatsapp/local.js).
//
// Config persistida em AppConfig sob "whatsnimbus-config".
const appConfig = require("../config");

const CONFIG_KEY = "whatsnimbus-config";

// userId sintético do remetente. Não é um User real — nenhuma listSessions de
// usuário o enxerga e nenhum saveState o toca.
const WHATSNIMBUS_USER_ID = "__whatsnimbus__";

const DEFAULT_CONFIG = {
  numberId: null,      // canônico (= telefone) após conectar; provisório antes
  phone: null,
  name: null,
  connectedAt: null,
};

function readConfig() {
  const raw = appConfig.get(CONFIG_KEY);
  if (!raw || typeof raw !== "object") return { ...DEFAULT_CONFIG };
  return { ...DEFAULT_CONFIG, ...raw };
}

function writeConfig(patch) {
  const next = { ...readConfig(), ...(patch || {}) };
  appConfig.set(CONFIG_KEY, next);
  return next;
}

function clearConfig() {
  const next = { ...DEFAULT_CONFIG };
  appConfig.set(CONFIG_KEY, next);
  return next;
}

module.exports = { CONFIG_KEY, WHATSNIMBUS_USER_ID, readConfig, writeConfig, clearConfig };
