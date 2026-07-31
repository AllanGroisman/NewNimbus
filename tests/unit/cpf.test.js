// Validação de CPF — é o que sustenta a regra "uma conta = um CPF".
// O mesmo algoritmo está em frontend/src/data/cpf.js e no popup da landing.

import { describe, it, expect } from "vitest";
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const requireCjs = createRequire(import.meta.url);
const { normalizeCpf, isValidCpf, formatCpf, maskCpf, maskEmail } =
  requireCjs(path.resolve(__dirname, "..", "..", "backend", "utils", "cpf.js"));

describe("normalizeCpf", () => {
  it("deixa só os dígitos", () => {
    expect(normalizeCpf("529.982.247-25")).toBe("52998224725");
    expect(normalizeCpf(" 529 982 247 25 ")).toBe("52998224725");
  });

  it("aguenta nulo e lixo", () => {
    expect(normalizeCpf(null)).toBe("");
    expect(normalizeCpf(undefined)).toBe("");
    expect(normalizeCpf("abc")).toBe("");
  });
});

describe("isValidCpf", () => {
  it("aceita CPF válido, com ou sem pontuação", () => {
    expect(isValidCpf("52998224725")).toBe(true);
    expect(isValidCpf("529.982.247-25")).toBe(true);
    expect(isValidCpf("111.444.777-35")).toBe(true);
  });

  it("recusa dígito verificador errado", () => {
    expect(isValidCpf("52998224726")).toBe(false);
    expect(isValidCpf("11144477700")).toBe(false);
  });

  it("recusa tamanho fora de 11 dígitos", () => {
    expect(isValidCpf("5299822472")).toBe(false);
    expect(isValidCpf("529982247250")).toBe(false);
    expect(isValidCpf("")).toBe(false);
  });

  it("recusa sequências repetidas, que passam na conta mas não existem", () => {
    expect(isValidCpf("00000000000")).toBe(false);
    expect(isValidCpf("11111111111")).toBe(false);
    expect(isValidCpf("99999999999")).toBe(false);
  });
});

describe("formatação", () => {
  it("formatCpf monta a pontuação", () => {
    expect(formatCpf("52998224725")).toBe("529.982.247-25");
  });

  it("maskCpf esconde o miolo", () => {
    expect(maskCpf("52998224725")).toBe("529.***.***-25");
    expect(maskCpf("123")).toBe("");
  });

  it("maskEmail deixa reconhecer a conta sem entregar o endereço", () => {
    expect(maskEmail("fulano@gmail.com")).toBe("f*****@gmail.com");
    expect(maskEmail("a@x.com")).toBe("a*@x.com");
    expect(maskEmail("sem-arroba")).toBe("");
  });
});
