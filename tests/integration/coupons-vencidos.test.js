// Tasks 8, 9 e 10 da aba "Cupons do ML":
//
//   8 — a vitrine que abriu sem card nenhum fica gravada, conta à parte do "sem
//       nenhum produto" e sai das duas filas do botão 2 (o botão da linha ainda tenta);
//   9 — "Apagar vencidos" leva os cupons vencidos e os produtos que vieram SÓ pela
//       vitrine deles;
//  10 — "apagar produtos" de um cupom leva os produtos da vitrine dele, e o cupom
//       volta para a fila.
//
// O cuidado que estes testes protegem é o das tasks 9 e 10: produto que tem outra
// origem — o scraping, o repasse, o checkout, a vitrine de um cupom que ainda vale —
// NÃO sai do catálogo. É a coluna `catalog_products.soDaVitrine` que diz quem nasceu
// da vitrine, e qualquer outra fonte a derruba.
import { describe, it, expect, beforeEach } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { catalog, prisma, createTestUser, auth as authMod } from "../helpers/app.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const backendDir = path.resolve(__dirname, "..", "..", "backend");
const coupons = require(path.join(backendDir, "coupons"));
const sync = require(path.join(backendDir, "coupons", "sync.js"));

const AMANHA = () => new Date(Date.now() + 864e5).toISOString();
const ONTEM = () => new Date(Date.now() - 864e5).toISOString();

const VENCIDO = "9930001";
const VENCIDO_2 = "9930002";
const VALIDO = "9930003";

const cupom = (campaignId, expiresAt, extra = {}) => ({
  campaignId, title: `Cupom ${campaignId}`, kind: "percent", value: 10, scope: "campaign",
  activated: true, containerUrl: `https://lista.mercadolivre.com.br/_Container_${campaignId}`, expiresAt, ...extra,
});

const produto = (n) => ({
  name: `Produto ${n}`, link: `https://www.mercadolivre.com.br/p/MLB993${String(n).padStart(4, "0")}`,
  price: 10 + n, store: "Mercado Livre",
});
// O mesmo produto chegando pelo scraping, que sempre carimba a categoria.
const raspado = (n) => ({ ...produto(n), category: "gamer" });

const linha = (p) => prisma().catalogProduct.findFirst({
  where: { link: p.link }, select: { key: true, soDaVitrine: true, couponCampaignId: true },
});
const existe = async (p) => !!(await linha(p));

describe("a origem do produto no catálogo", () => {
  beforeEach(() => coupons.upsertCoupons([cupom(VALIDO, AMANHA())]));

  it("o que nasce da vitrine é marcado; o scraping desmarca", async () => {
    await sync.gravarVitrineLocal(VALIDO, [produto(1)], { parcial: false });
    expect((await linha(produto(1))).soDaVitrine).toBe(true);

    await catalog.upsertProducts([raspado(1)]);
    expect((await linha(produto(1))).soDaVitrine).toBe(false);
  });

  it("a vitrine não marca a linha que veio do scraping", async () => {
    await catalog.upsertProducts([raspado(2)]);
    await sync.gravarVitrineLocal(VALIDO, [produto(2)], { parcial: false });
    expect((await linha(produto(2))).soDaVitrine).toBe(false);
  });
});

describe("a vitrine vazia (task 8)", () => {
  const PRONTO = "9930011";
  const VAZIA = "9930012";

  beforeEach(async () => {
    await coupons.upsertCoupons([cupom(PRONTO, AMANHA()), cupom(VAZIA, AMANHA())]);
    await coupons.marcarVitrineVazia(VAZIA, { total: 0 });
  });

  it("fica gravada, com o total que a página declarou", async () => {
    const c = await coupons.getCoupon(VAZIA);
    expect(c.vitrineVaziaAt).toBeInstanceOf(Date);
    expect(c.vitrineTotal).toBe(0);
  });

  it("conta à parte, e não como 'sem nenhum produto'", async () => {
    const { produtosPorCupom } = await coupons.stats();
    expect(produtosPorCupom).toMatchObject({ semNada: 1, vitrineVazia: 1, parciais: 0, completos: 0 });
  });

  it("sai das duas filas do botão 2 — mas o botão da linha ainda tenta", async () => {
    const todos = await sync.alvosDeProdutos({});
    expect(todos.prontos.map(c => c.campaignId)).toEqual([PRONTO]);
    expect(todos).toMatchObject({ incompletos: 1, semNada: 1 });

    const soSemNada = await sync.alvosDeProdutos({ soSemProdutos: true });
    expect(soSemNada.prontos.map(c => c.campaignId)).toEqual([PRONTO]);

    const daLinha = await sync.alvosDeProdutos({ campaignIds: [VAZIA] });
    expect(daLinha.prontos.map(c => c.campaignId)).toEqual([VAZIA]);
  });

  it("o filtro da tabela separa os estados", async () => {
    expect((await coupons.listCoupons({ produtos: "vazia" })).items.map(c => c.campaignId)).toEqual([VAZIA]);
    expect((await coupons.listCoupons({ produtos: "nenhum" })).items.map(c => c.campaignId)).toEqual([PRONTO]);
  });

  it("a vitrine que depois traz produto deixa de ser vazia", async () => {
    await sync.gravarVitrineLocal(VAZIA, [produto(3)], { parcial: true });
    expect((await coupons.getCoupon(VAZIA)).vitrineVaziaAt).toBe(null);
    expect((await coupons.stats()).produtosPorCupom).toMatchObject({ vitrineVazia: 0, parciais: 1 });
  });

  it("cupom que não está no sistema é recusado", async () => {
    await expect(coupons.marcarVitrineVazia("9939999")).rejects.toThrow(/não está no sistema/);
  });

  it("a rota aceita o total só como inteiro", async () => {
    const { user, auth } = await createTestUser();
    await authMod.setUserRole(user.id, "admin");

    const r = await auth("post", `/api/admin/ml-cupons/${PRONTO}/vitrine-vazia`).send({ total: "abc" });
    expect(r.status).toBe(200);
    const c = await coupons.getCoupon(PRONTO);
    expect(c.vitrineVaziaAt).toBeInstanceOf(Date);
    expect(c.vitrineTotal).toBe(null);
  });
});

describe("apagar os cupons vencidos (task 9)", () => {
  // p1 — só da vitrine do vencido: SAI.
  // p2 — também na vitrine de um cupom válido: fica, e passa a ser carimbado nele.
  // p3 — veio do scraping antes da vitrine: fica.
  // p4 — o repasse também o trouxe (noutro cupom vencido): fica.
  // p5 — o scraping o viu depois da vitrine: fica.
  // p6 — só no cupom válido: nem é olhado.
  beforeEach(async () => {
    await coupons.upsertCoupons([cupom(VENCIDO, ONTEM()), cupom(VENCIDO_2, ONTEM()), cupom(VALIDO, AMANHA())]);
    await catalog.upsertProducts([raspado(3)]);
    await sync.gravarVitrineLocal(VENCIDO, [1, 2, 3, 4, 5].map(produto), { parcial: false });
    await sync.gravarVitrineLocal(VALIDO, [produto(2), produto(6)], { parcial: false });
    await coupons.vincularDoRepasse(VENCIDO_2, [{ productKeys: [(await linha(produto(4))).key], productUrl: produto(4).link }]);
    await catalog.upsertProducts([raspado(5)]);
  });

  it("a prévia conta sem apagar nada", async () => {
    const r = await coupons.apagarVencidos({ simular: true });
    expect(r).toEqual({ cupons: 2, vinculos: 6, produtos: 1, produtosMantidos: 4 });
    expect(await coupons.getCoupon(VENCIDO)).not.toBe(null);
    expect(await existe(produto(1))).toBe(true);
  });

  it("apaga os vencidos e só o produto que veio só pela vitrine deles", async () => {
    const r = await coupons.apagarVencidos();
    expect(r).toEqual({ cupons: 2, vinculos: 6, produtos: 1, produtosMantidos: 4 });

    expect(await coupons.getCoupon(VENCIDO)).toBe(null);
    expect(await coupons.getCoupon(VENCIDO_2)).toBe(null);
    expect(await prisma().mlCouponProduct.count({ where: { campaignId: { in: [VENCIDO, VENCIDO_2] } } })).toBe(0);

    expect(await existe(produto(1))).toBe(false);
    for (const n of [2, 3, 4, 5, 6]) expect(await existe(produto(n))).toBe(true);

    // O cupom válido não foi tocado, e o produto que estava nos dois é dele agora.
    expect(await coupons.getCoupon(VALIDO)).not.toBe(null);
    expect((await linha(produto(2))).couponCampaignId).toBe(VALIDO);
  });

  it("sem vencido, não faz nada", async () => {
    await coupons.apagarVencidos();
    expect(await coupons.apagarVencidos()).toEqual({ cupons: 0, vinculos: 0, produtos: 0, produtosMantidos: 0 });
  });

  it("pela rota: a prévia no GET e o apagar no DELETE", async () => {
    const { user, auth } = await createTestUser();
    await authMod.setUserRole(user.id, "admin");

    const previa = await auth("get", "/api/admin/ml-cupons/vencidos");
    expect(previa.status).toBe(200);
    expect(previa.body).toMatchObject({ cupons: 2, produtos: 1 });

    const feito = await auth("delete", "/api/admin/ml-cupons/vencidos");
    expect(feito.status).toBe(200);
    expect(feito.body).toMatchObject({ ok: true, cupons: 2, produtos: 1 });
    // A rota de apagar UM cupom não engoliu o "vencidos".
    expect(await coupons.getCoupon(VALIDO)).not.toBe(null);
  });
});

describe("apagar os produtos da vitrine de um cupom (task 10)", () => {
  const X = "9930021";
  const Y = "9930022";

  // p1 — só na vitrine de X: sai.
  // p2 — também na vitrine de Y: o vínculo com X sai, o produto fica.
  // p7 — parcial de X: sai.
  // p8 — veio do scraping e o checkout o ligou a X: fica, com o vínculo.
  beforeEach(async () => {
    await coupons.upsertCoupons([cupom(X, AMANHA()), cupom(Y, AMANHA())]);
    await sync.gravarVitrineLocal(X, [produto(1), produto(2)], { parcial: false });
    await sync.gravarVitrineLocal(X, [produto(7)], { parcial: true });
    await sync.gravarVitrineLocal(Y, [produto(2)], { parcial: false });
    await catalog.upsertProducts([raspado(8)]);
    await coupons.vincularPorCheckout({
      productKeys: [(await linha(produto(8))).key], productUrl: produto(8).link,
      cupons: [{ campaignId: X, titulo: `Cupom ${X}` }],
    });
  });

  it("leva a vitrine e o parcial; o checkout e o produto de outro cupom ficam", async () => {
    const r = await coupons.apagarProdutosDaVitrine(X);
    expect(r).toEqual({ vinculos: 3, produtos: 2, produtosMantidos: 1 });

    expect(await existe(produto(1))).toBe(false);
    expect(await existe(produto(7))).toBe(false);
    expect(await existe(produto(2))).toBe(true);
    expect(await existe(produto(8))).toBe(true);

    const restantes = await prisma().mlCouponProduct.findMany({ where: { campaignId: X }, select: { origem: true } });
    expect(restantes.map(v => v.origem)).toEqual(["checkout"]);
    // Y não perdeu nada.
    expect(await prisma().mlCouponProduct.count({ where: { campaignId: Y } })).toBe(1);
  });

  it("o cupom fica, e volta para a fila do botão 2", async () => {
    expect((await sync.alvosDeProdutos({})).prontos.map(c => c.campaignId)).not.toContain(X);

    await coupons.apagarProdutosDaVitrine(X);

    expect((await coupons.getCoupon(X)).productsSyncedAt).toBe(null);
    expect((await sync.alvosDeProdutos({})).prontos.map(c => c.campaignId)).toContain(X);
  });

  it("cupom que não está no sistema é recusado", async () => {
    await expect(coupons.apagarProdutosDaVitrine("9939999")).rejects.toThrow(/não está no sistema/);
  });

  it("pela rota", async () => {
    const { user, auth } = await createTestUser();
    await authMod.setUserRole(user.id, "admin");

    const r = await auth("delete", `/api/admin/ml-cupons/${X}/produtos`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, vinculos: 3, produtos: 2 });
    expect(await coupons.getCoupon(X)).not.toBe(null);
  });
});
