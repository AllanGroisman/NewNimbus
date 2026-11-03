// Aviso "o ML pediu verificação no Chrome do servidor".
//
// A tela do admin chama a cada muro que a extensão encontra — e uma colheita em
// lote pode bater vários seguidos. O que este teste trava: o aviso sai uma vez,
// os próximos dentro da janela calam, e o toggle desligado cala tudo.
//
// config, whatsnimbus e whatsapp entram por require.cache: nada de banco nem de
// WhatsApp de verdade.
import "../helpers/env.js";
import { describe, it, expect, beforeEach } from "vitest";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(__dirname, "..", "..", "backend");
const NOTIFIER_JS = path.join(BACKEND, "notifications", "admin-notifier.js");
const CONFIG_JS = path.join(BACKEND, "config", "index.js");
const WN_JS = path.join(BACKEND, "notifications", "whatsnimbus.js");
const WA_JS = path.join(BACKEND, "whatsapp", "index.js");
const require = createRequire(pathToFileURL(NOTIFIER_JS));

const store = {};
const enviados = [];
const stub = (file, exports) => { require.cache[file] = { id: file, filename: file, loaded: true, exports }; };
stub(CONFIG_JS, { get: (k) => store[k], set: (k, v) => { store[k] = v; } });
stub(WN_JS, { WHATSNIMBUS_USER_ID: "__wn__", readConfig: () => ({ numberId: "5511999999999" }) });
stub(WA_JS, { sendText: async (_u, _n, jid, text) => { enviados.push({ jid, text }); } });

const notifier = require(NOTIFIER_JS);
const T0 = Date.parse("2026-11-03T12:00:00Z");

describe("notifyMuroChrome", () => {
  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
    enviados.length = 0;
    notifier._resetMuro();
    notifier.writeConfig({ enabled: true, groupJid: "123@g.us" });
  });

  it("manda o link do VNC no grupo de notificações", async () => {
    expect(await notifier.notifyMuroChrome({ muro: "captcha", onde: "raspar" }, T0)).toBe(true);
    expect(enviados).toHaveLength(1);
    expect(enviados[0].jid).toBe("123@g.us");
    expect(enviados[0].text).toContain("http://192.168.0.247:6080/vnc.html");
    expect(enviados[0].text).toContain("Vitrine de cupom");
    expect(enviados[0].text).toContain("25 min");
  });

  it("segura os avisos seguintes dentro da janela e volta a avisar depois", async () => {
    await notifier.notifyMuroChrome({ muro: "captcha", onde: "raspar" }, T0);
    expect(await notifier.notifyMuroChrome({ muro: "captcha", onde: "lista" }, T0 + 60_000)).toBe(false);
    expect(enviados).toHaveLength(1);
    expect(await notifier.notifyMuroChrome({ muro: "captcha" }, T0 + notifier.MURO_INTERVALO_MS)).toBe(true);
    expect(enviados).toHaveLength(2);
  });

  it("toggle desligado não manda nada", async () => {
    notifier.writeConfig({ events: { muroChrome: false } });
    expect(await notifier.notifyMuroChrome({ muro: "captcha" }, T0)).toBe(false);
    expect(enviados).toHaveLength(0);
  });
});
