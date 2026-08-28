// A decisão do caminho rápido do teste de cupom (backend/coupons/quick-check.js).
//
// `decide` é puro: recebe o que o ML disse da palavra, a linha do cupom, onde o
// produto está em relação à vitrine e o preço — e devolve o veredito.
//
// O que está sendo protegido aqui é o `conclui: false`. Ele é o que manda o teste
// seguir para o checkout em vez de inventar resposta, e o erro caro é justamente
// o oposto: transformar FALTA DE DADO ("a vitrine desse cupom nunca foi raspada")
// em veredito negativo. Isso descartaria cupom bom antes de ele chegar ao grupo,
// que é exatamente o prejuízo que a ferramenta existe pra evitar.

import { describe, it, expect } from "vitest";
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { decide, chavesCandidatas, NA_VITRINE, FORA_DA_VITRINE, SEM_VITRINE } =
  require(path.resolve(__dirname, "..", "..", "backend", "coupons", "quick-check.js"));
const { productKey } = require(path.resolve(__dirname, "..", "..", "backend", "catalog", "product-key.js"));

const daqui = min => new Date(Date.now() + min * 60000).toISOString();
const valido = extra => ({ verdict: "valid", campaignId: "123", responseCode: null, message: null, ...extra });
const cupom10 = { campaignId: "123", title: "10% OFF", kind: "percent", value: 10 };

describe("decide — o que o ML disse da palavra", () => {
  it("palavra que o ML não reconhece é resposta fechada", () => {
    const r = decide({ check: { verdict: "invalid", message: "Confira se o cupom está correto" } });
    expect(r.conclui).toBe(true);
    expect(r.status).toBe("invalido");
    expect(r.reason).toContain("Confira");
  });

  it("engasgo do ML não é veredito sobre a palavra", () => {
    const r = decide({ check: { verdict: "indeterminado", message: "Tivemos um problema" } });
    expect(r.conclui).toBe(false);
    expect(r.status).toBe("indeterminado");
    expect(r.reason).toContain("não chegou a avaliar");
  });

  it("sem resposta nenhuma do ML, não conclui", () => {
    expect(decide({ check: null }).conclui).toBe(false);
  });
});

describe("decide — cupom que existe mas não serve", () => {
  it("EXPIRED_ACTION do ML vale mesmo com a linha do banco parecendo viva", () => {
    const r = decide({
      check: valido({ responseCode: "EXPIRED_ACTION", message: "O cupom venceu em 19 de agosto." }),
      cupom: { ...cupom10, expiresAt: daqui(60) },
      cobertura: NA_VITRINE, preco: 200,
    });
    expect(r.conclui).toBe(true);
    expect(r.status).toBe("expirado");
  });

  it("data vencida no banco basta, mesmo sem response_code", () => {
    const r = decide({
      check: valido(), cupom: { ...cupom10, expiresAt: daqui(-60) },
      cobertura: NA_VITRINE, preco: 200,
    });
    expect(r.status).toBe("expirado");
  });

  it("SOLD_OUT vira 'usado'", () => {
    const r = decide({ check: valido({ responseCode: "SOLD_OUT" }), cupom: cupom10, cobertura: NA_VITRINE, preco: 200 });
    expect(r.conclui).toBe(true);
    expect(r.status).toBe("usado");
  });
});

describe("decide — a vitrine", () => {
  it("produto na vitrine + regra do cupom = veredito com desconto", () => {
    const r = decide({ check: valido(), cupom: cupom10, cobertura: NA_VITRINE, preco: 200 });
    expect(r.conclui).toBe(true);
    expect(r.status).toBe("valido");
    expect(r.priceAfter).toBe(180);
    expect(r.discount).toBe(20);
  });

  it("vitrine raspada e produto fora dela é resposta fechada", () => {
    const r = decide({ check: valido(), cupom: cupom10, cobertura: FORA_DA_VITRINE, preco: 200 });
    expect(r.conclui).toBe(true);
    expect(r.status).toBe("nao-aplicavel");
  });

  // O caso que não pode quebrar nunca: sem vitrine raspada o sistema NÃO SABE.
  // Responder "não vale pra este produto" aqui é inventar, e é o veredito que
  // manda um cupom bom para o lixo.
  it("vitrine nunca raspada NÃO conclui — e nunca vira 'nao-aplicavel'", () => {
    const r = decide({ check: valido(), cupom: cupom10, cobertura: SEM_VITRINE, preco: 200 });
    expect(r.conclui).toBe(false);
    expect(r.status).not.toBe("nao-aplicavel");
    expect(r.reason).toContain("nunca foi raspada");
  });

  it("campanha que o ML reconhece mas o sistema não tem não conclui", () => {
    const r = decide({ check: valido(), cupom: null, cobertura: SEM_VITRINE, preco: 200 });
    expect(r.conclui).toBe(false);
    expect(r.reason).toContain("ainda não está no sistema");
  });
});

describe("decide — a conta do desconto", () => {
  it("compra mínima não atingida é resposta fechada e explicada", () => {
    const r = decide({
      check: valido(), cupom: { ...cupom10, minPurchase: 300 },
      cobertura: NA_VITRINE, preco: 200,
    });
    expect(r.conclui).toBe(true);
    expect(r.status).toBe("minimo-nao-atingido");
    expect(r.reason).toContain("R$ 300,00");
  });

  it("teto do cupom entra na conta", () => {
    const r = decide({
      check: valido(), cupom: { ...cupom10, value: 50, maxDiscount: 30 },
      cobertura: NA_VITRINE, preco: 200,
    });
    expect(r.priceAfter).toBe(170);
    expect(r.discount).toBe(30);
  });

  // O preço diz QUANTO, não SE. Quem responde "esse cupom vale neste produto?" é
  // a vitrine — segurar o veredito por falta de preço faria a ferramenta calar
  // justamente no caso que ela existe pra responder.
  it("sem preço o veredito sai assim mesmo, só sem o valor", () => {
    const r = decide({ check: valido(), cupom: cupom10, cobertura: NA_VITRINE, preco: null });
    expect(r.conclui).toBe(true);
    expect(r.status).toBe("valido");
    expect(r.discount).toBeNull();
    expect(r.reason).toContain("não sei dizer quanto fica");
  });

  // A exceção: com compra mínima o preço deixa de ser detalhe e vira parte da
  // regra do cupom — sem ele não dá pra saber se o cupom pega.
  it("com compra mínima e sem preço, não conclui", () => {
    const r = decide({
      check: valido(), cupom: { ...cupom10, minPurchase: 300 },
      cobertura: NA_VITRINE, preco: null,
    });
    expect(r.conclui).toBe(false);
    expect(r.reason).toContain("R$ 300,00");
  });

  it("regra que não dá pra calcular ainda assim confirma que o cupom cobre", () => {
    const r = decide({
      check: valido(), cupom: { ...cupom10, kind: "unknown", value: 10 },
      cobertura: NA_VITRINE, preco: 200,
    });
    expect(r.conclui).toBe(true);
    expect(r.status).toBe("valido");
    expect(r.discount).toBeNull();
  });
});

// O ML numera o mesmo produto de três jeitos e o `productKey` não funde eles:
// `/p/MLB…` (catálogo), `/up/MLBU…` (agrupamento de variações) e `MLB-…`
// (anúncio). A vitrine do cupom é raspada em `/p/MLB…`, então um link `/up/…` —
// que é o que sai do perfil de afiliado — dava "sem vitrine" mesmo com o produto
// listado no cupom. As pistas do anúncio real vêm na query.
describe("chavesCandidatas", () => {
  it("um link /up/ também responde pela chave do anúncio que ele filtra", () => {
    const chaves = chavesCandidatas(
      "https://www.mercadolivre.com.br/tenis-x/up/MLBU4592952086?pdp_filters=item_id%3AMLB7330057970"
    );
    expect(chaves).toContain(productKey({ link: "https://www.mercadolivre.com.br/x/p/MLB7330057970" }));
    expect(chaves.length).toBeGreaterThan(1);
  });

  it("o wid serve de pista do mesmo jeito", () => {
    const chaves = chavesCandidatas("https://www.mercadolivre.com.br/tenis-x/up/MLBU1?wid=MLB7330057970");
    expect(chaves).toContain(productKey({ link: "https://www.mercadolivre.com.br/x/p/MLB7330057970" }));
  });

  it("link comum devolve uma chave só, e é a do próprio link", () => {
    const url = "https://www.mercadolivre.com.br/x/p/MLB62933980";
    expect(chavesCandidatas(url)).toEqual([productKey({ link: url })]);
  });

  it("lixo não vira chave", () => {
    expect(chavesCandidatas("nao-e-url")).toEqual([productKey({ link: "nao-e-url" })]);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Amostra × vitrine
// ────────────────────────────────────────────────────────────────────────
//
// Desde 26/08/2026 existem DOIS tipos de vínculo em `ml_coupon_products`: a
// vitrine raspada (a lista completa do cupom) e a amostra — as 4 miniaturas que
// o card do cupom mostra, que o ML entrega de graça no modelo da aba /cupons.
//
// A regra que estes testes seguram: amostra prova que o produto ESTÁ coberto,
// mas NUNCA que ele está fora. Contar amostra como vitrine faria 4 produtos que
// não casam virarem "esse cupom não vale aqui" — o mesmo prejuízo de tratar
// sem-vitrine como fora-da-vitrine, só por outra porta.
const pg = require(path.resolve(__dirname, "..", "..", "backend", "coupons", "pg.js"));
const { coberturaDoProduto } = require(path.resolve(__dirname, "..", "..", "backend", "coupons", "quick-check.js"));

// O quick-check guarda a referência do módulo pg, então trocar as funções nele
// basta — sem banco, sem mock de import.
function comBanco({ origem = null, temVitrine = false }, fn) {
  const orig = { couponProductOrigem: pg.couponProductOrigem, hasVitrine: pg.hasVitrine };
  pg.couponProductOrigem = async () => origem;
  pg.hasVitrine = async () => temVitrine;
  return Promise.resolve(fn()).finally(() => Object.assign(pg, orig));
}

describe("a URL sintética da amostra casa com a chave do produto", () => {
  // O ML dá só o id na amostra, sem URL de anúncio. A chave sai de uma URL
  // montada — e ela tem que ser a MESMA que o chavesCandidatas monta do outro
  // lado, senão o hash sai diferente e o vínculo nunca casa com nada.
  it("a chave da amostra é uma das chaves candidatas do link do produto", () => {
    const chaveDaAmostra = productKey({ link: pg.linkSinteticoML("MLB5456947676") });
    const doLink = chavesCandidatas(
      "https://www.mercadolivre.com.br/produto/up/MLBU3344556?pdp_filters=item_id:MLB5456947676",
    );
    expect(doLink).toContain(chaveDaAmostra);
  });

  it("id que não é MLB não vira link (e portanto não vira vínculo)", () => {
    expect(pg.linkSinteticoML("lixo")).toBe(null);
    expect(pg.linkSinteticoML(null)).toBe(null);
  });
});

describe("coberturaDoProduto — o peso de cada vínculo", () => {
  it("vínculo de amostra que casa é resposta: está na vitrine", async () => {
    await comBanco({ origem: "amostra" }, async () => {
      expect(await coberturaDoProduto("123", ["k1"])).toEqual({ cobertura: NA_VITRINE, origem: "amostra" });
    });
  });

  it("vínculo de vitrine que casa também, e diz de onde veio", async () => {
    await comBanco({ origem: "vitrine" }, async () => {
      expect(await coberturaDoProduto("123", ["k1"])).toEqual({ cobertura: NA_VITRINE, origem: "vitrine" });
    });
  });

  it("O ERRO CARO: só amostras guardadas e nenhuma casa ⇒ não sei, nunca 'fora'", async () => {
    await comBanco({ origem: null, temVitrine: false }, async () => {
      const r = await coberturaDoProduto("123", ["k1"]);
      expect(r.cobertura).toBe(SEM_VITRINE);
      expect(r.cobertura).not.toBe(FORA_DA_VITRINE);
    });
  });

  it("com a vitrine raspada, nenhuma chave casar é resposta fechada", async () => {
    await comBanco({ origem: null, temVitrine: true }, async () => {
      expect((await coberturaDoProduto("123", ["k1"])).cobertura).toBe(FORA_DA_VITRINE);
    });
  });

  it("sem campanha ou sem chave não se pergunta ao banco", async () => {
    expect(await coberturaDoProduto(null, ["k1"])).toEqual({ cobertura: SEM_VITRINE, origem: null });
    expect(await coberturaDoProduto("123", [])).toEqual({ cobertura: SEM_VITRINE, origem: null });
  });
});
