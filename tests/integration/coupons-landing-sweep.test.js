// A varredura em lote dos cupons pela landing, com o banco de verdade e o Mercado
// Livre mockado (coupons/landing-sweep.js + coupons/enrich-samples.js).
//
// O que ela existe pra fazer: o produto do sistema passar a carregar o cupom que vale
// nele. Em 19/09/2026 eram 4.035 produtos no catálogo e UM com cupom — os produtos
// dos cupons não estavam lá. Estes testes cercam o que faz isso dar certo e o que
// faria dar errado caro:
//   - o produto da prévia entra no catálogo JÁ carimbado com o cupom;
//   - a prévia entra como `landing` (prova positiva), nunca como vitrine fechada;
//   - no primeiro muro a rodada para e o breaker segura a próxima;
//   - cupom que a landing já tentou não volta pra fila a cada rodada;
//   - a amostra vira produto com a chave CERTA, e a que devolve outro item é descartada.
// As decisões puras ficam em unit/coupon-landing-sweep.test.js.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { catalog } from "../helpers/app.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const backendDir = path.resolve(__dirname, "..", "..", "backend");
const sweep = require(path.join(backendDir, "coupons", "landing-sweep.js"));
const sweepConfig = require(path.join(backendDir, "coupons", "landing-sweep-config.js"));
const coupons = require(path.join(backendDir, "coupons"));
const sync = require(path.join(backendDir, "coupons", "sync.js"));
const mlCupons = require(path.join(backendDir, "scraping", "ml-cupons.js"));
const mlSocial = require(path.join(backendDir, "scraping", "ml-social.js"));
const affiliate = require(path.join(backendDir, "scraping", "affiliate.js"));
const { productKey } = require(path.join(backendDir, "catalog", "product-key.js"));
const { prisma } = require(path.join(backendDir, "db.js"));

const AMANHA = () => new Date(Date.now() + 864e5);

async function cupom(campaignId, over = {}) {
  return prisma().mlCoupon.create({
    data: {
      campaignId, title: `Cupom ${campaignId}`, kind: "percent", value: 10, scope: "campaign",
      activated: true, expiresAt: AMANHA(),
      containerUrl: `https://lista.mercadolivre.com.br/_Container_${campaignId}?coupon_campaign_id=${campaignId}`,
      ...over,
    },
  });
}

const produto = (id, over = {}) => ({
  name: `Produto ${id}`, price: 100, img: "https://http2.mlstatic.com/x.jpg",
  link: `https://www.mercadolivre.com.br/produto-${id}/p/MLB${id}`, store: "Mercado Livre", ...over,
});

const previa = (...ids) => ({ ok: true, kind: "ok", reason: `${ids.length} produto(s)`, products: ids.map(id => produto(id)) });

let landing;

beforeEach(() => {
  sweep._resetEstado();
  vi.spyOn(affiliate, "getScraperMLSession").mockReturnValue({ cookie: "cookie-de-teste", tag: "tagteste" });
  vi.spyOn(sync, "status").mockReturnValue({ running: false, importing: false, local: false });
  // Pausa zero: o laço inteiro roda na hora sob teste (o sleep já é no-op, mas o
  // jitter multiplica a pausa, e zero deixa isso explícito).
  vi.spyOn(sweepConfig, "readConfig").mockReturnValue({ ...sweepConfig.DEFAULTS, pausaMs: 0, enriquecerAmostras: false });
  landing = vi.spyOn(mlCupons, "vitrinePelaLanding");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a varredura pela landing", () => {
  it("põe os produtos do cupom no catálogo já carimbados com ele", async () => {
    await cupom("100");
    landing.mockResolvedValue(previa("2001", "2002"));

    const r = await sweep.runOnce();

    expect(r).toMatchObject({ lidos: 1, comPrevia: 1, produtos: 2, bloqueado: false });
    const p = await prisma().catalogProduct.findUnique({ where: { key: productKey(produto("2001")) } });
    expect(p).toMatchObject({ name: "Produto 2001", couponCampaignId: "100" });

    // É o que a busca de produtos mostra: o cupom na lista do produto.
    const mapa = await coupons.couponsListForKeys([p.key]);
    expect(mapa.get(p.key).map(c => c.campaignId)).toEqual(["100"]);
  });

  it("grava como prévia (`landing`), nunca como vitrine fechada", async () => {
    await cupom("100");
    landing.mockResolvedValue(previa("2001"));

    await sweep.runOnce();

    const vinculos = await prisma().mlCouponProduct.findMany({ where: { campaignId: "100" } });
    expect(vinculos.map(v => v.origem)).toEqual(["landing"]);
    // Sem isto a tela pararia de oferecer a extensão pra buscar a lista inteira, e o
    // quick-check passaria a dizer "fora da vitrine" com base em 3 produtos.
    expect(await coupons.hasVitrine("100")).toBe(false);
    const c = await coupons.getCoupon("100");
    expect(c.productsSyncedAt).toBeNull();
    expect(c).toMatchObject({ landingOk: true });
    expect(c.landingTriedAt).not.toBeNull();
  });

  it("para no primeiro muro e o breaker segura a rodada agendada seguinte", async () => {
    await cupom("100");
    await cupom("200");
    landing.mockResolvedValue({ ok: false, kind: "captcha", reason: "CAPTCHA", products: [] });

    const r = await sweep.runOnce();

    expect(r.bloqueado).toBe(true);
    expect(landing).toHaveBeenCalledTimes(1);
    expect(sweep.status().bloqueadoAte).not.toBeNull();
    // O cupom barrado NÃO é carimbado como tentado: o muro não foi resposta sobre ele.
    const tentados = await prisma().mlCoupon.count({ where: { landingTriedAt: { not: null } } });
    expect(tentados).toBe(0);

    const r2 = await sweep.runOnce();
    expect(r2.skipped).toBe("bloqueado");
    expect(landing).toHaveBeenCalledTimes(1);
  });

  it("o \"Rodar agora\" passa por cima do breaker", async () => {
    await cupom("100");
    landing.mockResolvedValueOnce({ ok: false, kind: "captcha", reason: "CAPTCHA", products: [] });
    await sweep.runOnce();

    landing.mockResolvedValue(previa("2001"));
    const r = await sweep.runOnce({ manual: true });
    expect(r.comPrevia).toBe(1);
  });

  it("cupom sem prévia é carimbado como tentado e não volta na rodada seguinte", async () => {
    await cupom("100");
    landing.mockResolvedValue({ ok: false, kind: "sem-produtos", reason: "O carrossel veio vazio.", products: [] });

    const r = await sweep.runOnce();
    expect(r).toMatchObject({ lidos: 1, semPrevia: 1 });
    expect(await coupons.getCoupon("100")).toMatchObject({ landingOk: false, landingMessage: "O carrossel veio vazio." });

    await sweep.runOnce();
    expect(landing).toHaveBeenCalledTimes(1);
  });

  it("só pega cupom válido, com URL de vitrine e sem a vitrine fechada", async () => {
    await cupom("VENCIDO", { expiresAt: new Date(Date.now() - 864e5) });
    await cupom("SEMURL", { containerUrl: null, activated: false });
    await cupom("COMVITRINE", { productsSyncedAt: new Date() });
    await cupom("BOM");
    landing.mockResolvedValue(previa("2001"));

    await sweep.runOnce();

    expect(landing.mock.calls.map(([c]) => c.campaignId)).toEqual(["BOM"]);
  });

  it("cupom de campanha vem antes do cupom de loja", async () => {
    await cupom("LOJA", { scope: "store", sellerName: "Loja X" });
    await cupom("CAMPANHA");
    landing.mockResolvedValue(previa("2001"));

    await sweep.runOnce();

    expect(landing.mock.calls.map(([c]) => c.campaignId)).toEqual(["CAMPANHA", "LOJA"]);
  });

  it("não disputa a conta do ML com a rodada do admin", async () => {
    await cupom("100");
    sync.status.mockReturnValue({ running: true, importing: false, local: false });

    const r = await sweep.runOnce();

    expect(r.skipped).toBe("rodada-em-curso");
    expect(landing).not.toHaveBeenCalled();
  });

  it("sem a tag do sistema nem começa — o link curto precisa dela", async () => {
    await cupom("100");
    affiliate.getScraperMLSession.mockReturnValue({ cookie: "c", tag: null });

    const r = await sweep.runOnce({ manual: true });

    expect(r.skipped).toBe("sem-tag");
    expect(landing).not.toHaveBeenCalled();
  });
});

describe("as amostras viram produto de catálogo", () => {
  beforeEach(() => {
    sweepConfig.readConfig.mockReturnValue({ ...sweepConfig.DEFAULTS, pausaMs: 0, enriquecerAmostras: true });
    landing.mockResolvedValue({ ok: false, kind: "sem-produtos", reason: "vazio", products: [] });
    vi.spyOn(affiliate, "criarLinkAfiliadoMLSistema").mockImplementation(async (url) => ({ shortUrl: `https://meli.la/${url.split("MLB-")[1]}`, kind: "ok" }));
  });

  const lidoDe = (mlItemId, over = {}) => ({
    ok: true, kind: "ok",
    product: {
      name: `Amostra ${mlItemId}`, price: 50, img: "https://http2.mlstatic.com/a.jpg",
      link: `https://www.mercadolivre.com.br/amostra/up/MLBU999`, store: "Mercado Livre", mlItemId, ...over,
    },
  });

  it("traz a amostra pro catálogo com a chave dela, carimbada com o cupom", async () => {
    await cupom("100", { sampleItemIds: ["MLB4922062133"] });
    await coupons.replaceCouponSamples("100", ["MLB4922062133"]);
    vi.spyOn(mlSocial, "fetchSocialLanding").mockResolvedValue(lidoDe("MLB4922062133"));

    const r = await sweep.runOnce();

    expect(r.amostras).toMatchObject({ tentadas: 1, trazidas: 1 });
    // A URL que o ML aceita é a do anúncio — com `/p/` ele recusa o link.
    expect(affiliate.criarLinkAfiliadoMLSistema).toHaveBeenCalledWith("https://produto.mercadolivre.com.br/MLB-4922062133");
    const chave = productKey({ link: coupons.linkSinteticoML("MLB4922062133") });
    const p = await prisma().catalogProduct.findUnique({ where: { key: chave } });
    expect(p).toMatchObject({ name: "Amostra MLB4922062133", couponCampaignId: "100" });
  });

  it("descarta quando a landing devolve outro anúncio, e não tenta de novo na rodada seguinte", async () => {
    await cupom("100", { sampleItemIds: ["MLB4922062133"] });
    await coupons.replaceCouponSamples("100", ["MLB4922062133"]);
    const lido = vi.spyOn(mlSocial, "fetchSocialLanding").mockResolvedValue(lidoDe("MLB111111111"));

    const r = await sweep.runOnce();

    expect(r.amostras).toMatchObject({ tentadas: 1, trazidas: 0, descartadas: 1 });
    expect(await catalog.count({})).toBe(0);
    const v = await prisma().mlCouponProduct.findFirst({ where: { origem: "amostra" } });
    expect(v.enrichTriedAt).not.toBeNull();

    sync.status.mockClear();
    await sweep.runOnce();
    expect(lido).toHaveBeenCalledTimes(1);
  });

  it("amostra que já está no catálogo não gasta requisição", async () => {
    await cupom("100", { sampleItemIds: ["MLB4922062133"] });
    await coupons.replaceCouponSamples("100", ["MLB4922062133"]);
    await catalog.upsertProducts([produto("x", { link: "https://produto.mercadolivre.com.br/MLB-4922062133" })]);

    await sweep.runOnce();

    expect(affiliate.criarLinkAfiliadoMLSistema).not.toHaveBeenCalled();
  });

  it("para no muro, sem carimbar a amostra como tentada", async () => {
    await cupom("100", { sampleItemIds: ["MLB4922062133", "MLB4922062134"] });
    await coupons.replaceCouponSamples("100", ["MLB4922062133", "MLB4922062134"]);
    const lido = vi.spyOn(mlSocial, "fetchSocialLanding").mockResolvedValue({ ok: false, kind: "captcha", reason: "CAPTCHA", product: null });

    const r = await sweep.runOnce();

    expect(lido).toHaveBeenCalledTimes(1);
    expect(r.bloqueado).toBe(true);
    const tentadas = await prisma().mlCouponProduct.count({ where: { enrichTriedAt: { not: null } } });
    expect(tentadas).toBe(0);
  });
});
