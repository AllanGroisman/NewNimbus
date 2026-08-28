// As três coleções de `ml_coupon_products` e a fronteira entre elas.
//
// Contexto (26/08/2026): a vitrine do cupom (lista.mercadolivre.com.br) está
// atrás de um muro anti-bot, então na maioria dos cupons o sistema NÃO tem a lista
// completa. Tem duas aproximações, e as três convivem na mesma tabela, separadas
// pela coluna `origem`:
//
//   vitrine — a lista fechada, raspada no navegador.
//   landing — a prévia de 3-8 itens da landing de afiliado, sem navegador.
//   amostra — os 4 MLBs que o card do cupom entrega no modelo da aba /cupons.
//
// Duas coisas quebram caro aqui e por isso têm teste com banco de verdade:
//
//   1. cada coleção só apaga a SI MESMA. Sem isso, raspar a vitrine apagaria as
//      amostras, e a rodada seguinte — que quase sempre só consegue as prévias —
//      apagaria a vitrine inteira. As coleções se zerando em looping.
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

const CAMPANHA = "9900042";
const AMOSTRA_IDS = ["MLB5456947676", "MLB6210845328", "MLB4075037525", "MLB4105207283"];
const daVitrine = { link: "https://www.mercadolivre.com.br/produto-da-vitrine/p/MLB7770042" };

const chaveDe = (link) => productKey({ link });
const chaveDaAmostra = (id) => chaveDe(coupons.linkSinteticoML(id));

async function semearCupom() {
  await coupons.upsertCoupons([{
    campaignId: CAMPANHA, title: "30% OFF TESTE", kind: "percent", value: 30,
    scope: "campaign", activated: false, sampleItemIds: AMOSTRA_IDS,
    expiresAt: new Date(Date.now() + 864e5).toISOString(),
  }]);
}

describe("as duas coleções de vínculo", () => {
  beforeEach(semearCupom);

  it("as amostras entram marcadas, com a URL sintética de catálogo", async () => {
    const r = await coupons.replaceCouponSamples(CAMPANHA, AMOSTRA_IDS);
    expect(r.vinculados).toBe(4);

    const lista = await coupons.couponProducts(CAMPANHA, { page: 1, pageSize: 50 });
    expect(lista.total).toBe(4);
    expect(lista.items.every(i => i.origem === "amostra")).toBe(true);
    expect(lista.items.map(i => i.productUrl)).toContain("https://www.mercadolivre.com.br/x/p/MLB5456947676");
  });

  it("amostra NÃO carimba productsSyncedAt — quem carimba é a vitrine", async () => {
    await coupons.replaceCouponSamples(CAMPANHA, AMOSTRA_IDS);
    expect((await coupons.getCoupon(CAMPANHA)).productsSyncedAt).toBe(null);
    expect(await coupons.hasVitrine(CAMPANHA)).toBe(false);

    await coupons.replaceCouponProducts(CAMPANHA, [{ productKey: chaveDe(daVitrine.link), productUrl: daVitrine.link }]);
    expect((await coupons.getCoupon(CAMPANHA)).productsSyncedAt).not.toBe(null);
    expect(await coupons.hasVitrine(CAMPANHA)).toBe(true);
  });

  it("raspar a vitrine não apaga as amostras, e regravar amostras não apaga a vitrine", async () => {
    await coupons.replaceCouponSamples(CAMPANHA, AMOSTRA_IDS);
    await coupons.replaceCouponProducts(CAMPANHA, [{ productKey: chaveDe(daVitrine.link), productUrl: daVitrine.link }]);

    let total = await coupons.couponProducts(CAMPANHA, { page: 1, pageSize: 50 });
    expect(total.total).toBe(5);

    // A rodada seguinte só conseguiu as amostras de novo.
    await coupons.replaceCouponSamples(CAMPANHA, AMOSTRA_IDS);
    total = await coupons.couponProducts(CAMPANHA, { page: 1, pageSize: 50 });
    expect(total.total).toBe(5);
    expect(await coupons.hasVitrine(CAMPANHA)).toBe(true);
  });

  it("produto que estava só na amostra e apareceu na vitrine é PROMOVIDO, não duplicado", async () => {
    await coupons.replaceCouponSamples(CAMPANHA, AMOSTRA_IDS);
    const link = coupons.linkSinteticoML(AMOSTRA_IDS[0]);
    await coupons.replaceCouponProducts(CAMPANHA, [{ productKey: chaveDe(link), productUrl: link }]);

    const lista = await coupons.couponProducts(CAMPANHA, { page: 1, pageSize: 50 });
    // 3 amostras que sobraram + 1 promovida. A promovida não vira linha nova: a
    // chave é a mesma, e é por isso que a URL sintética tem que ser idêntica dos
    // dois lados.
    expect(lista.total).toBe(4);
    expect(await coupons.couponProductOrigem(CAMPANHA, chaveDe(link))).toBe("vitrine");
    expect(lista.items.filter(i => i.origem === "amostra")).toHaveLength(3);
  });

  it("vitrine que sumiu do cupom é apagada; as amostras seguem", async () => {
    await coupons.replaceCouponSamples(CAMPANHA, AMOSTRA_IDS);
    await coupons.replaceCouponProducts(CAMPANHA, [{ productKey: chaveDe(daVitrine.link), productUrl: daVitrine.link }]);

    const r = await coupons.replaceCouponProducts(CAMPANHA, []);
    expect(r.removidos).toBe(1);
    const lista = await coupons.couponProducts(CAMPANHA, { page: 1, pageSize: 50 });
    expect(lista.total).toBe(4);
    expect(lista.items.every(i => i.origem === "amostra")).toBe(true);
  });
});

describe("a cobertura vista pelo caminho rápido", () => {
  const { coberturaDoProduto, NA_VITRINE, FORA_DA_VITRINE, SEM_VITRINE } =
    require(path.join(backendDir, "coupons", "quick-check.js"));

  beforeEach(semearCupom);

  it("produto que está na amostra: coberto, e a tela sabe que foi por amostra", async () => {
    await coupons.replaceCouponSamples(CAMPANHA, AMOSTRA_IDS);
    const r = await coberturaDoProduto(CAMPANHA, [chaveDaAmostra(AMOSTRA_IDS[1])]);
    expect(r).toEqual({ cobertura: NA_VITRINE, origem: "amostra" });
  });

  it("o erro caro: produto fora das 4 amostras é 'não sei', não 'não vale'", async () => {
    await coupons.replaceCouponSamples(CAMPANHA, AMOSTRA_IDS);
    const r = await coberturaDoProduto(CAMPANHA, [chaveDe("https://www.mercadolivre.com.br/outro/p/MLB1230001")]);
    expect(r.cobertura).toBe(SEM_VITRINE);
  });

  it("com a vitrine raspada, o mesmo produto passa a ter resposta fechada", async () => {
    await coupons.replaceCouponSamples(CAMPANHA, AMOSTRA_IDS);
    await coupons.replaceCouponProducts(CAMPANHA, [{ productKey: chaveDe(daVitrine.link), productUrl: daVitrine.link }]);
    const r = await coberturaDoProduto(CAMPANHA, [chaveDe("https://www.mercadolivre.com.br/outro/p/MLB1230001")]);
    expect(r.cobertura).toBe(FORA_DA_VITRINE);
  });
});

describe("os ids da amostra guardados no cupom", () => {
  beforeEach(semearCupom);

  it("uma releitura sem telemetria não apaga a amostra que já estava lá", async () => {
    expect((await coupons.getCoupon(CAMPANHA)).sampleItemIds).toEqual(AMOSTRA_IDS);

    // O mesmo cupom chegando por um caminho que não leu o bloco de telemetria
    // (uma busca por campanha, um dump parcial). Lista vazia é "não sei".
    await coupons.upsertCoupons([{ campaignId: CAMPANHA, title: "30% OFF TESTE", kind: "percent", value: 30 }]);
    expect((await coupons.getCoupon(CAMPANHA)).sampleItemIds).toEqual(AMOSTRA_IDS);
  });

  it("uma amostra nova substitui a antiga", async () => {
    await coupons.upsertCoupons([{ campaignId: CAMPANHA, title: "30% OFF TESTE", sampleItemIds: ["MLB111222333"] }]);
    expect((await coupons.getCoupon(CAMPANHA)).sampleItemIds).toEqual(["MLB111222333"]);
  });
});

describe("a prévia da landing convive com as outras duas", () => {
  const daLanding = { link: "https://www.mercadolivre.com.br/previa-da-landing/p/MLB7770099" };

  beforeEach(semearCupom);

  it("prévia não é vitrine: não carimba, não autoriza 'fora'", async () => {
    await coupons.replaceCouponProducts(
      CAMPANHA,
      [{ productKey: chaveDe(daLanding.link), productUrl: daLanding.link }],
      { origem: "landing" },
    );
    expect(await coupons.hasVitrine(CAMPANHA)).toBe(false);
    expect((await coupons.getCoupon(CAMPANHA)).productsSyncedAt).toBe(null);

    const { coberturaDoProduto, SEM_VITRINE, NA_VITRINE } =
      require(path.join(backendDir, "coupons", "quick-check.js"));
    // Quem está na prévia está coberto...
    expect(await coberturaDoProduto(CAMPANHA, [chaveDe(daLanding.link)]))
      .toEqual({ cobertura: NA_VITRINE, origem: "landing" });
    // ...mas quem não está continua sendo "não sei", porque a prévia é de 3 a 8
    // itens de uma vitrine que pode ter 50.
    expect((await coberturaDoProduto(CAMPANHA, [chaveDe("https://www.mercadolivre.com.br/x/p/MLB1230009")])).cobertura)
      .toBe(SEM_VITRINE);
  });

  it("as três coleções não se apagam", async () => {
    await coupons.replaceCouponSamples(CAMPANHA, AMOSTRA_IDS);
    await coupons.replaceCouponProducts(CAMPANHA, [{ productKey: chaveDe(daLanding.link), productUrl: daLanding.link }], { origem: "landing" });
    await coupons.replaceCouponProducts(CAMPANHA, [{ productKey: chaveDe(daVitrine.link), productUrl: daVitrine.link }], { origem: "vitrine" });

    const lista = await coupons.couponProducts(CAMPANHA, { page: 1, pageSize: 50 });
    expect(lista.total).toBe(6);
    const porOrigem = lista.items.reduce((acc, i) => ({ ...acc, [i.origem]: (acc[i.origem] || 0) + 1 }), {});
    expect(porOrigem).toEqual({ amostra: 4, landing: 1, vitrine: 1 });

    // Uma rodada nova em que só a landing respondeu troca a prévia e não encosta
    // no resto.
    await coupons.replaceCouponProducts(CAMPANHA, [{ productKey: chaveDe("https://www.mercadolivre.com.br/outra-previa/p/MLB7770098"), productUrl: "https://www.mercadolivre.com.br/outra-previa/p/MLB7770098" }], { origem: "landing" });
    const depois = await coupons.couponProducts(CAMPANHA, { page: 1, pageSize: 50 });
    expect(depois.total).toBe(6);
    expect(await coupons.hasVitrine(CAMPANHA)).toBe(true);
  });

  it("o painel separa o que é prévia do que é vitrine", async () => {
    await coupons.replaceCouponSamples(CAMPANHA, AMOSTRA_IDS);
    await coupons.replaceCouponProducts(CAMPANHA, [{ productKey: chaveDe(daVitrine.link), productUrl: daVitrine.link }], { origem: "vitrine" });
    const s = await coupons.stats();
    expect(s.vinculos).toBe(5);
    expect(s.parciais).toBe(4);
  });
});
