// A vitrine que chega do agente local, gravada de verdade.
//
// O que se protege aqui é a fronteira entre as duas naturezas de dado que
// convivem em `ml_coupon_products` (ver integration/coupons-amostra.test.js):
//
//   origem "vitrine" — a lista FECHADA. É a única que autoriza o sistema a dizer
//                      "esse cupom não cobre seu produto".
//   origem "landing" — prova positiva, pedaço. Nunca conclui um "não".
//
// A extensão (`extension/`) para quando o Mercado Livre pede verificação, e nesse
// caso ela viu um PEDAÇO da vitrine. Se esse pedaço entrasse
// como lista fechada, o teste de cupom passaria a responder "não vale aqui" para
// cupom que vale — que é exatamente o prejuízo que a ferramenta existe pra evitar.
import { describe, it, expect, beforeEach } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const backendDir = path.resolve(__dirname, "..", "..", "backend");
const coupons = require(path.join(backendDir, "coupons"));
const sync = require(path.join(backendDir, "coupons", "sync.js"));

const CAMPANHA = "9900077";
const produto = (n) => ({
  name: `Produto ${n}`,
  link: `https://www.mercadolivre.com.br/produto-${n}/p/MLB770007${n}`,
  price: 100 + n,
  img: "https://http2.mlstatic.com/D_NQ_NP_1.webp",
});

async function semearCupom() {
  await coupons.upsertCoupons([{
    campaignId: CAMPANHA, title: "20% OFF AGENTE", kind: "percent", value: 20,
    scope: "campaign", activated: true, sampleItemIds: [],
    containerUrl: "https://lista.mercadolivre.com.br/_Container_teste?coupon_campaign_id=9900077",
    expiresAt: new Date(Date.now() + 864e5).toISOString(),
  }]);
}

describe("gravarVitrineLocal", () => {
  beforeEach(semearCupom);

  it("a vitrine inteira entra como lista fechada e o catálogo recebe os produtos", async () => {
    const r = await sync.gravarVitrineLocal(CAMPANHA, [produto(1), produto(2), produto(3)], { parcial: false });

    expect(r.ok).toBe(true);
    expect(r.produtos).toBe(3);
    expect(r.parcial).toBe(false);

    const lista = await coupons.couponProducts(CAMPANHA, { page: 1, pageSize: 50 });
    expect(lista.total).toBe(3);
    expect(lista.items.every(i => i.origem === "vitrine")).toBe(true);
    // É o carimbo que faz o quick-check poder responder "fora-da-vitrine".
    expect(await coupons.hasVitrine(CAMPANHA)).toBe(true);
  });

  it("parcial NÃO vira lista fechada — o agente parou no muro, viu um pedaço", async () => {
    const r = await sync.gravarVitrineLocal(CAMPANHA, [produto(1), produto(2)], { parcial: true });

    expect(r.parcial).toBe(true);
    const lista = await coupons.couponProducts(CAMPANHA, { page: 1, pageSize: 50 });
    expect(lista.items.every(i => i.origem === "landing")).toBe(true);
    expect(await coupons.hasVitrine(CAMPANHA)).toBe(false);
  });

  it("conta os descartados em vez de recusar o lote inteiro", async () => {
    const r = await sync.gravarVitrineLocal(CAMPANHA, [
      produto(1),
      { ...produto(2), link: "https://exemplo.com/produto" },
      { ...produto(3), price: null },
    ], { parcial: false });

    expect(r.produtos).toBe(1);
    expect(r.descartados).toBe(2);
  });

  it("campanha que não está no sistema é recusada — vínculo órfão não se grava", async () => {
    await expect(sync.gravarVitrineLocal("0000000", [produto(1)], { parcial: false }))
      .rejects.toThrow(/não está no sistema/i);
  });

  it("a vitrine nova substitui a anterior, e as amostras do card seguem", async () => {
    await coupons.replaceCouponSamples(CAMPANHA, ["MLB1111111111"]);
    await sync.gravarVitrineLocal(CAMPANHA, [produto(1), produto(2)], { parcial: false });
    await sync.gravarVitrineLocal(CAMPANHA, [produto(9)], { parcial: false });

    const lista = await coupons.couponProducts(CAMPANHA, { page: 1, pageSize: 50 });
    expect(lista.items.filter(i => i.origem === "vitrine")).toHaveLength(1);
    expect(lista.items.filter(i => i.origem === "amostra")).toHaveLength(1);
  });
});

// A configuração da ativação automática. Vive aqui (e não nos unitários) porque
// `writeConfig` escreve na tabela de config.
//
// O que se protege: o teto de ativações. Ele é o freio que impede a rodada de
// disparar dezenas de cliques de "Eu quero" em sequência na conta do ML — e a
// conta é a MESMA do Hub de Afiliados, então verificação ali derruba os dois.
describe("config da ativação automática", () => {
  it("prende o teto na faixa e trunca decimal", async () => {
    expect((await sync.writeConfig({ maxActivationsPerRun: 999 })).maxActivationsPerRun).toBe(100);
    expect((await sync.writeConfig({ maxActivationsPerRun: -5 })).maxActivationsPerRun).toBe(0);
    expect((await sync.writeConfig({ maxActivationsPerRun: 7.9 })).maxActivationsPerRun).toBe(7);
  });

  it("zero é valor legítimo: ligado, mas nenhum nesta rodada", async () => {
    expect((await sync.writeConfig({ maxActivationsPerRun: 0 })).maxActivationsPerRun).toBe(0);
  });

  it("lixo no campo cai no padrão em vez de virar NaN", async () => {
    // `Number(undefined)` é NaN, e NaN não é pego por `??` — sem a rede explícita
    // isso viraria "ativar nenhum" em silêncio.
    expect((await sync.writeConfig({ maxActivationsPerRun: "abc" })).maxActivationsPerRun).toBe(20);
  });

  it('"false" em texto desliga a ativação — o erro clássico do body cru', async () => {
    expect((await sync.writeConfig({ activateCoupons: "false" })).activateCoupons).toBe(false);
    expect((await sync.writeConfig({ activateCoupons: "true" })).activateCoupons).toBe(true);
    expect((await sync.writeConfig({ activateCoupons: false })).activateCoupons).toBe(false);
  });
});
