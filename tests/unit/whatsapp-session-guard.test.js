// Guardas que impedem SOCKET DUPLICADO e SESSÃO PROVISÓRIA ÓRFÃ — as duas formas
// de "conexão fantasma" que apareciam em produção.
//
// - isCurrentGen: cada socket aberto recebe uma geração. Quando um socket é
//   substituído, o handler do antigo tem que virar no-op; senão os dois mutam a
//   mesma sessão, os dois agendam reconexão e os dois gravam chaves Signal na
//   mesma linha de baileys_auth (os "Bad MAC" do worker-error.log).
// - isOrphanQrSession: usuário abre o QR, não escaneia e fecha a aba. Sobra uma
//   sessão sob um id provisório que não existe em whatsapp_numbers — invisível
//   na tela e reciclando QR pra ninguém.

import "../helpers/env.js";
import { describe, it, expect } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { isCurrentGen, isOrphanQrSession } =
  require(path.resolve(__dirname, "..", "..", "backend", "whatsapp", "local.js"));

describe("isCurrentGen", () => {
  it("sessão inexistente → false", () => {
    expect(isCurrentGen(null, 1)).toBe(false);
    expect(isCurrentGen(undefined, 1)).toBe(false);
  });

  it("geração igual → true (é o socket vigente)", () => {
    expect(isCurrentGen({ gen: 7 }, 7)).toBe(true);
  });

  it("geração antiga → false (socket já foi substituído)", () => {
    expect(isCurrentGen({ gen: 8 }, 7)).toBe(false);
  });
});

describe("isOrphanQrSession", () => {
  const NOW = 10_000_000;
  const MAX = 10 * 60 * 1000;
  const awaiting = (ageMs, extra = {}) => ({
    status: "awaiting_qr",
    createdAt: NOW - ageMs,
    sock: { authState: { creds: { registered: false } } },
    ...extra,
  });

  it("sessão nula → false", () => {
    expect(isOrphanQrSession(null, NOW, MAX)).toBe(false);
  });

  it("já pareada (registered) nunca é órfã, por mais velha que seja", () => {
    const s = awaiting(60 * 60 * 1000, { sock: { authState: { creds: { registered: true } } } });
    expect(isOrphanQrSession(s, NOW, MAX)).toBe(false);
  });

  it("conectada não é órfã", () => {
    expect(isOrphanQrSession({ ...awaiting(MAX * 2), status: "connected" }, NOW, MAX)).toBe(false);
  });

  it("esperando QR há pouco tempo → ainda não (o usuário pode estar pegando o celular)", () => {
    expect(isOrphanQrSession(awaiting(MAX - 1), NOW, MAX)).toBe(false);
  });

  it("esperando QR além do limite → órfã", () => {
    expect(isOrphanQrSession(awaiting(MAX), NOW, MAX)).toBe(true);
    expect(isOrphanQrSession(awaiting(MAX + 60_000), NOW, MAX)).toBe(true);
  });

  it("presa em connecting sem nunca ter pareado também conta", () => {
    expect(isOrphanQrSession({ ...awaiting(MAX + 1), status: "connecting" }, NOW, MAX)).toBe(true);
  });
});
