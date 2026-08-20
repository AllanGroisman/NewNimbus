// Leitura dos TEXTOS CRUS que a página do produto e o checkout devolvem.
// Quem vasculha o DOM só recolhe texto; a interpretação mora no Node e é isto
// aqui — parseMoney, extractCheckoutTotal, parseProductCoupons, buildChecks.

import "../helpers/env.js";
import { describe, it, expect } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const mlCoupon = require(path.resolve(__dirname, "..", "..", "backend", "scraping", "ml-coupon.js"));
const { parseMoney, normalizeCode, extractCheckoutTotal, parseProductCoupons, buildChecks, describeTrail, describeStall, describeCouponOpen } = mlCoupon;

describe("parseMoney", () => {
  it("formato brasileiro com milhar e centavos", () => {
    expect(parseMoney("R$ 1.234,56")).toBe(1234.56);
    expect(parseMoney("R$89,90")).toBe(89.9);
    expect(parseMoney("Total R$ 110")).toBe(110);
  });

  it("texto sem dinheiro devolve null", () => {
    expect(parseMoney("Frete grátis")).toBeNull();
    expect(parseMoney("")).toBeNull();
    expect(parseMoney(null)).toBeNull();
  });
});

describe("normalizeCode", () => {
  it("sobe pra maiúscula e tira espaço, como o resto do sistema", () => {
    expect(normalizeCode("  jbl20 ")).toBe("JBL20");
    expect(normalizeCode("")).toBeNull();
    expect(normalizeCode(null)).toBeNull();
  });
});

describe("extractCheckoutTotal", () => {
  it("pega o ÚLTIMO total da tela, não o subtotal do produto", () => {
    const tela = [
      "Resumo da compra",
      "Total do produto R$ 100,00",
      "Frete R$ 10,00",
      "Total a pagar R$ 110,00",
      "Escolha como quer pagar",
    ].join("\n");
    expect(extractCheckoutTotal(tela)).toBe(110);
  });

  it("na tela de pagar o rótulo é \"Você pagará\" e o valor vale como total", () => {
    // Resumo real da tela "Escolha como pagar": ela não escreve "Total".
    const tela = ["Resumo da compra", "Produto", "R$ 135", "Frete", "R$ 24,80 Grátis",
                  "Inserir código do cupom", "Você pagará", "R$ 159,80", "R$ 135",
                  "Você economizou R$ 24,80"].join("\n");
    expect(extractCheckoutTotal(tela)).toBe(135);
  });

  it("com preço riscado ao lado, fica o que se paga e não o de antes", () => {
    expect(extractCheckoutTotal("Você pagará R$ 159,80 R$ 120,00")).toBe(120);
  });

  it("tela sem total devolve null — melhor nada que um número errado", () => {
    expect(extractCheckoutTotal("Escolha a forma de entrega")).toBeNull();
    expect(extractCheckoutTotal("")).toBeNull();
  });
});

describe("parseProductCoupons", () => {
  it("só o que fala de cupom entra, e o tipo sai do texto", () => {
    const achados = parseProductCoupons([
      "Cupom de R$ 20 OFF",
      "Frete grátis",
      "10% OFF com cupom",
      "Aproveite o cupom da loja",
    ]);
    expect(achados).toHaveLength(3);
    expect(achados).toEqual(expect.arrayContaining([
      { label: "Cupom de R$ 20 OFF", kind: "valor", value: 20 },
      { label: "10% OFF com cupom", kind: "percentual", value: 10 },
      { label: "Aproveite o cupom da loja", kind: "desconhecido", value: null },
    ]));
  });

  it("o mesmo cupom repetido na página entra uma vez só", () => {
    const achados = parseProductCoupons(["Cupom de R$ 20 OFF", "Cupom de R$ 20 OFF"]);
    expect(achados).toHaveLength(1);
  });

  // Textos colhidos de uma PDP de verdade (backend/scripts/ml-coupon-dump.js).
  // O mesmo cupom vem três vezes: o elemento com o texto, o pai e o avô — os dois
  // últimos com o texto dos filhos GRUDADO, inclusive comendo o espaço do "R$ 113".
  it("descarta o texto do elemento-pai, que é o do filho grudado", () => {
    const achados = parseProductCoupons([
      "R$ 113 com CupomR$113 com CupomVer cupons disponíveis",
      "R$ 113 com CupomR$113 com Cupom",
      "R$113 com Cupom",
    ]);
    expect(achados).toEqual([{ label: "R$113 com Cupom", kind: "valor", value: 113 }]);
  });

  it("nada de cupom devolve lista vazia", () => {
    expect(parseProductCoupons(["Frete grátis", ""])).toEqual([]);
    expect(parseProductCoupons(null)).toEqual([]);
  });
});

describe("parseProductCoupons — valor irmão do texto", () => {
  it("quando o mais curto é só \"com Cupom\", fica o que tem o valor", () => {
    // Página real do tênis: o <span> do preço com cupom é IRMÃO do "com Cupom",
    // e o bloco de cima gruda a caixa de preço inteira.
    const out = parseProductCoupons([
      "com Cupom",
      "R$ 486,70 23% OFF com Cupom",
      "R$ 635,99 R$ 486,70 23% OFF com Cupom Ver cupons disponíveis",
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe("R$ 486,70 23% OFF com Cupom");
    expect(out[0].kind).toBe("percentual");
    expect(out[0].value).toBe(23);
  });

  it("o mais curto continua ganhando quando ele já tem o valor", () => {
    const out = parseProductCoupons([
      "R$ 113 com Cupom",
      "R$ 113 com CupomR$113 com CupomVer cupons disponíveis",
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe("R$ 113 com Cupom");
  });
});

describe("buildChecks", () => {
  const flowBase = {
    pdpBlocked: { blocked: false },
    title: "Fone JBL",
    finalUrl: "https://produto.mercadolivre.com.br/MLB-1",
    clipped: [],
    checkout: { attempted: false, reached: false, via: null, url: null, fieldFound: false, applied: false },
    totalBefore: null,
    totalAfter: null,
    verdict: null,
  };

  it("no modo leitura só mostra as duas linhas da página do produto", () => {
    const checks = buildChecks(flowBase, { mode: "leitura", code: null });
    expect(checks.map(c => c.key)).toEqual(["pdp", "cupom-na-pagina"]);
    expect(checks[1].value).toBe("nenhum");
  });

  it("no modo checkout mostra o caminho inteiro até o veredito", () => {
    const flow = {
      ...flowBase,
      clipped: [{ label: "Cupom de R$ 20 OFF", kind: "valor", value: 20 }],
      checkout: { attempted: true, reached: true, via: "comprar-agora", url: "https://.../checkout", fieldFound: true, applied: true },
      totalBefore: 110, totalAfter: 90,
      verdict: { ok: true, status: "valido", reason: "O cupom entrou no pedido.", discount: 20 },
    };
    const checks = buildChecks(flow, { mode: "checkout", code: "JBL20" });
    expect(checks.map(c => c.key)).toEqual(["pdp", "cupom-na-pagina", "checkout", "campo-cupom", "total", "veredito"]);
    expect(checks.find(c => c.key === "veredito").ok).toBe(true);
    expect(checks.find(c => c.key === "checkout").value).toBe("via comprar-agora");
  });

  it("veredito que não é 'valido' aparece como pendência, não como sucesso", () => {
    const flow = {
      ...flowBase,
      checkout: { attempted: true, reached: true, via: "comprar-agora", url: "x", fieldFound: true, applied: true },
      verdict: { ok: true, status: "expirado", reason: "Cupom expirado.", discount: null },
    };
    const checks = buildChecks(flow, { mode: "checkout", code: "X" });
    expect(checks.find(c => c.key === "veredito").ok).toBe(false);
  });
});

// A trilha do checkout. Existe porque "parei depois de 4 passo(s)" não disse a
// ninguém onde consertar quando o teste de verdade parou no meio do caminho.
describe("describeTrail", () => {
  it("encadeia as telas por onde passou", () => {
    expect(describeTrail([
      { passo: 1, titulo: "Escolha a forma de entrega" },
      { passo: 2, titulo: "Como você quer pagar?" },
    ])).toBe("Escolha a forma de entrega → Como você quer pagar?");
  });

  it("tela sem título não some da trilha — some do diagnóstico", () => {
    expect(describeTrail([{ passo: 1, titulo: "" }])).toBe("(tela sem título)");
  });

  it("sem trilha devolve vazio, pra quem chama cair no texto reserva", () => {
    expect(describeTrail([])).toBe("");
    expect(describeTrail(null)).toBe("");
  });
});

describe("describeStall", () => {
  it("diz a tela e o motivo quando a escolha do passo não pegou", () => {
    const txt = describeStall({
      steps: 1, motivo: "opcao-nao-marcada",
      trail: [{ passo: 1, titulo: "Escolha a forma de entrega" }],
    });
    expect(txt).toContain("Escolha a forma de entrega");
    expect(txt).toContain("não sabe fazer");
  });

  it("sem botão Continuar explica que dali pra frente só há pagar/confirmar", () => {
    const txt = describeStall({
      steps: 2, motivo: "sem-botao-continuar",
      trail: [{ passo: 2, titulo: "Revise sua compra" }],
    });
    expect(txt).toContain("Revise sua compra");
    expect(txt).toMatch(/nunca clica/i);
  });

  it("tela que não mudou depois do Continuar tem motivo próprio", () => {
    const txt = describeStall({
      steps: 1, motivo: "tela-nao-mudou",
      trail: [{ passo: 1, titulo: "Escolha a forma de entrega", clicou: "Continuar", mudou: false }],
    });
    expect(txt).toContain("Escolha a forma de entrega");
    expect(txt).toMatch(/tela continuou a mesma/i);
    // Não pode ser confundido com "andei N telas": o problema é o oposto disso.
    expect(txt).not.toMatch(/andei/i);
  });

  it("checkout caído do ML não vira \"faltou botão\" — diz o erro e o código", () => {
    const txt = describeStall({
      steps: 2, motivo: "checkout-quebrou",
      trail: [{ passo: 3, titulo: "Ocorreu um problema", erro: "CHS37-BTYRGHDTKEOZ", parou: "checkout-quebrou" }],
    });
    expect(txt).toContain("CHS37-BTYRGHDTKEOZ");
    expect(txt).toMatch(/erro do lado deles/i);
    // O diagnóstico antigo era "não existe botão Continuar" — verdade inútil, que
    // mandava consertar a ferramenta quando o problema é do ML.
    expect(txt).not.toMatch(/pagar\/confirmar/i);
  });

  it("no limite de passos conta quantas telas andou", () => {
    const txt = describeStall({ steps: 6, motivo: "limite-de-passos", trail: [{ passo: 6, titulo: "Pagamento" }] });
    expect(txt).toContain("6 tela(s)");
  });

  it("sem trilha ainda diz alguma coisa útil", () => {
    expect(describeStall({ steps: 0, trail: [], motivo: "" })).toContain("Cheguei no checkout");
  });
});

// Abrir o cupom na tela de pagamento é um passo próprio: no ML ele é uma LINHA que
// leva pra outra tela, não um campo à mostra. As duas falhas se consertam em
// lugares diferentes, então a mensagem precisa distinguir uma da outra.
describe("describeCouponOpen", () => {
  it("cliquei na linha e o campo não veio — diz no que cliquei e onde parei", () => {
    const txt = describeCouponOpen({
      titulo: "Escolha como pagar",
      tentativas: [{ nivel: 0, clicou: "Cupons de desconto", tag: "li" }],
    });
    expect(txt).toContain("Cupons de desconto");
    expect(txt).toContain("Escolha como pagar");
  });

  it("não achei nem onde clicar é outro problema, e outra mensagem", () => {
    const txt = describeCouponOpen({ titulo: "Escolha como pagar", tentativas: [{ nivel: 0, clicou: null, tag: null }] });
    expect(txt).toMatch(/n[ãa]o achei onde clicar/i);
  });

  it("sem nada registrado ainda responde alguma coisa", () => {
    expect(describeCouponOpen(null)).toMatch(/cupom/i);
  });
});
