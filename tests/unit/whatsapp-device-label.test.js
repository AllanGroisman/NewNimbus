// O nome que o celular mostra em WhatsApp › Aparelhos conectados.
//
// O Baileys manda browser[0] como `os` do device no registro
// (generateRegistrationNode), e o app renderiza "Google Chrome (<browser[0]>)".
// A máquina de testes (NIMBUS_MODE=ngrok) pareia no MESMO celular que a
// produção: com os dois devices chamados "(Nimbus)" não há como saber qual
// desconectar. Fora de prod o rótulo tem que ser "Teste".
//
// A asserção é o config entregue ao makeWASocket — Baileys e o adapter de auth
// entram por require.cache, mesma técnica de unit/whatsapp-retry-getmessage.test.js.
import "../helpers/env.js";
import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { EventEmitter } from "events";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(__dirname, "..", "..", "backend");
const LOCAL_JS = path.join(BACKEND, "whatsapp", "local.js");
const require = createRequire(pathToFileURL(LOCAL_JS));

const BAILEYS = require.resolve("@whiskeysockets/baileys");
const PG_AUTH = path.join(BACKEND, "auth", "baileys-pg.js");
const NOTIFIER = path.join(BACKEND, "notifications", "user-notifier.js");
const { DisconnectReason } = require("@whiskeysockets/baileys");

let configs = [];

function fakeSocket(config) {
  configs.push(config);
  const ev = new EventEmitter();
  return {
    ev: { on: (e, h) => ev.on(e, h), removeAllListeners: () => ev.removeAllListeners() },
    end: () => {},
    logout: async () => {},
    user: null,
    authState: { creds: { registered: true } },
    emit: (e, payload) => ev.emit(e, payload),
  };
}

const stubbed = new Map();
function stub(modPath, exports) {
  if (!stubbed.has(modPath)) stubbed.set(modPath, require.cache[modPath]);
  require.cache[modPath] = { id: modPath, filename: modPath, loaded: true, exports, children: [], paths: [] };
}

stub(BAILEYS, {
  default: fakeSocket,
  DisconnectReason,
  fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1] }),
});
stub(PG_AUTH, {
  useDatabaseAuthState: async () => ({
    state: { creds: {}, keys: { get: async () => ({}), set: async () => {} } },
    saveCreds: async () => {},
  }),
  deleteSession: async () => {},
  renameSession: async () => {},
});
stub(NOTIFIER, { onSessionStatus: async () => {}, markConnectedOnce: () => {} });

const wa = require(LOCAL_JS);

afterAll(() => {
  for (const [p, prev] of stubbed) {
    if (prev) require.cache[p] = prev; else delete require.cache[p];
  }
  delete require.cache[LOCAL_JS];
});

const USER = "user-device-label";
const NUM = "5511999990009";

const ENV_KEYS = ["NIMBUS_MODE", "WHATSAPP_DEVICE_LABEL"];
const saved = {};

// O rótulo é resolvido na ABERTURA do socket, não no require do módulo: dá pra
// trocar a env entre os casos sem recarregar o local.js.
async function browserOf(env) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  configs = [];
  await wa.startSession(USER, NUM);
  expect(configs).toHaveLength(1);
  return configs[0].browser;
}

describe("nome do device por modo (browser[0] do Baileys)", () => {
  beforeEach(async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    try { await wa.deleteSession(USER, NUM); } catch { /* ignore */ }
  });

  afterEach(async () => {
    try { await wa.deleteSession(USER, NUM); } catch { /* ignore */ }
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });

  it("produção (e modo ausente) registra como Nimbus", async () => {
    expect(await browserOf({})).toEqual(["Nimbus", "Chrome", "1.0"]);
    try { await wa.deleteSession(USER, NUM); } catch { /* ignore */ }
    expect(await browserOf({ NIMBUS_MODE: "prod" })).toEqual(["Nimbus", "Chrome", "1.0"]);
  });

  it("modo ngrok registra como Teste — vira 'Google Chrome (Teste)' no celular", async () => {
    expect((await browserOf({ NIMBUS_MODE: "ngrok" }))[0]).toBe("Teste");
  });

  it("qualquer modo fora de prod (e2e, maiúsculas) também é Teste", async () => {
    expect((await browserOf({ NIMBUS_MODE: "e2e" }))[0]).toBe("Teste");
    try { await wa.deleteSession(USER, NUM); } catch { /* ignore */ }
    expect((await browserOf({ NIMBUS_MODE: "NGROK" }))[0]).toBe("Teste");
  });

  it("WHATSAPP_DEVICE_LABEL vence o modo, nos dois sentidos", async () => {
    expect((await browserOf({ NIMBUS_MODE: "ngrok", WHATSAPP_DEVICE_LABEL: "Desktop Allan" }))[0])
      .toBe("Desktop Allan");
    try { await wa.deleteSession(USER, NUM); } catch { /* ignore */ }
    expect((await browserOf({ NIMBUS_MODE: "prod", WHATSAPP_DEVICE_LABEL: "  Teste 2  " }))[0])
      .toBe("Teste 2");
  });

  // browser[1] é lido pelo getPlatformType do Baileys ("Chrome" -> DESKTOP):
  // mexer nele mudaria o TIPO do device, não o texto entre parênteses.
  it("browser[1]/browser[2] não mudam com o modo", async () => {
    const b = await browserOf({ NIMBUS_MODE: "ngrok" });
    expect(b.slice(1)).toEqual(["Chrome", "1.0"]);
  });
});
