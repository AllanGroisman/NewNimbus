// As coleções de `ml_coupon_products` e a fronteira entre elas.
//
// Desde a task 22 os produtos de um cupom vêm só da página dele (a vitrine), mas
// nem sempre ela é lida inteira. A coluna `origem` separa:
//
//   vitrine — a lista fechada: a raspagem chegou ao fim.
//   parcial — um pedaço dela (muro, teto de páginas, teto de produtos).
//
// Duas coisas quebram caro aqui e por isso têm teste com banco de verdade:
//
//   1. cada coleção só apaga a SI MESMA. Sem isso, a rodada que só viu um pedaço
//      apagaria a vitrine inteira que a anterior colheu.
//   2. só vitrine conta na hora de dizer "esse produto está FORA".

import { describe, it, expect, beforeEach } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const backendDir = path.resolve(__dirname, "..", "..", "backend");
const coupons = require(path.join(backendDir, "coupons"));
const { productKey } = require(path.join(backendDir, "catalog", "product-key"));
const { coberturaDoProduto, NA_VITRINE, FORA_DA_VITRINE, SEM_VITRINE } =
  require(path.join(backendDir, "coupons", "quick-check.js"));

const CAMPANHA = "9900042";
const AMOSTRA_IDS = ["MLB5456947676", "MLB6210845328", "MLB4075037525", "MLB4105207283"];
const daVitrine = { link: "https://www.mercadolivre.com.br/produto-da-vitrine/p/MLB7770042" };
const doPedaco = { link: "https://www.mercadolivre.com.br/pedaco-da-vitrine/p/MLB7770099" };

const chaveDe = (link) => productKey({ link });
const par = (p) => [{ productKey: chaveDe(p.link), productUrl: p.link }];

async function semearCupom() {
  await coupons.upsertCoupons([{
    campaignId: CAMPANHA, title: "30% OFF TESTE", kind: "percent", value: 30,
    scope: "campaign", activated: false, sampleItemIds: AMOSTRA_IDS,
    expiresAt: new Date(Date.now() + 864e5).toISOString(),
  }]);
}

describe("as miniaturas do card não viram vínculo (task 22)", () => {
  beforeEach(semearCupom);

  it("o cupom guarda os ids, mas não tem produto nenhum", async () => {
    expect((await coupons.getCoupon(CAMPANHA)).sampleItemIds).toEqual(AMOSTRA_IDS);
    const lista = await coupons.couponProducts(CAMPANHA, { page: 1, pageSize: 50 });
    expect(lista.total).toBe(0);
    expect(coupons.replaceCouponSamples).toBeUndefined();
  });

  it("gravar a vitrine não traz as miniaturas junto", async () => {
    await coupons.replaceCouponProducts(CAMPANHA, par(daVitrine));
    const lista = await coupons.couponProducts(CAMPANHA, { page: 1, pageSize: 50 });
    expect(lista.items.map(i => i.origem)).toEqual(["vitrine"]);
  });
});

describe("vitrine inteira × pedaço", () => {
  beforeEach(semearCupom);

  it("pedaço não é vitrine: não carimba, não autoriza 'fora'", async () => {
    await coupons.replaceCouponProducts(CAMPANHA, par(doPedaco), { origem: "parcial" });
    expect(await coupons.hasVitrine(CAMPANHA)).toBe(false);
    expect((await coupons.getCoupon(CAMPANHA)).productsSyncedAt).toBe(null);

    // Quem está no pedaço está coberto...
    expect(await coberturaDoProduto(CAMPANHA, [chaveDe(doPedaco.link)]))
      .toEqual({ cobertura: NA_VITRINE, origem: "parcial" });
    // ...mas quem não está continua sendo "não sei".
    expect((await coberturaDoProduto(CAMPANHA, [chaveDe("https://www.mercadolivre.com.br/x/p/MLB1230009")])).cobertura)
      .toBe(SEM_VITRINE);
  });

  it("vitrine carimba productsSyncedAt e autoriza a resposta fechada", async () => {
    await coupons.replaceCouponProducts(CAMPANHA, par(daVitrine));
    expect((await coupons.getCoupon(CAMPANHA)).productsSyncedAt).not.toBe(null);
    expect(await coupons.hasVitrine(CAMPANHA)).toBe(true);
    const r = await coberturaDoProduto(CAMPANHA, [chaveDe("https://www.mercadolivre.com.br/outro/p/MLB1230001")]);
    expect(r.cobertura).toBe(FORA_DA_VITRINE);
  });

  it("as coleções não se apagam", async () => {
    await coupons.replaceCouponProducts(CAMPANHA, par(doPedaco), { origem: "parcial" });
    await coupons.replaceCouponProducts(CAMPANHA, par(daVitrine), { origem: "vitrine" });

    let lista = await coupons.couponProducts(CAMPANHA, { page: 1, pageSize: 50 });
    const porOrigem = lista.items.reduce((acc, i) => ({ ...acc, [i.origem]: (acc[i.origem] || 0) + 1 }), {});
    expect(porOrigem).toEqual({ parcial: 1, vitrine: 1 });

    // Uma rodada nova que só viu outro pedaço troca o pedaço e não encosta na vitrine.
    const outro = { link: "https://www.mercadolivre.com.br/outro-pedaco/p/MLB7770098" };
    await coupons.replaceCouponProducts(CAMPANHA, par(outro), { origem: "parcial" });
    lista = await coupons.couponProducts(CAMPANHA, { page: 1, pageSize: 50 });
    expect(lista.total).toBe(2);
    expect(await coupons.hasVitrine(CAMPANHA)).toBe(true);
  });

  it("produto que estava no pedaço e apareceu na vitrine é PROMOVIDO, não duplicado", async () => {
    await coupons.replaceCouponProducts(CAMPANHA, par(doPedaco), { origem: "parcial" });
    await coupons.replaceCouponProducts(CAMPANHA, par(doPedaco), { origem: "vitrine" });
    const lista = await coupons.couponProducts(CAMPANHA, { page: 1, pageSize: 50 });
    expect(lista.total).toBe(1);
    expect(await coupons.couponProductOrigem(CAMPANHA, chaveDe(doPedaco.link))).toBe("vitrine");
  });

  it("vitrine que sumiu do cupom é apagada; o pedaço segue", async () => {
    await coupons.replaceCouponProducts(CAMPANHA, par(doPedaco), { origem: "parcial" });
    await coupons.replaceCouponProducts(CAMPANHA, par(daVitrine));
    const r = await coupons.replaceCouponProducts(CAMPANHA, []);
    expect(r.removidos).toBe(1);
    const lista = await coupons.couponProducts(CAMPANHA, { page: 1, pageSize: 50 });
    expect(lista.items.map(i => i.origem)).toEqual(["parcial"]);
  });

  it("o painel separa o que é pedaço do que é vitrine", async () => {
    await coupons.replaceCouponProducts(CAMPANHA, par(doPedaco), { origem: "parcial" });
    await coupons.replaceCouponProducts(CAMPANHA, par(daVitrine));
    const s = await coupons.stats();
    expect(s.vinculos).toBe(2);
    expect(s.parciais).toBe(1);
  });
});

describe("os ids das miniaturas guardados no cupom", () => {
  beforeEach(semearCupom);

  it("uma releitura sem telemetria não apaga os ids que já estavam lá", async () => {
    await coupons.upsertCoupons([{ campaignId: CAMPANHA, title: "30% OFF TESTE", kind: "percent", value: 30 }]);
    expect((await coupons.getCoupon(CAMPANHA)).sampleItemIds).toEqual(AMOSTRA_IDS);
  });

  it("ids novos substituem os antigos", async () => {
    await coupons.upsertCoupons([{ campaignId: CAMPANHA, title: "30% OFF TESTE", sampleItemIds: ["MLB111222333"] }]);
    expect((await coupons.getCoupon(CAMPANHA)).sampleItemIds).toEqual(["MLB111222333"]);
  });
});

// O produto que chegou com o código num grupo do repasse (repasse/coupon-products.js).
// É o vínculo mais fraco: o grupo disse, o ML não confirmou. Nunca rebaixa um mais
// forte, é promovido por quem confirma e não vale contra a vitrine inteira.
describe("o vínculo do repasse", () => {
  beforeEach(semearCupom);

  const doGrupo = { link: "https://www.mercadolivre.com.br/do-grupo/p/MLB7770077" };
  const item = (p) => [{ productKeys: [chaveDe(p.link)], productUrl: p.link }];

  it("entra com origem repasse e responde a cobertura enquanto não há vitrine", async () => {
    const r = await coupons.vincularDoRepasse(CAMPANHA, item(doGrupo));
    expect(r).toMatchObject({ vinculados: 1, novos: 1 });
    expect(await coupons.couponProductOrigem(CAMPANHA, chaveDe(doGrupo.link))).toBe("repasse");
    expect(await coberturaDoProduto(CAMPANHA, [chaveDe(doGrupo.link)]))
      .toEqual({ cobertura: NA_VITRINE, origem: "repasse" });

    // Repetir não duplica nem conta como novo.
    expect(await coupons.vincularDoRepasse(CAMPANHA, item(doGrupo))).toMatchObject({ vinculados: 1, novos: 0 });
  });

  it("não rebaixa um vínculo mais forte", async () => {
    await coupons.replaceCouponProducts(CAMPANHA, par(doGrupo), { origem: "parcial" });
    await coupons.vincularDoRepasse(CAMPANHA, item(doGrupo));
    expect(await coupons.couponProductOrigem(CAMPANHA, chaveDe(doGrupo.link))).toBe("parcial");
  });

  it("a vitrine promove o do repasse, e o checkout também", async () => {
    await coupons.vincularDoRepasse(CAMPANHA, item(doGrupo));
    await coupons.replaceCouponProducts(CAMPANHA, par(doGrupo), { origem: "parcial" });
    expect(await coupons.couponProductOrigem(CAMPANHA, chaveDe(doGrupo.link))).toBe("parcial");

    const outro = { link: "https://www.mercadolivre.com.br/outro-do-grupo/p/MLB7770078" };
    await coupons.vincularDoRepasse(CAMPANHA, item(outro));
    await coupons.vincularPorCheckout({ productKeys: [chaveDe(outro.link)], productUrl: outro.link, cupons: [{ campaignId: CAMPANHA }] });
    expect(await coupons.couponProductOrigem(CAMPANHA, chaveDe(outro.link))).toBe("checkout");
  });

  it("a vitrine inteira raspada, sem o produto, vence o repasse", async () => {
    await coupons.vincularDoRepasse(CAMPANHA, item(doGrupo));
    await coupons.replaceCouponProducts(CAMPANHA, par(daVitrine));
    // O vínculo do grupo continua guardado (a vitrine só apaga a si mesma)...
    expect(await coupons.couponProductOrigem(CAMPANHA, chaveDe(doGrupo.link))).toBe("repasse");
    // ...mas a resposta é a do ML.
    expect((await coberturaDoProduto(CAMPANHA, [chaveDe(doGrupo.link)])).cobertura).toBe(FORA_DA_VITRINE);
  });

  it("'começar por quem não tem nada' não pula campanha que só tem vínculo do repasse", async () => {
    await coupons.vincularDoRepasse(CAMPANHA, item(doGrupo));
    const r = await coupons.couponsSemVitrine({ campaignIds: [CAMPANHA], soSemProdutos: true });
    expect(r.total).toBe(1);
  });
});
