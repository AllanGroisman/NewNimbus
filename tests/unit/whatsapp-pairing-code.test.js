// isPairedCreds — o predicado que sustenta o código de pareamento.
//
// `requestPairingCode` grava `creds.me` e `creds.pairingCode` ANTES de qualquer
// pareamento, e o nosso handler de creds.update persiste isso no Postgres. Se
// `creds.me` continuasse sendo a prova de "já pareou", uma tentativa de código
// abandonada seria tratada como sessão boa: os dois caminhos de limpeza (401 de
// handshake e 408 de QR esgotado) ficariam desligados e ela reconectaria pra
// sempre — inclusive depois de um restart do worker, porque o veneno está no banco.
//
// A tabela abaixo é o contrato. A linha que importa mais é a segunda: sessão
// pareada por QR hoje (sem `pairingCode`) TEM que continuar contando como pareada,
// senão a limpeza apaga auth boa e o usuário reescaneia o QR — que é exatamente o
// desastre descrito no comentário de classifyClose em local.js.

import "../helpers/env.js";
import { describe, it, expect } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const local = require(path.resolve(__dirname, "..", "..", "backend", "whatsapp", "local.js"));
const { DisconnectReason } = require(path.resolve(__dirname, "..", "..", "backend", "node_modules", "@whiskeysockets", "baileys"));
const { isPairedCreds, classifyClose, isOrphanQrSession } = local;

const ME = { id: "5511999990000:61@s.whatsapp.net" };

describe("isPairedCreds", () => {
  it("sem creds, ou sem creds.me, nunca pareou", () => {
    expect(isPairedCreds(undefined)).toBe(false);
    expect(isPairedCreds(null)).toBe(false);
    expect(isPairedCreds({})).toBe(false);
    expect(isPairedCreds({ me: {} })).toBe(false);
  });

  it("sessão pareada por QR (registered false, sem pairingCode) É pareada", () => {
    // Guarda de regressão: é a forma de TODA sessão que existe hoje em produção.
    expect(isPairedCreds({ me: ME, registered: false })).toBe(true);
  });

  it("só pediu o código: tem creds.me, mas ainda não pareou nada", () => {
    expect(isPairedCreds({ me: ME, pairingCode: "ABCD1234", registered: false })).toBe(false);
  });

  it("pediu o código e leu o QR: creds.account prova o pareamento", () => {
    // configureSuccessfulPairing grava `account` nos DOIS fluxos — é por isso que
    // desistir do código e escanear o QR no mesmo socket não apaga auth boa.
    expect(isPairedCreds({ me: ME, pairingCode: "ABCD1234", registered: false, account: { details: "x" } })).toBe(true);
  });

  it("pareou pelo código: registered true", () => {
    expect(isPairedCreds({ me: ME, pairingCode: "ABCD1234", registered: true })).toBe(true);
  });
});

describe("classifyClose — cópia sensível ao modo de pareamento", () => {
  const qrRefsEnded = {
    output: { statusCode: DisconnectReason.timedOut },
    message: "QR refs attempts ended",
  };
  const dryUnauthorized = { output: { statusCode: DisconnectReason.loggedOut }, message: "Connection Failure" };

  it("408 numa tentativa de código fala de código, não de QR", () => {
    const r = classifyClose(qrRefsEnded, { paired: false, pairingAttempt: true });
    expect(r.cleanup).toBe(true);
    expect(r.reconnect).toBe(false);
    expect(r.lastError).toBe("O código não foi usado a tempo. Gere um novo.");
  });

  it("408 no fluxo de QR mantém a mensagem de sempre (default é QR)", () => {
    const r = classifyClose(qrRefsEnded, { paired: false });
    expect(r.cleanup).toBe(true);
    expect(r.lastError).toBe("QR não escaneado a tempo.");
  });

  it("401 de handshake numa tentativa de código manda conferir o número", () => {
    // O IQ de pareamento é fire-and-forget: número errado gera um código válido
    // que simplesmente nunca funciona. É o único aviso que dá pra dar.
    const r = classifyClose(dryUnauthorized, { paired: false, pairingAttempt: true });
    expect(r.cleanup).toBe(true);
    expect(r.lastError).toBe("Falha ao parear. Confira o número e gere um código novo.");
  });
});

describe("isOrphanQrSession — varre também tentativa de código abandonada", () => {
  const velha = Date.now() - 11 * 60 * 1000;

  it("sessão que só pediu código e ficou parada É órfã", () => {
    const s = {
      status: "awaiting_qr",
      createdAt: velha,
      sock: { authState: { creds: { me: ME, pairingCode: "ABCD1234", registered: false } } },
    };
    expect(isOrphanQrSession(s, Date.now())).toBe(true);
  });

  it("sessão pareada de verdade continua intocada", () => {
    const s = {
      status: "awaiting_qr",
      createdAt: velha,
      sock: { authState: { creds: { me: ME, pairingCode: "ABCD1234", registered: true } } },
    };
    expect(isOrphanQrSession(s, Date.now())).toBe(false);
  });
});
