// classifyClose — decide o estado da sessão a partir de um `connection: "close"`
// do Baileys. Puro, sem IO. Regra da Task 1: só logout real e shutdown do worker
// são terminais; restartRequired (pós-scan), conflito e quedas de rede viram
// "connecting" (reconecta sozinho, sem piscar erro na tela).

import "../helpers/env.js";
import { describe, it, expect } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const local = require(path.resolve(__dirname, "..", "..", "backend", "whatsapp", "local.js"));
const { DisconnectReason } = require(path.resolve(__dirname, "..", "..", "backend", "node_modules", "@whiskeysockets", "baileys"));
const { classifyClose, isStuckReconnecting } = local;

// Reproduz a forma do erro do Baileys (Boom): { output: { statusCode }, data, message }.
function boom(statusCode, { tag, message } = {}) {
  return {
    output: { statusCode },
    data: tag ? { content: [{ tag }] } : undefined,
    message: message || "",
  };
}

describe("classifyClose", () => {
  it("restartRequired (515, close normal pós-scan) → connecting, sem erro, reconecta", () => {
    const r = classifyClose(boom(DisconnectReason.restartRequired, { message: "Stream Errored (restart required)" }));
    expect(r).toEqual({ status: "connecting", lastError: null, reconnect: true });
  });

  it("conflito/device_removed (401 com tag conflict) → connecting, reconecta (creds válidas)", () => {
    const r = classifyClose(boom(DisconnectReason.loggedOut, { tag: "conflict" }));
    expect(r.status).toBe("connecting");
    expect(r.reconnect).toBe(true);
    expect(r.lastError).toBeNull();
  });

  it("conflito detectado pela mensagem (401 + '(conflict)') → connecting, reconecta", () => {
    const r = classifyClose(boom(DisconnectReason.loggedOut, { message: "Connection Failure (conflict)" }));
    expect(r.status).toBe("connecting");
    expect(r.reconnect).toBe(true);
  });

  it("queda de rede genérica → connecting, reconecta", () => {
    const r = classifyClose(boom(DisconnectReason.connectionLost, { message: "Connection Closed" }));
    expect(r).toEqual({ status: "connecting", lastError: null, reconnect: true });
  });

  it("logout real (401 sem conflito) → logged_out, não reconecta, guarda o erro", () => {
    const r = classifyClose(boom(DisconnectReason.loggedOut, { message: "Logged Out" }));
    expect(r.status).toBe("logged_out");
    expect(r.reconnect).toBe(false);
    expect(r.lastError).toBe("Logged Out");
  });

  it("worker encerrando → disconnected, não reconecta", () => {
    const r = classifyClose(boom(DisconnectReason.connectionClosed, { message: "closed" }), { shuttingDown: true });
    expect(r.status).toBe("disconnected");
    expect(r.reconnect).toBe(false);
  });

  it("close sem erro (undefined) → connecting, reconecta", () => {
    const r = classifyClose(undefined);
    expect(r).toEqual({ status: "connecting", lastError: null, reconnect: true });
  });

  it("QR expirado (408) em sessão NÃO registrada → disconnected terminal, limpa, não reconecta", () => {
    const r = classifyClose(boom(DisconnectReason.timedOut, { message: "QR refs attempts ended" }), { registered: false });
    expect(r.status).toBe("disconnected");
    expect(r.reconnect).toBe(false);
    expect(r.cleanup).toBe(true);
    expect(r.lastError).toMatch(/QR/i);
  });

  it("QR expirado (408) em sessão JÁ registrada → connecting, reconecta (timeout de rede normal)", () => {
    const r = classifyClose(boom(DisconnectReason.timedOut, { message: "QR refs attempts ended" }), { registered: true });
    expect(r).toEqual({ status: "connecting", lastError: null, reconnect: true });
  });

  it("registered default é true → 408 QR-timeout reconecta se `registered` não for passado", () => {
    const r = classifyClose(boom(DisconnectReason.timedOut, { message: "QR refs attempts ended" }));
    expect(r.reconnect).toBe(true);
  });

  it("timeout 408 genérico (sem 'QR refs attempts ended') em sessão não registrada → connecting, reconecta", () => {
    const r = classifyClose(boom(DisconnectReason.timedOut, { message: "Timed Out" }), { registered: false });
    expect(r.reconnect).toBe(true);
    expect(r.cleanup).toBeUndefined();
  });
});

describe("isStuckReconnecting", () => {
  const T = 90_000;

  it("reconnectingSince nulo/ausente → false (não está reconectando)", () => {
    expect(isStuckReconnecting(null, Date.now(), T)).toBe(false);
    expect(isStuckReconnecting(undefined, Date.now(), T)).toBe(false);
    expect(isStuckReconnecting(0, Date.now(), T)).toBe(false);
  });

  it("dentro da graça → false", () => {
    const since = 1_000_000;
    expect(isStuckReconnecting(since, since + T - 1, T)).toBe(false);
  });

  it("no limiar ou além → true", () => {
    const since = 1_000_000;
    expect(isStuckReconnecting(since, since + T, T)).toBe(true);
    expect(isStuckReconnecting(since, since + T + 5000, T)).toBe(true);
  });

  it("usa o limiar default quando omitido", () => {
    const since = 1_000_000;
    expect(isStuckReconnecting(since, since + 1000)).toBe(false);
    expect(isStuckReconnecting(since, since + 120_000)).toBe(true);
  });
});
