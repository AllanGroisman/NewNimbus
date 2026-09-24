// A leitura do teste do cupom do repasse no checkout do produto (task 7):
// backend/repasse/checkout-cupom.js, sobre o material que o comando
// `cupom-no-checkout` da extensão devolve.
//
// O que custa caro errar aqui: chamar de "o ML recusou" um cupom que nem chegou a
// ser digitado (muro, checkout que não abriu). "invalid" tira o cupom da fila de
// testes para sempre; "indeterminado" deixa ele voltar.

import "../helpers/env.js";
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { interpretar, verdictDe, mensagemDe, condicoesDoCartao, totalDoResumo, campanhaDoCodigo } =
  require(path.resolve(__dirname, "..", "..", "backend", "repasse", "checkout-cupom.js"));
const htmlCupons = fs.readFileSync(path.resolve(__dirname, "..", "fixtures", "ml-checkout-cupons-iframe.html"), "utf8");

// O cartão real do MELIKIDS, como o innerText do iframe devolve.
const CARTAO_MELIKIDS = "Com MELIKIDS\n15% OFF\nCompra mínima R$ 59 | Limite de R$ 50 | Venc. 27/09/2026\nEstá esgotando!\nAplicado";
const RESUMO = "Resumo da compra Produto R$ 269,90 Frete Grátis Cupons (1/1 em uso) - R$ 40,48 Você pagará R$ 269,90 R$ 229,42 Pagar e finalizar";

const chegou = (extra = {}) => ({
  checkout: { reached: true, via: "comprar-agora" },
  modal: { aberto: true, onde: "iframe", campo: true },
  resumoAntes: RESUMO,
  resumoDepois: RESUMO,
  ...extra,
});

describe("condicoesDoCartao", () => {
  it("lê desconto, mínimo, limite, vencimento e alerta do cartão", () => {
    expect(condicoesDoCartao(CARTAO_MELIKIDS)).toEqual({
      desconto: "15% OFF",
      compra_minima: 59,
      limite_desconto: 50,
      vencimento: "2026-09-27",
      alerta: "Está esgotando!",
    });
  });

  it("desconto em reais e valores com milhar", () => {
    const c = condicoesDoCartao("Com PROMO\nR$ 20 OFF\nCompra mínima R$ 1.299,90 | Venc. 01/10/2026");
    expect(c.desconto).toBe("R$ 20 OFF");
    expect(c.compra_minima).toBe(1299.9);
    expect(c.limite_desconto).toBeNull();
    expect(c.alerta).toBeNull();
  });
});

describe("totalDoResumo", () => {
  it("com preço riscado, o total é o último valor", () => {
    expect(totalDoResumo(RESUMO)).toBe(229.42);
  });
});

describe("interpretar", () => {
  it("cartão já aplicado → ja_aplicado, com as condições e o resumo", () => {
    const r = interpretar(chegou({ cartaoAntes: { texto: CARTAO_MELIKIDS, aplicado: true } }), "melikids");
    expect(r).toMatchObject({
      codigo: "MELIKIDS",
      status: "ja_aplicado",
      desconto: "15% OFF",
      compra_minima: 59,
      limite_desconto: 50,
      vencimento: "2026-09-27",
      alerta: "Está esgotando!",
      desconto_no_pedido: 40.48,
      total_final: 229.42,
      cupons_em_uso: "1/1",
    });
    expect(verdictDe(r)).toBe("valid");
    expect(mensagemDe(r)).toMatch(/Já estava aplicado.*15% OFF.*mínimo R\$ 59.*limite R\$ 50.*vence 27\/09\/2026/);
  });

  it("digitou e o cartão apareceu aplicado → aplicado_agora", () => {
    const r = interpretar(chegou({
      cartaoAntes: null,
      cartaoDepois: { texto: CARTAO_MELIKIDS, aplicado: true },
    }), "MELIKIDS");
    expect(r.status).toBe("aplicado_agora");
    expect(verdictDe(r)).toBe("valid");
  });

  it("\"já foi adicionado\" → ja_aplicado, guardando a frase do ML", () => {
    const erro = "Este cupom já foi adicionado, mas ainda pode ser usado em produtos selecionados.";
    const r = interpretar(chegou({ erroCampo: erro }), "MELIKIDS");
    expect(r.status).toBe("ja_aplicado");
    expect(r.mensagem_site).toBe(erro);
    expect(verdictDe(r)).toBe("valid");
  });

  it("\"não está mais disponível\" → falha e invalid", () => {
    const r = interpretar(chegou({ erroCampo: "O cupom não está mais disponível." }), "NAOEXISTE1");
    expect(r).toMatchObject({ status: "falha", motivo: "indisponivel", mensagem_site: "O cupom não está mais disponível." });
    expect(verdictDe(r)).toBe("invalid");
    expect(mensagemDe(r)).toMatch(/não está disponível.*ML: "O cupom não está mais disponível\."/);
  });

  it("outra frase do ML → falha, mas indeterminado (não se sabe se o cupom existe)", () => {
    const r = interpretar(chegou({ erroCampo: "Não foi possível adicionar o cupom agora." }), "X1");
    expect(r).toMatchObject({ status: "falha", motivo: "erro-do-site", mensagem_site: "Não foi possível adicionar o cupom agora." });
    expect(verdictDe(r)).toBe("indeterminado");
  });

  it("sem erro e sem cartão aplicado → sem-confirmacao", () => {
    const r = interpretar(chegou({ cartaoDepois: { texto: "Com X1\n10% OFF\nAplicar", aplicado: false } }), "X1");
    expect(r.motivo).toBe("sem-confirmacao");
    expect(verdictDe(r)).toBe("indeterminado");
  });

  it.each([
    ["muro", { muro: "captcha" }, "muro"],
    ["não é produto", { notProductPage: true }, "nao-e-produto"],
    ["não chegou ao checkout", { checkout: { reached: false, blockedReason: "O botão de compra está desabilitado nesta página." } }, "sem-checkout"],
    ["modal não abriu", { checkout: { reached: true }, modal: { aberto: false } }, "modal-nao-abriu"],
  ])("%s → indeterminado, com o porquê", (_, material, motivo) => {
    const r = interpretar(material, "X1");
    expect(r.status).toBe("falha");
    expect(r.motivo).toBe(motivo);
    expect(verdictDe(r)).toBe("indeterminado");
    expect(mensagemDe(r)).not.toMatch(/não respondeu/);
  });

  it("muro vira `bloqueio`, que é o que pausa a fila automática", () => {
    expect(interpretar({ muro: "captcha" }, "X1").bloqueio).toBe("captcha");
  });

  it("não inventa campanha quando o teste falhou", () => {
    const r = interpretar(chegou({ erroCampo: "O cupom não está mais disponível.", htmlCupons }), "X1");
    expect(r.campaignId).toBeNull();
  });
});

describe("campanhaDoCodigo", () => {
  it("sem código no modelo, acha a campanha pelas condições do cartão (captura real)", () => {
    expect(campanhaDoCodigo(htmlCupons, "CASA25", { desconto: "25% OFF", compra_minima: 25, limite_desconto: 20 })).toBe("14167118");
  });

  it("condições que não batem → null", () => {
    expect(campanhaDoCodigo(htmlCupons, "CASA25", { desconto: "15% OFF", compra_minima: 59, limite_desconto: 50 })).toBeNull();
  });

  it("HTML sem modelo → null", () => {
    expect(campanhaDoCodigo("<html></html>", "X", { desconto: "25% OFF" })).toBeNull();
  });
});
