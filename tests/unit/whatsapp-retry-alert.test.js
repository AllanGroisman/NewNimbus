// O alerta de mensagem presa em "Aguardando mensagem".
//
// Cada vez que o Baileys vem buscar uma mensagem nossa no msg-store, é porque um
// aparelho não conseguiu abri-la e pediu o reenvio — ou seja, alguém está vendo
// "Aguardando mensagem. Essa ação pode levar alguns instantes". Um ou outro é
// normal (sessão Signal nova, aparelho que ficou offline). Dezenas na MESMA
// mensagem é um grupo inteiro travado, e isso passava despercebido: o envio já
// tinha sido registrado como "envio ok" e o problema só chegava por reclamação.
//
// O admin-notifier entra por require.cache (mesma técnica dos outros testes de
// whatsapp), porque o msg-store o carrega lazy, na hora de alertar.
import "../helpers/env.js";
import { describe, it, expect, beforeEach } from "vitest";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(__dirname, "..", "..", "backend");
const STORE_JS = path.join(BACKEND, "whatsapp", "msg-store.js");
const NOTIFIER_JS = path.join(BACKEND, "notifications", "admin-notifier.js");
const require = createRequire(pathToFileURL(STORE_JS));

let alerts = [];
require.cache[NOTIFIER_JS] = {
  id: NOTIFIER_JS,
  filename: NOTIFIER_JS,
  loaded: true,
  exports: {
    notifyRetryStorm: async (vars) => { alerts.push(vars); },
  },
};

const msgStore = require(STORE_JS);

// O ALERT_AT é lido do env no load do módulo; o default é o que este teste trava.
const ALERT_AT = 15;

function enviada(id, jid = "120363000000000000@g.us") {
  return { key: { id, remoteJid: jid, fromMe: true }, message: { conversation: "oi" } };
}

// Simula N aparelhos pedindo a MESMA mensagem de volta.
async function pedirReenvio(id, vezes) {
  for (let i = 0; i < vezes; i++) await msgStore.get(id);
}

describe("alerta de mensagem presa em Aguardando mensagem", () => {
  beforeEach(() => {
    msgStore.__clear();
    alerts = [];
  });

  it("alguns reenvios não alertam — isso é normal", async () => {
    msgStore.put(enviada("MSG1"));
    await pedirReenvio("MSG1", ALERT_AT - 1);
    expect(msgStore.stats("MSG1")).toMatchObject({ retries: ALERT_AT - 1 });
    expect(alerts).toEqual([]);
  });

  it("alerta ao cruzar o teto, com destino e contagem", async () => {
    msgStore.put(enviada("MSG2", "120363410820077664@g.us"));
    await pedirReenvio("MSG2", ALERT_AT);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      id: "MSG2",
      retries: ALERT_AT,
      jid: "120363410820077664@g.us",
    });
  });

  it("alerta UMA vez só — um aviso por aparelho seria a própria enxurrada", async () => {
    msgStore.put(enviada("MSG3"));
    await pedirReenvio("MSG3", ALERT_AT * 4);
    expect(msgStore.stats("MSG3")).toMatchObject({ retries: ALERT_AT * 4 });
    expect(alerts).toHaveLength(1);
  });

  it("cada mensagem tem o seu próprio teto", async () => {
    msgStore.put(enviada("MSG4"));
    msgStore.put(enviada("MSG5"));
    await pedirReenvio("MSG4", ALERT_AT);
    await pedirReenvio("MSG5", ALERT_AT - 1);
    expect(alerts.map(a => a.id)).toEqual(["MSG4"]);
  });

  it("notifier fora do ar não atrapalha o reenvio — a mensagem ainda volta", async () => {
    require.cache[NOTIFIER_JS].exports.notifyRetryStorm = async () => {
      throw new Error("whatsnimbus offline");
    };
    msgStore.put(enviada("MSG6"));
    await pedirReenvio("MSG6", ALERT_AT - 1);
    // O que importa: o pedido que dispara o alerta continua devolvendo a mensagem.
    await expect(msgStore.get("MSG6")).resolves.toMatchObject({ conversation: "oi" });
    require.cache[NOTIFIER_JS].exports.notifyRetryStorm = async (vars) => { alerts.push(vars); };
  });
});
