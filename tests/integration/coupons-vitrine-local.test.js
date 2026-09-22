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
const { productKey } = require(path.join(backendDir, "catalog", "product-key.js"));
const { prisma } = require(path.join(backendDir, "db.js"));

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
    expect((await sync.writeConfig({ maxActivationsPerRun: 999 })).maxActivationsPerRun).toBe(500);
    expect((await sync.writeConfig({ maxActivationsPerRun: -5 })).maxActivationsPerRun).toBe(0);
    expect((await sync.writeConfig({ maxActivationsPerRun: 7.9 })).maxActivationsPerRun).toBe(7);
  });

  // A troca de semântica do "buscar TUDO": `0` era "ligado, mas nenhum" e virou
  // "sem teto". Os dois knobs passaram a ser ortogonais — `activateCoupons` liga e
  // desliga, este limita —, e é justamente por serem opostos que os dois casos
  // ficam testados lado a lado: um 0 lido como "nenhum" deixaria a fila inteira
  // sem vitrine, e lido como "sem teto" quando devia ser "nenhum" dispararia
  // centenas de cliques na conta do Hub.
  it("zero é SEM TETO: ativa todos os alvos da rodada", async () => {
    await sync.writeConfig({ activateCoupons: true, maxActivationsPerRun: 0 });
    const r = sync.startLocalRun({ ativarApenas: ["1", "2", "3"] });
    try {
      expect(r.ativa).toBe(true);
      // `Infinity` não sobrevive ao JSON, então quem sai daqui é `null` — a tela
      // lê "null = sem teto" em vez de mostrar "restam null".
      expect(sync.ativacoesLocais({ props: null }).restantes).toBe(null);
    } finally {
      sync.fimLocalRun({ cancelada: true });
    }
  });

  it("quem desliga a ativação é o activateCoupons, e ele continua desligando", async () => {
    await sync.writeConfig({ activateCoupons: false, maxActivationsPerRun: 0 });
    const r = sync.startLocalRun({ ativarApenas: ["1", "2", "3"] });
    try {
      expect(r.ativa).toBe(false);
      expect(sync.ativacoesLocais({ props: null })).toEqual({ labels: [], restantes: 0 });
    } finally {
      sync.fimLocalRun({ cancelada: true });
    }
  });

  it("lixo no campo cai no padrão em vez de virar NaN", async () => {
    // `Number(undefined)` é NaN, e NaN não é pego por `??` — sem a rede explícita
    // isso viraria um teto que ninguém pediu.
    expect((await sync.writeConfig({ maxActivationsPerRun: "abc" })).maxActivationsPerRun)
      .toBe(0);
  });

  // O botão 3 solta o teto de páginas da lista geral. O flag é do SERVIDOR: a tela
  // manda `tudo: true`, não um número — `startLocalRun` espalha os overrides por
  // cima da config sem passar pelos clamps do `writeConfig`.
  it("tudo: true solta os três tetos da lista geral", async () => {
    await sync.writeConfig({ maxPaginasLista: 3, maxPaginasPorCategoria: 4, limiteCupons: 50 });
    const normal = sync.startLocalRun({});
    expect(normal.config.maxPaginasLista).toBe(3);
    expect(normal.config.maxPaginasPorCategoria).toBe(4);
    expect(normal.config.limiteCupons).toBe(50);
    sync.fimLocalRun({ cancelada: true });

    // `Infinity`, e não 200: 200 × 30 = 6.000 cupons é um teto disfarçado de "sem
    // teto", e a conta pode ter mais. Quem encerra passa a ser o `pages` que o
    // próprio ML declara. Os outros dois tetos saem junto — antes só o de páginas
    // saía, e os outros seguravam a mesma promessa por baixo (task 20).
    const tudo = sync.startLocalRun({ tudo: true });
    expect(tudo.config.maxPaginasLista).toBe(Infinity);
    expect(tudo.config.maxPaginasPorCategoria).toBe(Infinity);
    expect(tudo.config.limiteCupons).toBe(0);
    sync.fimLocalRun({ cancelada: true });

    // E não fica gravado: é override de UMA rodada, não uma mudança de config.
    expect(sync.readConfig().maxPaginasLista).toBe(3);
    expect(sync.readConfig().maxPaginasPorCategoria).toBe(4);
    expect(sync.readConfig().limiteCupons).toBe(50);
  });

  it("os ciclos do buscar TUDO têm freio próprio", async () => {
    expect((await sync.writeConfig({ pausaEntreCiclosMs: 1 })).pausaEntreCiclosMs).toBe(5000);
    expect((await sync.writeConfig({ maxCiclos: 9999 })).maxCiclos).toBe(200);
  });

  it('"false" em texto desliga a ativação — o erro clássico do body cru', async () => {
    expect((await sync.writeConfig({ activateCoupons: "false" })).activateCoupons).toBe(false);
    expect((await sync.writeConfig({ activateCoupons: "true" })).activateCoupons).toBe(true);
    expect((await sync.writeConfig({ activateCoupons: false })).activateCoupons).toBe(false);
  });
});

// Task 14: a etapa 2 grava as vitrines em paralelo com `carimbar: false` e carimba
// o catálogo uma vez por lote — o `syncCatalogCoupons` varre a tabela inteira.
describe("carimbo adiado da etapa 2", () => {
  beforeEach(semearCupom);
  const cupomDoProduto = async (n) =>
    (await prisma().catalogProduct.findUnique({ where: { key: productKey(produto(n)) } }))?.couponCampaignId ?? null;

  it("carimbar: false grava o vínculo sem carimbar; carimbarCatalogo() carimba", async () => {
    const r = await sync.gravarVitrineLocal(CAMPANHA, [produto(1), produto(2)], { parcial: false, carimbar: false });
    expect(r.ok).toBe(true);
    expect(await cupomDoProduto(1)).toBeNull();

    const c = await sync.carimbarCatalogo();
    expect(c.carimbados).toBeGreaterThanOrEqual(2);
    expect(await cupomDoProduto(1)).toBe(CAMPANHA);
  });

  it("sem o flag continua carimbando na hora (o botão de uma linha)", async () => {
    await sync.gravarVitrineLocal(CAMPANHA, [produto(3)], { parcial: false });
    expect(await cupomDoProduto(3)).toBe(CAMPANHA);
  });
});

describe("vitrines em paralelo na config", () => {
  it("fica entre 1 e 4, e o /alvos-produtos entrega o número à tela", async () => {
    expect((await sync.writeConfig({ vitrinesEmParalelo: 10 })).vitrinesEmParalelo).toBe(4);
    expect((await sync.writeConfig({ vitrinesEmParalelo: 0 })).vitrinesEmParalelo).toBe(1);
    expect((await sync.writeConfig({ vitrinesEmParalelo: "abc" })).vitrinesEmParalelo).toBe(sync.DEFAULT_CONFIG.vitrinesEmParalelo);
    await sync.writeConfig({ vitrinesEmParalelo: 3 });
    expect((await sync.alvosDeProdutos()).config.vitrinesEmParalelo).toBe(3);
  });
});
