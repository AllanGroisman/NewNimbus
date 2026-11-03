// Aba Admin › Faxina: a limpeza (cupons que não funcionam + produtos antigos) e a
// re-busca do catálogo (atualiza quem a loja confirmou, apaga quem sumiu).
//
// O cuidado que estes testes protegem é o "na dúvida, não apaga": cupom com a
// palavra revalidada fica, produto preso a cupom válido fica, e na re-busca
// CAPTCHA/erro nunca apaga — nem um "sumiu" em massa, que o disjuntor segura.
import { describe, it, expect, beforeEach } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { catalog, prisma, createTestUser, auth as authMod } from "../helpers/app.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const backendDir = path.resolve(__dirname, "..", "..", "backend");
const coupons = require(path.join(backendDir, "coupons"));
const rebusca = require(path.join(backendDir, "faxina", "rebusca.js"));

const AMANHA = () => new Date(Date.now() + 864e5).toISOString();
const ONTEM = () => new Date(Date.now() - 864e5).toISOString();

const cupom = (campaignId, expiresAt) => ({
  campaignId, title: `Cupom ${campaignId}`, kind: "percent", value: 10, scope: "campaign",
  activated: true, containerUrl: `https://lista.mercadolivre.com.br/_Container_${campaignId}`, expiresAt,
});
const comPalavra = (campaignId, code) => prisma().mlCoupon.update({ where: { campaignId }, data: { code } });

const produto = (n, store = "Mercado Livre") => ({
  name: `Produto ${n}`,
  link: store === "Shopee"
    ? `https://shopee.com.br/product/410522123/${9940000000 + n}`
    : `https://www.mercadolivre.com.br/p/MLB994${String(n).padStart(4, "0")}`,
  price: 10 + n, store, category: "gamer",
});
const linha = (p) => prisma().catalogProduct.findFirst({ where: { link: p.link } });
const envelhecer = (p, dias) => prisma().catalogProduct.updateMany({
  where: { link: p.link }, data: { lastSeenAt: new Date(Date.now() - dias * 864e5) },
});

describe("cupons que não funcionam mais", () => {
  const VENCIDO = "9940001", INVALIDO = "9940002", REVALIDADO = "9940003", BOM = "9940004";

  beforeEach(async () => {
    await coupons.upsertCoupons([cupom(VENCIDO, ONTEM()), cupom(INVALIDO, AMANHA()), cupom(REVALIDADO, AMANHA()), cupom(BOM, AMANHA())]);
    await comPalavra(INVALIDO, "PALAVRAMORTA");
    await comPalavra(REVALIDADO, "VOLTOU");
    await coupons.recordCodeCheck({ code: "PALAVRAMORTA", verdict: "invalid" });
    await coupons.recordCodeCheck({ code: "VOLTOU", verdict: "invalid" });
    await coupons.recordCodeCheck({ code: "VOLTOU", verdict: "valid", campaignId: REVALIDADO });
  });

  it("a prévia conta vencidos e palavra inválida sem apagar nada", async () => {
    const r = await coupons.apagarCuponsMortos({ simular: true });
    expect(r).toMatchObject({ cupons: 2, vencidos: 1, palavraInvalida: 1 });
    expect(await prisma().mlCoupon.count()).toBe(4);
  });

  it("apaga o vencido e o de palavra inválida; o revalidado e o bom ficam", async () => {
    await coupons.apagarCuponsMortos();
    const ficaram = (await prisma().mlCoupon.findMany({ select: { campaignId: true } })).map(c => c.campaignId).sort();
    expect(ficaram).toEqual([REVALIDADO, BOM].sort());
    // A palavra testada não some — cada teste custou um Chrome com a conta do ML.
    expect(await prisma().mlCouponCode.count({ where: { code: "PALAVRAMORTA" } })).toBe(1);
  });
});

describe("a limpeza pela rota", () => {
  let auth;
  beforeEach(async () => {
    const u = await createTestUser();
    await authMod.setUserRole(u.user.id, "admin");
    auth = u.auth;
  });

  it("apaga produto antigo e poupa o preso a cupom válido", async () => {
    await coupons.upsertCoupons([cupom("9940010", AMANHA())]);
    await catalog.upsertProducts([produto(1), produto(2), produto(3)]);
    await coupons.vincularDoRepasse("9940010", [{ productKeys: [(await linha(produto(2))).key], productUrl: produto(2).link }]);
    await envelhecer(produto(1), 40);
    await envelhecer(produto(2), 40);

    const cfg = await auth("put", "/api/admin/faxina/config").send({ limpeza: { diasProdutoAntigo: 30 } });
    expect(cfg.status).toBe(200);

    const previa = await auth("post", "/api/admin/faxina/limpeza/previa");
    expect(previa.body.produtosAntigos).toBe(1);

    const r = await auth("post", "/api/admin/faxina/limpeza/run");
    expect(r.status).toBe(200);
    expect(r.body.result.produtosAntigos).toBe(1);
    expect(await linha(produto(1))).toBe(null);
    expect(await linha(produto(2))).not.toBe(null);
    expect(await linha(produto(3))).not.toBe(null);
  });

  it("não-admin não entra", async () => {
    const { auth: comum } = await createTestUser();
    expect((await comum("get", "/api/admin/faxina/status")).status).toBe(403);
  });
});

// Deps falsas da re-busca: cada link responde o que o teste mandar.
function depsFalsas(respostaPorLink) {
  const real = { catalog: require(path.join(backendDir, "catalog")) };
  const { mlItemIdFromUrl, mlUrlSpace } = require(path.join(backendDir, "catalog", "product-key.js"));
  const scraper = require(path.join(backendDir, "scraping", "scraper.js"));
  const affiliate = require(path.join(backendDir, "scraping", "affiliate.js"));
  return {
    ...real,
    extractShopeeIds: scraper.extractShopeeIds,
    shopeeNodeToProduct: (node) => node,
    consultarShopeeItem: async (itemId) => respostaPorLink[`shopee:${itemId}`],
    criarLinkAfiliadoMLSistema: async (link) => {
      const r = respostaPorLink[link];
      if (r === "recusado") return { shortUrl: null, kind: affiliate.ML_LINK_KIND.LINK_RECUSADO, reason: "recusado" };
      return { shortUrl: link, kind: "ok" };
    },
    ML_LINK_KIND: affiliate.ML_LINK_KIND,
    fetchSocialLanding: async (link) => respostaPorLink[link],
    mlItemIdFromUrl,
    mlUrlSpace,
    launchAmazonBrowser: async () => ({ close: async () => {} }),
    enrichAmazonProducts: async () => ({ stopped: false }),
    sleep: async () => {},
  };
}

describe("re-busca", () => {
  it("atualiza o confirmado, apaga o sumido e não toca no bloqueado", async () => {
    const ok = produto(11), sumiu = produto(12), captcha = produto(13), shopeeOk = produto(14, "Shopee"), shopeeSumiu = produto(15, "Shopee");
    await catalog.upsertProducts([ok, sumiu, captcha, shopeeOk, shopeeSumiu]);
    const deps = depsFalsas({
      [ok.link]: { ok: true, product: { name: "Nome novo", price: 99, link: ok.link, img: "https://img/novo.jpg" } },
      [sumiu.link]: "recusado",
      [captcha.link]: { ok: false, kind: "captcha", reason: "CAPTCHA" },
      "shopee:9940000014": { ok: true, node: { name: "Shopee nova", price: 5 } },
      "shopee:9940000015": { ok: true, node: null },
    });

    const r = await rebusca.rodar({ pausaMs: 0, deps });
    expect(r).toMatchObject({ total: 5, done: 5, atualizados: 2, apagados: 2, pulados: 1 });
    expect(await linha(ok)).toMatchObject({ name: "Nome novo", price: 99, img: "https://img/novo.jpg" });
    expect(await linha(sumiu)).toBe(null);
    expect(await linha(captcha)).toMatchObject({ name: captcha.name });
    expect(await linha(shopeeOk)).toMatchObject({ name: "Shopee nova", price: 5 });
    expect(await linha(shopeeSumiu)).toBe(null);
  });

  it("produto da landing que não é o desta linha não atualiza nem apaga", async () => {
    const p = produto(16);
    await catalog.upsertProducts([p]);
    const deps = depsFalsas({
      [p.link]: { ok: true, product: { name: "Outro", price: 1, link: "https://www.mercadolivre.com.br/p/MLB12345678" } },
    });
    const r = await rebusca.rodar({ pausaMs: 0, deps });
    expect(r).toMatchObject({ pulados: 1, atualizados: 0, apagados: 0 });
    expect(await linha(p)).toMatchObject({ name: p.name });
  });

  it("o disjuntor segura um 'sumiu' em massa", async () => {
    const lista = Array.from({ length: 30 }, (_, i) => produto(100 + i));
    await catalog.upsertProducts(lista);
    const deps = depsFalsas(Object.fromEntries(lista.map(p => [p.link, "recusado"])));
    const r = await rebusca.rodar({ pausaMs: 0, deps });
    expect(r.apagados).toBe(0);
    expect(r.lojasParadas["Mercado Livre"]).toMatch(/mudança no site/);
    expect(await prisma().catalogProduct.count()).toBe(30);
  });

  it("cancelar para no meio sem apagar o que falta", async () => {
    const lista = [produto(201), produto(202), produto(203)];
    await catalog.upsertProducts(lista);
    let vistos = 0;
    const deps = depsFalsas(Object.fromEntries(lista.map(p => [p.link, { ok: true, product: { name: "x", price: 1, link: p.link } }])));
    const r = await rebusca.rodar({ pausaMs: 0, deps, ctl: { deveParar: () => vistos++ >= 1 } });
    expect(r.cancelado).toBe(true);
    expect(r.done).toBe(1);
  });
});
