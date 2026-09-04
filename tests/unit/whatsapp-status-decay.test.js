// O snapshot de status no Redis pode MENTIR. Se o worker morre sem passar pelo
// closeAll (OOM do max_memory_restart, SIGKILL, uncaughtException), a chave fica
// com "connected" até o TTL de 24h — e o painel do usuário, o card "Operando" e o
// counts.connectedNumbers do admin mostram conectado o que não está.
//
// decaySnapshot rebaixa status VIVO quando não há worker vivo ou o snapshot está
// velho. Status terminal (logged_out) passa incólume: ele é a informação certa.

import "../helpers/env.js";
import { describe, it, expect } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { decaySnapshot, STALE_SNAPSHOT_MS } =
  require(path.resolve(__dirname, "..", "..", "backend", "infra", "session-status.js"));

const NOW = Date.parse("2026-09-04T15:00:00.000Z");
const snap = (over = {}) => ({
  userId: "u1",
  numberId: "555599999999",
  status: "connected",
  info: { phone: "555599999999" },
  lastError: null,
  stuck: false,
  updatedAt: new Date(NOW - 10_000).toISOString(),
  ...over,
});

describe("decaySnapshot", () => {
  it("worker vivo + snapshot fresco → intacto", () => {
    const s = snap();
    expect(decaySnapshot(s, { now: NOW, workerAgeSeconds: 4 })).toBe(s);
  });

  it("heartbeat ausente (worker nunca escreveu / expirou) → rebaixa", () => {
    const r = decaySnapshot(snap(), { now: NOW, workerAgeSeconds: null });
    expect(r.status).toBe("disconnected");
    expect(r.stale).toBe(true);
    expect(r.lastError).toMatch(/indisponível/i);
  });

  it("heartbeat velho demais → rebaixa", () => {
    const r = decaySnapshot(snap(), { now: NOW, workerAgeSeconds: 120 });
    expect(r.status).toBe("disconnected");
    expect(r.stale).toBe(true);
  });

  it("worker vivo mas snapshot parado além do limite → rebaixa", () => {
    const velho = snap({ updatedAt: new Date(NOW - STALE_SNAPSHOT_MS - 1000).toISOString() });
    const r = decaySnapshot(velho, { now: NOW, workerAgeSeconds: 3 });
    expect(r.status).toBe("disconnected");
    expect(r.stale).toBe(true);
  });

  it("updatedAt inválido/ausente → rebaixa (não dá pra provar que está vivo)", () => {
    expect(decaySnapshot(snap({ updatedAt: null }), { now: NOW, workerAgeSeconds: 3 }).status)
      .toBe("disconnected");
    expect(decaySnapshot(snap({ updatedAt: "nao-e-data" }), { now: NOW, workerAgeSeconds: 3 }).status)
      .toBe("disconnected");
  });

  it("falha ao ler o heartbeat (undefined) → fail-open, NÃO rebaixa", () => {
    // Um erro de leitura do Redis não pode pintar o sistema inteiro de vermelho.
    const s = snap();
    expect(decaySnapshot(s, { now: NOW, workerAgeSeconds: undefined })).toBe(s);
  });

  it("awaiting_qr e connecting também são status vivos", () => {
    for (const status of ["awaiting_qr", "connecting"]) {
      const r = decaySnapshot(snap({ status }), { now: NOW, workerAgeSeconds: null });
      expect(r.status).toBe("disconnected");
    }
  });

  it("logged_out é a verdade sobre a sessão — passa intacto mesmo sem worker", () => {
    const s = snap({ status: "logged_out", terminal: true, lastError: "Leia o QR de novo." });
    expect(decaySnapshot(s, { now: NOW, workerAgeSeconds: null })).toBe(s);
  });

  it("disconnected não é mexido (já é o pior caso)", () => {
    const s = snap({ status: "disconnected" });
    expect(decaySnapshot(s, { now: NOW, workerAgeSeconds: null })).toBe(s);
  });

  it("snapshot nulo passa direto", () => {
    expect(decaySnapshot(null, { now: NOW, workerAgeSeconds: null })).toBe(null);
  });
});
