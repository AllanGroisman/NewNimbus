// A aba Cupons Teste (backend/coupons/preco-teste.js): o preço com cupom que a
// mensagem prometeu × o que o checkout do ML cobra, sobre o material do comando
// `cupom-no-checkout` da extensão e a captura real da página de cupons (campanha
// 14167118, 25% OFF, mínimo R$ 25, teto R$ 20 — o ML descontou R$ 20).
//
// O que custa caro errar aqui: dizer "bate" quando a mensagem prometeu mais barato
// do que o cliente paga, ou chamar de "cupom não pegou" o que foi só CAPTCHA.

import "../helpers/env.js";
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { interpretarConferencia, prometido } = require(path.resolve(__dirname, "..", "..", "backend", "coupons", "preco-teste.js"));
const cfgStore = require(path.resolve(__dirname, "..", "..", "backend", "coupons", "preco-teste-config.js"));
const htmlCupons = fs.readFileSync(path.resolve(__dirname, "..", "fixtures", "ml-checkout-cupons-iframe.html"), "utf8");

const CARTAO = "Com CASA25\n25% OFF\nCompra mínima R$ 25 | Limite de R$ 20 | Venc. 01/11/2026\nAplicado";
const RESUMO = "Resumo da compra Produto R$ 269,90 Frete Grátis Cupons (1/1 em uso) - R$ 20,00 Você pagará R$ 269,90 R$ 249,90 Pagar e finalizar";

const material = (extra = {}) => ({
  produto: { name: "Porteiro", price: 269.9 },
  checkout: { reached: true, via: "comprar-agora" },
  modal: { aberto: true, onde: "iframe", campo: true },
  resumoAntes: "Resumo da compra Produto R$ 269,90 Inserir código do cupom Você pagará R$ 269,90",
  resumoDepois: RESUMO,
  cartaoDepois: { texto: CARTAO, aplicado: true },
  htmlCupons,
  ...extra,
});
const alvo = (extra = {}) => ({ coupon: "CASA25", prometidoPreco: 269.9, prometidoComCupom: 249.9, ...extra });

describe("interpretarConferencia", () => {
  it("bate: a mensagem disse o mesmo que o ML cobra (desconto do próprio cupom, com teto)", () => {
    const r = interpretarConferencia(alvo(), material());
    expect(r.status).toBe("ok");
    expect(r.precoPagina).toBe(269.9);
    expect(r.descontoMl).toBe(20);
    expect(r.realComCupom).toBe(249.9);
    expect(r.diferenca).toBe(0);
    expect(r.detalhe.fonteDesconto).toBe("cupom");
    expect(r.detalhe.campaignId).toBe("14167118");
  });

  it("dentro da tolerância ainda bate; fora, diverge", () => {
    expect(interpretarConferencia(alvo({ prometidoComCupom: 249.95 }), material(), { toleranciaReais: 0.1 }).status).toBe("ok");
    expect(interpretarConferencia(alvo({ prometidoComCupom: 249.95 }), material(), { toleranciaReais: 0 }).status).toBe("divergente");
  });

  it("prometeu mais barato (conta sem o teto): diverge, diferença negativa e diz que bateu no teto", () => {
    const r = interpretarConferencia(alvo({ prometidoComCupom: 202.43 }), material());
    expect(r.status).toBe("divergente");
    expect(r.diferenca).toBeCloseTo(-47.47, 2);
    expect(r.motivo).toMatch(/mais barato/);
    expect(r.motivo).toMatch(/teto de R\$ 20,00/);
  });

  it("o preço do produto mudou desde o envio", () => {
    const r = interpretarConferencia(alvo({ prometidoPreco: 299.9, prometidoComCupom: 279.9 }), material());
    expect(r.status).toBe("divergente");
    expect(r.diferenca).toBe(30);
    expect(r.motivo).toMatch(/preço do produto mudou/);
  });

  it("a mensagem saiu sem desconto, mas o ML deu", () => {
    const r = interpretarConferencia(alvo({ prometidoComCupom: null }), material());
    expect(r.status).toBe("prometeu-sem-desconto");
    expect(r.realComCupom).toBe(249.9);
    expect(r.diferenca).toBe(20);
  });

  it("o ML disse que o cupom não está disponível: cupom não pegou", () => {
    const r = interpretarConferencia(alvo(), material({ cartaoDepois: null, erroCampo: "Erro: Este cupom não está mais disponível." }));
    expect(r.status).toBe("cupom-nao-pegou");
    expect(r.motivo).toMatch(/CASA25/);
    expect(r.motivo).toMatch(/249,90/);
  });

  it("CAPTCHA não é resposta sobre o cupom: falhou, com o muro marcado", () => {
    const r = interpretarConferencia(alvo(), { muro: "captcha" });
    expect(r.status).toBe("falhou");
    expect(r.muro).toBe(true);
  });

  it("não chegou ao checkout: falhou, sem diferença", () => {
    const r = interpretarConferencia(alvo(), { produto: { price: 10 }, checkout: { reached: false, blockedReason: "x" } });
    expect(r.status).toBe("falhou");
    expect(r.diferenca).toBeNull();
  });

  it("sem a página dos cupons, usa o desconto do resumo da compra", () => {
    const r = interpretarConferencia(alvo(), material({ htmlCupons: null }));
    expect(r.detalhe.fonteDesconto).toBe("resumo");
    expect(r.descontoMl).toBe(20);
    expect(r.status).toBe("ok");
  });

  it("cupom aplicado mas sem preço na página: falhou (não inventa a conta)", () => {
    const r = interpretarConferencia(alvo(), material({ produto: null }));
    expect(r.status).toBe("falhou");
    expect(r.motivo).toMatch(/preço na página/);
  });
});

describe("prometido", () => {
  it("envio novo: usa o que foi gravado (sentPrice manda sobre price)", async () => {
    const p = await prometido({ coupon: "X", sentPrice: 99, price: 120, priceWithCoupon: 89, couponLabel: "10% OFF" }, async () => { throw new Error("não deveria estimar"); });
    expect(p).toEqual({ estimado: false, coupon: "X", preco: 99, comCupom: 89, rotulo: "10% OFF" });
  });

  it("envio antigo: refaz a conta e marca estimado", async () => {
    const p = await prometido({ price: 100 }, async () => ({ coupon: "Y", comCupom: 90, rotulo: "10% OFF" }));
    expect(p).toEqual({ estimado: true, coupon: "Y", preco: 100, comCupom: 90, rotulo: "10% OFF" });
  });

  it("envio antigo sem cupom conhecido hoje: sem cupom", async () => {
    const p = await prometido({ price: 100 }, async () => null);
    expect(p.coupon).toBeNull();
  });
});

describe("preco-teste-config.sanitize", () => {
  it("prende os números na faixa e ignora chave velha", () => {
    const c = cfgStore.sanitize({ dias: 99, maxProdutos: 0, toleranciaReais: "0,256", pausaEntreMs: -5, soComCupom: false, campanhas: ["12", "x", 12, "12"] });
    expect(c.dias).toBe(30);
    expect(c.maxProdutos).toBe(1);
    expect(c.toleranciaReais).toBe(0.26);
    expect(c.pausaEntreMs).toBe(0);
    expect(c.campanhas).toEqual(["12"]);
    expect(c).not.toHaveProperty("soComCupom");
  });

  it("vazio vira o padrão", () => {
    expect(cfgStore.sanitize(null)).toEqual(cfgStore.DEFAULTS);
  });
});
