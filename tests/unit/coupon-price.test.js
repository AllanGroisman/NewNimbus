// A conta do desconto do cupom (backend/coupons/price.js) — pura, sem banco.
//
// O que está sendo protegido aqui é o `null`: ele é o que faz o {preco_com_cupom}
// do modelo de mensagem virar o preço normal. Um `null` que virasse número
// anunciaria desconto que o ML não daria.

import { describe, it, expect } from "vitest";
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { precoComCupom } = require(path.resolve(__dirname, "..", "..", "backend", "coupons", "price.js"));

const daqui = min => new Date(Date.now() + min * 60000).toISOString();

describe("precoComCupom — cupom percentual", () => {
  it("desconta a porcentagem", () => {
    expect(precoComCupom(200, { kind: "percent", value: 10 })).toBe(180);
  });

  it("arredonda em centavos", () => {
    expect(precoComCupom(1899, { kind: "percent", value: 15 })).toBe(1614.15);
  });

  it("respeita o teto (maxDiscount)", () => {
    // 20% de 1000 = 200, mas o cupom não desconta mais que 50.
    expect(precoComCupom(1000, { kind: "percent", value: 20, maxDiscount: 50 })).toBe(950);
  });

  it("teto maior que o desconto não muda nada", () => {
    expect(precoComCupom(1000, { kind: "percent", value: 20, maxDiscount: 500 })).toBe(800);
  });

  it("100% ou mais é dado quebrado — preço normal", () => {
    expect(precoComCupom(200, { kind: "percent", value: 100 })).toBeNull();
    expect(precoComCupom(200, { kind: "percent", value: 150 })).toBeNull();
  });
});

describe("precoComCupom — cupom de valor fixo", () => {
  it("desconta o valor em reais", () => {
    expect(precoComCupom(200, { kind: "fixed", value: 30 })).toBe(170);
  });

  it("desconto maior que o preço não vira preço zerado/negativo", () => {
    expect(precoComCupom(20, { kind: "fixed", value: 30 })).toBeNull();
    expect(precoComCupom(30, { kind: "fixed", value: 30 })).toBeNull();
  });
});

describe("precoComCupom — quando o cupom NÃO vale (preço normal)", () => {
  it("sem regra nenhuma", () => {
    expect(precoComCupom(200, null)).toBeNull();
    expect(precoComCupom(200, undefined)).toBeNull();
  });

  it("compra mínima não atingida", () => {
    expect(precoComCupom(150, { kind: "percent", value: 10, minPurchase: 200 })).toBeNull();
    // Exatamente na mínima o cupom pega.
    expect(precoComCupom(200, { kind: "percent", value: 10, minPurchase: 200 })).toBe(180);
  });

  it("minPurchase nulo é 'sem compra mínima'", () => {
    expect(precoComCupom(10, { kind: "percent", value: 10, minPurchase: null })).toBe(9);
  });

  it("cupom vencido", () => {
    expect(precoComCupom(200, { kind: "percent", value: 10, expiresAt: daqui(-60) })).toBeNull();
  });

  it("cupom ainda não começou", () => {
    expect(precoComCupom(200, { kind: "percent", value: 10, startsAt: daqui(60) })).toBeNull();
  });

  it("validade em aberto (expiresAt nulo) vale — é a regra do couponsForKeys", () => {
    expect(precoComCupom(200, { kind: "percent", value: 10, expiresAt: null })).toBe(180);
    expect(precoComCupom(200, { kind: "percent", value: 10, expiresAt: daqui(60), startsAt: daqui(-60) })).toBe(180);
  });

  it("aceita Date além de string na validade", () => {
    expect(precoComCupom(200, { kind: "percent", value: 10, expiresAt: new Date(Date.now() - 60000) })).toBeNull();
    expect(precoComCupom(200, { kind: "percent", value: 10, expiresAt: new Date(Date.now() + 60000) })).toBe(180);
  });

  it("kind desconhecido — nas duas grafias que existem no banco", () => {
    expect(precoComCupom(200, { kind: "unknown", value: 10 })).toBeNull();
    expect(precoComCupom(200, { kind: "desconhecido", value: 10 })).toBeNull();
    expect(precoComCupom(200, { value: 10 })).toBeNull();
  });

  it("valor ausente, zero ou não numérico", () => {
    expect(precoComCupom(200, { kind: "percent", value: null })).toBeNull();
    expect(precoComCupom(200, { kind: "percent", value: 0 })).toBeNull();
    expect(precoComCupom(200, { kind: "fixed", value: "abacaxi" })).toBeNull();
  });

  it("preço ausente, zero ou não numérico", () => {
    expect(precoComCupom(null, { kind: "percent", value: 10 })).toBeNull();
    expect(precoComCupom(0, { kind: "percent", value: 10 })).toBeNull();
    expect(precoComCupom(-5, { kind: "percent", value: 10 })).toBeNull();
    expect(precoComCupom("abacaxi", { kind: "percent", value: 10 })).toBeNull();
  });
});
