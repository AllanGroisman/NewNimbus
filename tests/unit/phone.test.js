// Validação de telefone — é o que sustenta "toda conta tem um celular".
// O mesmo algoritmo está em frontend/src/data/phone.js e no popup da landing.

import { describe, it, expect } from "vitest";
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const requireCjs = createRequire(import.meta.url);
const { normalizePhone, toStoredPhone, isValidPhone, formatPhone } =
  requireCjs(path.resolve(__dirname, "..", "..", "backend", "utils", "phone.js"));

describe("normalizePhone", () => {
  it("deixa só os dígitos, sem julgar o resultado", () => {
    expect(normalizePhone("(11) 99999-9999")).toBe("11999999999");
    expect(normalizePhone("+55 11 99999-9999")).toBe("5511999999999");
    // Mesma semântica do normalizePhone de whatsapp/local.js: não valida.
    expect(normalizePhone("abc123")).toBe("123");
  });

  it("aguenta nulo e lixo", () => {
    expect(normalizePhone(null)).toBe("");
    expect(normalizePhone(undefined)).toBe("");
    expect(normalizePhone("abc")).toBe("");
  });
});

describe("toStoredPhone", () => {
  it("aceita as quatro formas que a pessoa digita", () => {
    for (const entrada of [
      "(11) 99999-9999",
      "11999999999",
      "5511999999999",
      "+55 11 99999-9999",
    ]) {
      expect(toStoredPhone(entrada)).toBe("5511999999999");
    }
  });

  it("sempre devolve 13 dígitos com o 55 na frente", () => {
    const stored = toStoredPhone("(21) 98765-4321");
    expect(stored).toBe("5521987654321");
    expect(stored).toHaveLength(13);
  });

  it("não come o DDD de quem mora no 55", () => {
    // 55 999999999 tem 11 dígitos: é DDD do RS, não o código do país.
    expect(toStoredPhone("(55) 99999-9999")).toBe("5555999999999");
  });

  it("recusa DDD que não existe", () => {
    expect(toStoredPhone("(00) 99999-9999")).toBe("");
    expect(toStoredPhone("(20) 99999-9999")).toBe("");
    expect(toStoredPhone("(90) 99999-9999")).toBe("");
  });

  it("recusa fixo — o número tem que virar conversa de WhatsApp", () => {
    expect(toStoredPhone("(11) 3333-4444")).toBe("");
    expect(toStoredPhone("1133334444")).toBe("");
    // Oito dígitos com nono errado: celular no Brasil começa com 9.
    expect(toStoredPhone("(11) 88888-8888")).toBe("");
  });

  it("recusa número curto, longo, vazio e lixo", () => {
    expect(toStoredPhone("119999999")).toBe("");
    expect(toStoredPhone("119999999999")).toBe("");
    expect(toStoredPhone("")).toBe("");
    expect(toStoredPhone(null)).toBe("");
    expect(toStoredPhone("não é telefone")).toBe("");
  });
});

describe("isValidPhone", () => {
  it("é o toStoredPhone em forma de booleano", () => {
    expect(isValidPhone("(11) 99999-9999")).toBe(true);
    expect(isValidPhone("5511999999999")).toBe(true);
    expect(isValidPhone("1133334444")).toBe(false);
    // O "" das contas anteriores à regra é o que faz phoneRequired virar true.
    expect(isValidPhone("")).toBe(false);
    expect(isValidPhone(null)).toBe(false);
  });
});

describe("formatPhone", () => {
  it("devolve o número legível a partir do que está gravado", () => {
    expect(formatPhone("5511999999999")).toBe("(11) 99999-9999");
    expect(formatPhone("11999999999")).toBe("(11) 99999-9999");
  });

  it("número inválido volta como os dígitos crus, sem quebrar a tela", () => {
    expect(formatPhone("1133334444")).toBe("1133334444");
    expect(formatPhone("")).toBe("");
    expect(formatPhone(null)).toBe("");
  });
});
