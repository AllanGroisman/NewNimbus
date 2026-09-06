// requestPairingCode — o fluxo do código de 8 dígitos, com o Baileys stubado.
//
// O ponto delicado é QUANDO pedir o código: o IQ do link_code_companion_reg só
// tem pra onde ir depois do handshake noise, e `ws.isOpen` é anterior a isso. O
// sinal que usamos é o primeiro evento `qr` da geração atual — o WhatsApp só o
// manda no mesmo pair-device que habilita o pareamento. Estes testes fixam isso,
// mais o single-flight e a limpeza dos campos na troca de socket.
//
// Mesma técnica de require.cache do whatsapp-ghost-session.test.js.

import "../helpers/env.js";
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
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
const { DisconnectReason, makeCacheableSignalKeyStore } = require("@whiskeysockets/baileys");

let sockets = [];

// Socket NUNCA pareado: é o estado em que uma sessão de código de pareamento
// nasce (creds vazias até o requestPairingCode gravar o `me` falso).
function fakeSocket(config) {
  const ev = new EventEmitter();
  const sock = {
    config,
    ev: {
      on: (e, h) => ev.on(e, h),
      removeAllListeners: () => ev.removeAllListeners(),
    },
    end: vi.fn(),
    logout: vi.fn().mockResolvedValue(undefined),
    user: null,
    authState: { creds: {} },
    // Espelha o Baileys: grava me + pairingCode nas creds ANTES de parear.
    requestPairingCode: vi.fn(async (phone) => {
      sock.authState.creds.me = { id: `${phone}@s.whatsapp.net`, name: "~" };
      sock.authState.creds.pairingCode = "ABCD1234";
      return "ABCD1234";
    }),
    emit: (e, payload) => ev.emit(e, payload),
  };
  sockets.push(sock);
  return sock;
}

const stubbed = new Map();
function stub(modPath, exports) {
  if (!stubbed.has(modPath)) stubbed.set(modPath, require.cache[modPath]);
  require.cache[modPath] = {
    id: modPath, filename: modPath, loaded: true, exports, children: [], paths: [],
  };
}

const pgAuthStub = {
  useDatabaseAuthState: vi.fn(async () => ({
    state: { creds: {}, keys: { get: async () => ({}), set: async () => {} } },
    saveCreds: vi.fn(async () => {}),
  })),
  deleteSession: vi.fn(async () => {}),
  renameSession: vi.fn(async () => {}),
};

stub(BAILEYS, {
  default: fakeSocket,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1] }),
});
stub(PG_AUTH, pgAuthStub);
stub(NOTIFIER, { onSessionStatus: async () => {}, markConnectedOnce: () => {} });

const wa = require(LOCAL_JS);

afterAll(() => {
  for (const [p, prev] of stubbed) {
    if (prev) require.cache[p] = prev; else delete require.cache[p];
  }
  delete require.cache[LOCAL_JS];
});

const USER = "user-pairing";
const NUM = "1700000000000";        // id provisório, como o frontend gera
const PHONE = "5511999990000";

async function cleanup() {
  try { await wa.deleteSession(USER, NUM); } catch { /* ignore */ }
}

// Empurra o pair-device que o Baileys emitiria depois do handshake.
function emitQr(sock) {
  sock.emit("connection.update", { qr: "2@ref,noise,identity,adv" });
}

describe("requestPairingCode", () => {
  beforeEach(async () => { await cleanup(); sockets = []; vi.clearAllMocks(); });

  it("só pede o código depois do primeiro qr — e devolve code + formatted + expiresAt", async () => {
    const p = wa.requestPairingCode(USER, NUM, PHONE);
    // Deixa o startSession abrir o socket e o waitPairingReady entrar no laço.
    await new Promise(r => setTimeout(r, 50));
    expect(sockets).toHaveLength(1);
    expect(sockets[0].requestPairingCode).not.toHaveBeenCalled();

    emitQr(sockets[0]);
    const r = await p;

    expect(sockets[0].requestPairingCode).toHaveBeenCalledWith(PHONE);
    expect(r.ok).toBe(true);
    expect(r.code).toBe("ABCD1234");
    expect(r.formatted).toBe("ABCD-1234");
    expect(r.phone).toBe(PHONE);
    expect(r.expiresAt).toBeGreaterThan(Date.now());
    await cleanup();
  });

  it("duas chamadas concorrentes emitem UM código só (single-flight)", async () => {
    // Emitir dois seguidos deixaria na tela um código que o WhatsApp já não
    // aceita: cada requestPairingCode sobrescreve creds.pairingCode.
    const a = wa.requestPairingCode(USER, NUM, PHONE);
    const b = wa.requestPairingCode(USER, NUM, PHONE);
    await new Promise(r => setTimeout(r, 50));
    emitQr(sockets[0]);
    const [ra, rb] = await Promise.all([a, b]);

    expect(sockets).toHaveLength(1);
    expect(sockets[0].requestPairingCode).toHaveBeenCalledTimes(1);
    expect(ra.code).toBe(rb.code);
    await cleanup();
  });

  // O celular RECUSA o código quando o socket foi aberto com um browser
  // "ilógico" — e recusa em silêncio, porque o IQ de pareamento é fire-and-forget.
  // Foi o que derrubou o primeiro teste real: browser[0] carrega o rótulo
  // "Nimbus"/"Teste" no lugar do sistema operacional, liberdade que a doc do
  // Baileys autoriza só pro QR.
  it("o socket de pareamento usa um browser válido, não o rótulo customizado", async () => {
    const p = wa.requestPairingCode(USER, NUM, PHONE);
    await new Promise(r => setTimeout(r, 50));
    expect(sockets[0].config.browser).toEqual(["Ubuntu", "Chrome", "22.04.4"]);
    emitQr(sockets[0]);
    await p;
    await cleanup();
  });

  it("o socket do QR mantém o rótulo customizado (é o que nomeia o aparelho)", async () => {
    await wa.startSession(USER, NUM);
    expect(sockets[0].config.browser[1]).toBe("Chrome");
    expect(sockets[0].config.browser[0]).not.toBe("Ubuntu");
    await cleanup();
  });

  it("socket já aberto pro QR é REABERTO pro pareamento — e o qr velho não conta", async () => {
    // Duas coisas de uma vez, porque é o caminho REAL da tela: o modal abre em modo
    // QR (socket 0, que emite o seu qr) e só então o usuário pede o código.
    //
    // 1. Sem a reabertura, o gate idempotente do startSession devolveria o socket do
    //    QR e o código sairia pelo browser errado — invisível até o celular recusar.
    // 2. O objeto `session` sobrevive à troca, então o `session.qr` do socket 0
    //    ficava lá. O waitPairingReady o tomava como prova de handshake e pedia o
    //    código no socket 1 recém-criado, cujo WebSocket nem tinha aberto: o Baileys
    //    respondia "Connection Closed" e a tela dizia "não foi possível gerar".
    await wa.startSession(USER, NUM);
    expect(sockets).toHaveLength(1);
    emitQr(sockets[0]);                       // o QR do socket ANTIGO
    expect(wa.getSession(USER, NUM).qr).toBeTruthy();

    const p = wa.requestPairingCode(USER, NUM, PHONE);
    await new Promise(r => setTimeout(r, 50));
    expect(sockets).toHaveLength(2);
    expect(sockets[1].config.browser).toEqual(["Ubuntu", "Chrome", "22.04.4"]);
    // O qr do socket 0 foi descartado na reabertura, e o pedido está PARADO
    // esperando o do socket 1.
    expect(wa.getSession(USER, NUM).qr).toBeFalsy();
    expect(sockets[1].requestPairingCode).not.toHaveBeenCalled();

    emitQr(sockets[1]);
    await p;
    expect(sockets[1].requestPairingCode).toHaveBeenCalledWith(PHONE);
    await cleanup();
  });

  it("auth de tentativa abandonada é descartada antes de abrir o socket", async () => {
    // O requestPairingCode do Baileys grava creds.me ANTES de parear, e nós
    // persistimos isso. No handshake seguinte o Baileys manda LOGIN em vez de
    // REGISTRO (é só `if (!creds.me)`) → 401 na hora, sem QR e sem pair-device:
    // a 2ª tentativa em diante NUNCA funcionava.
    const envenenada = { me: { id: `${PHONE}@s.whatsapp.net` }, pairingCode: "ABCD1234" };
    pgAuthStub.useDatabaseAuthState.mockImplementationOnce(async () => ({
      state: { creds: envenenada, keys: { get: async () => ({}), set: async () => {} } },
      saveCreds: vi.fn(async () => {}),
    }));

    const p = wa.requestPairingCode(USER, NUM, PHONE);
    await new Promise(r => setTimeout(r, 50));
    expect(pgAuthStub.deleteSession).toHaveBeenCalledWith(`${USER}::${NUM}`);
    // O socket foi montado com as creds RELIDAS (limpas), não com as envenenadas.
    expect(sockets[0].config.auth.creds).not.toBe(envenenada);
    expect(sockets[0].config.auth.creds.me).toBeUndefined();

    emitQr(sockets[0]);
    await p;
    await cleanup();
  });

  it("auth de sessão pareada de verdade NÃO é apagada", async () => {
    // A guarda é o isPairedCreds: `account` (pair-success, vale pros dois fluxos) ou
    // `registered`. Apagar aqui forçaria um re-scan a cada pedido de código.
    const boa = {
      me: { id: `${PHONE}:61@s.whatsapp.net` },
      pairingCode: "ABCD1234",
      account: { details: "x" },
    };
    pgAuthStub.useDatabaseAuthState.mockImplementationOnce(async () => ({
      state: { creds: boa, keys: { get: async () => ({}), set: async () => {} } },
      saveCreds: vi.fn(async () => {}),
    }));

    const p = wa.requestPairingCode(USER, NUM, PHONE);
    await new Promise(r => setTimeout(r, 50));
    expect(pgAuthStub.deleteSession).not.toHaveBeenCalled();
    expect(sockets[0].config.auth.creds).toBe(boa);

    await wa.deleteSession(USER, NUM);   // encerra o laço da espera
    await p;
  });

  it("Connection Closed ao pedir o código vira recusa, não exceção", async () => {
    // sendNode lança quando o WebSocket morre entre a espera e o pedido. É falha de
    // rede esperada: 503 com mensagem, em vez de 500 + Sentry.
    const p = wa.requestPairingCode(USER, NUM, PHONE);
    await new Promise(r => setTimeout(r, 50));
    sockets[0].requestPairingCode.mockRejectedValueOnce(new Error("Connection Closed"));
    emitQr(sockets[0]);

    const r = await p;
    expect(r).toEqual({ ok: false, reason: "SOCKET_GONE", message: expect.any(String) });
    await cleanup();
  });

  it("reconexão no meio do pareamento não volta pro browser do QR", async () => {
    // `browser` é opção de construção: um backoff que reabrisse com o rótulo
    // customizado derrubaria o pareamento em andamento sem qualquer sinal.
    const p = wa.requestPairingCode(USER, NUM, PHONE);
    await new Promise(r => setTimeout(r, 50));
    emitQr(sockets[0]);
    await p;

    await wa.startSession(USER, NUM);   // como o timer de backoff chama: sem opts
    expect(sockets[sockets.length - 1].config.browser).toEqual(["Ubuntu", "Chrome", "22.04.4"]);
    await cleanup();
  });

  it("telefone inválido é recusado antes de abrir socket nenhum", async () => {
    const r = await wa.requestPairingCode(USER, NUM, "123");
    expect(r).toEqual({ ok: false, reason: "BAD_PHONE", message: expect.any(String) });
    expect(sockets).toHaveLength(0);
  });

  it("sessão já conectada devolve ALREADY_CONNECTED em vez de código", async () => {
    const s = await wa.startSession(USER, NUM);
    sockets[0].user = { id: `${PHONE}:61@s.whatsapp.net`, name: "Zé" };
    s.migrating = true;   // silencia a canonicalização pós-open, fora de escopo aqui
    sockets[0].emit("connection.update", { connection: "open" });

    const r = await wa.requestPairingCode(USER, NUM, PHONE);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("ALREADY_CONNECTED");
    await cleanup();
  });

  it("sessão apagada no meio da espera devolve SOCKET_GONE", async () => {
    // A outra saída do laço (deadline de 20s → PAIRING_TIMEOUT) não é exercitada
    // aqui: esperar de verdade arrastaria a suíte, e a janela é interna ao
    // waitPairingReady. O que importa é que o laço DESISTE — e o caminho da troca
    // de geração é o que de fato acontece em produção (backoff, conflito, delete).
    const p = wa.requestPairingCode(USER, NUM, PHONE);
    await new Promise(r => setTimeout(r, 50));
    // Um segundo socket (reconexão) invalida a geração que o laço observava.
    await wa.deleteSession(USER, NUM);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("SOCKET_GONE");
  });

  it("o código não sobrevive à troca de socket", async () => {
    const p = wa.requestPairingCode(USER, NUM, PHONE);
    await new Promise(r => setTimeout(r, 50));
    emitQr(sockets[0]);
    await p;
    const s = wa.getSession(USER, NUM);
    expect(s.pairingCode).toBe("ABCD1234");

    // Close de rede: o link_code_companion_reg vale só pra conexão que o emitiu.
    // (Sem `migrating` aqui de propósito — é justamente o handler de close normal
    // que precisa limpar o código; o backoff que ele agenda morre no cleanup.)
    sockets[0].emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: DisconnectReason.connectionLost }, message: "Connection Closed" } },
    });
    expect(wa.getSession(USER, NUM).pairingCode).toBeFalsy();
    await cleanup();
  });
});
