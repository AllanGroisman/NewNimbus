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
    const r = classifyClose(boom(DisconnectReason.timedOut, { message: "QR refs attempts ended" }), { paired: false });
    expect(r.status).toBe("disconnected");
    expect(r.reconnect).toBe(false);
    expect(r.cleanup).toBe(true);
    expect(r.lastError).toMatch(/QR/i);
  });

  it("QR expirado (408) em sessão JÁ registrada → connecting, reconecta (timeout de rede normal)", () => {
    const r = classifyClose(boom(DisconnectReason.timedOut, { message: "QR refs attempts ended" }), { paired: true });
    expect(r).toEqual({ status: "connecting", lastError: null, reconnect: true });
  });

  it("paired default é true → 408 QR-timeout reconecta se `paired` não for passado", () => {
    const r = classifyClose(boom(DisconnectReason.timedOut, { message: "QR refs attempts ended" }));
    expect(r.reconnect).toBe(true);
  });

  it("timeout 408 genérico (sem 'QR refs attempts ended') em sessão não registrada → connecting, reconecta", () => {
    const r = classifyClose(boom(DisconnectReason.timedOut, { message: "Timed Out" }), { paired: false });
    expect(r.reconnect).toBe(true);
    expect(r.cleanup).toBeUndefined();
  });

  it("401 em sessão NUNCA registrada não é logout — não há device pra deslogar", () => {
    const r = classifyClose(boom(DisconnectReason.loggedOut, { message: "Connection Failure" }), { paired: false });
    expect(r.status).toBe("disconnected");
    expect(r.reconnect).toBe(false);
    expect(r.cleanup).toBe(true);
  });
});

// Log real de produção: um close com tag=conflict é seguido, 3s depois, de um 401
// "Connection Failure" SECO. Sem a janela abaixo, esse eco virava "logout real" —
// e, como logout agora apaga as credenciais, o usuário perderia o pareamento por
// causa de dois sockets brigando.
describe("classifyClose — eco de conflito não é logout", () => {
  const NOW = 1_000_000;
  const bare401 = boom(DisconnectReason.loggedOut, { message: "Connection Failure" });

  it("conflito sinaliza `conflict` pro handler abrir a janela", () => {
    const r = classifyClose(boom(DisconnectReason.loggedOut, { tag: "conflict" }));
    expect(r.conflict).toBe(true);
    expect(r.reconnect).toBe(true);
  });

  it("401 seco logo depois de um conflito → connecting (reconecta), marcado como eco", () => {
    const r = classifyClose(bare401, { now: NOW, lastConflictAt: NOW - 3000, conflictRetries: 0 });
    expect(r.status).toBe("connecting");
    expect(r.reconnect).toBe(true);
    expect(r.conflictEcho).toBe(true);
  });

  it("401 seco FORA da janela de conflito → logout real", () => {
    const r = classifyClose(bare401, { now: NOW, lastConflictAt: NOW - 120_000, conflictRetries: 0 });
    expect(r.status).toBe("logged_out");
    expect(r.terminal).toBe(true);
  });

  it("teto de tentativas estourado → logout real (não fica em loop eterno)", () => {
    const r = classifyClose(bare401, { now: NOW, lastConflictAt: NOW - 1000, conflictRetries: 3 });
    expect(r.status).toBe("logged_out");
    expect(r.reconnect).toBe(false);
  });

  it("sem conflito anterior, 401 é logout na primeira", () => {
    const r = classifyClose(bare401, { now: NOW, lastConflictAt: null });
    expect(r.status).toBe("logged_out");
  });

  it("shutdown vence tudo: nem conflito nem 401 escapam do 'disconnected'", () => {
    expect(classifyClose(bare401, { shuttingDown: true }).status).toBe("disconnected");
    expect(classifyClose(boom(DisconnectReason.loggedOut, { tag: "conflict" }), { shuttingDown: true }).status)
      .toBe("disconnected");
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
