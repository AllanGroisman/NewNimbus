// Veredito de "esse cupom vale nesse produto?" a partir do que o checkout do ML
// mostrou. classifyCouponResult é pura: recebe url final, texto da tela, o JSON
// que a página buscou e o total antes/depois, e diz o que aconteceu. Sem navegador.

import "../helpers/env.js";
import { describe, it, expect } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { classifyCouponResult, collectMessages } = require(path.resolve(__dirname, "..", "..", "backend", "scraping", "ml-coupon.js"));

const CHECKOUT = "https://www.mercadolivre.com.br/checkout/v1/payment";

describe("classifyCouponResult", () => {
  it("o total caindo é a prova de que o cupom entrou", () => {
    const r = classifyCouponResult({ finalUrl: CHECKOUT, totalBefore: 110, totalAfter: 99.9 });
    expect(r.status).toBe("valido");
    expect(r.discount).toBe(10.1);
    expect(r.reason).toContain("10,10");
  });

  it("código que o ML não reconhece", () => {
    const r = classifyCouponResult({ finalUrl: CHECKOUT, bodyText: "Cupom inválido. Verifique o código." });
    expect(r.status).toBe("invalido");
  });

  it("cupom expirado — 'expirou' e 'expirado' contam igual", () => {
    expect(classifyCouponResult({ finalUrl: CHECKOUT, bodyText: "Este cupom já expirou" }).status).toBe("expirado");
    expect(classifyCouponResult({ finalUrl: CHECKOUT, bodyText: "Cupom expirado" }).status).toBe("expirado");
    expect(classifyCouponResult({ finalUrl: CHECKOUT, bodyText: "Cupom vencido" }).status).toBe("expirado");
  });

  it("'inválido ou expirado' não vira veredito confiante: fica em invalido, com a ressalva", () => {
    const r = classifyCouponResult({ finalUrl: CHECKOUT, bodyText: "Cupom inválido ou expirado" });
    expect(r.status).toBe("invalido");
    expect(r.reason).toMatch(/não separa/i);
  });

  it("cupom que existe mas não serve pro produto", () => {
    const r = classifyCouponResult({ finalUrl: CHECKOUT, bodyText: "Este cupom não é válido para este produto" });
    expect(r.status).toBe("nao-aplicavel");
  });

  it("cupom que existe mas exige valor mínimo", () => {
    const r = classifyCouponResult({ finalUrl: CHECKOUT, bodyText: "Válido em compras acima de R$ 200" });
    expect(r.status).toBe("minimo-nao-atingido");
  });

  it("cupom já usado", () => {
    const r = classifyCouponResult({ finalUrl: CHECKOUT, bodyText: "Você já utilizou este cupom" });
    expect(r.status).toBe("usado");
  });

  it("o veredito sai do JSON que a página buscou, não só do texto da tela", () => {
    const r = classifyCouponResult({
      finalUrl: CHECKOUT,
      bodyText: "Resumo da compra",
      apiJson: [{ error: { message: "O cupom não se aplica a este item" } }],
    });
    expect(r.status).toBe("nao-aplicavel");
  });

  it("'cupom aplicado' sem o total cair não passa por aprovado", () => {
    const r = classifyCouponResult({ finalUrl: CHECKOUT, bodyText: "Cupom aplicado", totalBefore: 110, totalAfter: 110 });
    expect(r.status).toBe("indeterminado");
    expect(r.reason).toMatch(/total do pedido não mudou/i);
  });

  it("muro de login tem precedência sobre qualquer texto", () => {
    const r = classifyCouponResult({
      finalUrl: "https://www.mercadolivre.com.br/jms/mlb/lgz/login?go=checkout",
      bodyText: "Cupom aplicado",
      totalBefore: 110, totalAfter: 90,
    });
    expect(r.status).toBe("login");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cookie novo/i);
  });

  it("CAPTCHA", () => {
    const r = classifyCouponResult({ finalUrl: "https://www.mercadolivre.com.br/captcha/wall" });
    expect(r.status).toBe("captcha");
    expect(r.ok).toBe(false);
  });

  it("tela que ninguém reconhece vira indeterminado, não um chute", () => {
    const r = classifyCouponResult({ finalUrl: CHECKOUT, bodyText: "Escolha como quer pagar" });
    expect(r.status).toBe("indeterminado");
    expect(r.reason).toMatch(/dump/i);
  });
});

describe("collectMessages", () => {
  it("acha a mensagem em qualquer profundidade do JSON", () => {
    const msgs = collectMessages([{ data: { errors: [{ detail: "Cupom inválido" }] } }]);
    expect(msgs).toContain("Cupom inválido");
  });

  it("ignora campos que não são mensagem", () => {
    const msgs = collectMessages([{ id: "abc123", total: 99, error: { message: "boom" } }]);
    expect(msgs).toEqual(["boom"]);
  });
});

// Verificação de CONTA ≠ sessão vencida. Separadas porque a saída é outra: uma
// pede cookie novo, a outra pede que um humano abra o ML e resolva com a conta.
describe("classifyCouponResult > conta em verificação", () => {
  it("account-verification não vira 'cole um cookie novo'", () => {
    const r = classifyCouponResult({ finalUrl: "https://www.mercadolivre.com.br/gz/account-verification?go=x" });
    expect(r.status).toBe("verificacao");
    expect(r.reason).not.toMatch(/cole um cookie/i);
    expect(r.reason).toMatch(/verifica[çc][ãa]o/i);
  });

  it("o checkout mora em /gz/ e não pode ser confundido com muro de login", () => {
    const r = classifyCouponResult({
      finalUrl: "https://www.mercadolivre.com.br/gz/checkout/shipping",
      bodyText: "Cupom aplicado", totalBefore: 100, totalAfter: 90,
    });
    expect(r.status).toBe("valido");
  });
});
