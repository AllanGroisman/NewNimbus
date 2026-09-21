// A sonda do checkout em lote (coupons/checkout-lote.js), com banco de verdade.
//
// O que protege:
//   - a fila só tem produto do ML vindo do scraping (com categoria), um por anúncio;
//   - quem foi sondado há pouco fica de fora; quem falhou volta no dia seguinte;
//   - "só sem cupom" deixa de fora quem já tem vínculo;
//   - o resultado grava o vínculo `checkout` e anota o produto como sondado — também
//     quando o checkout não ofereceu cupom nenhum (é isso que o tira da fila).

import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { catalog, createTestUser, auth as authMod } from "../helpers/app.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const backendDir = path.resolve(__dirname, "..", "..", "backend");
const coupons = require(path.join(backendDir, "coupons"));
const lote = require(path.join(backendDir, "coupons", "checkout-lote.js"));
const { prisma } = require(path.join(backendDir, "db.js"));
const appConfig = require(path.join(backendDir, "config"));
const loteConfig = require(path.join(backendDir, "coupons", "checkout-lote-config.js"));

const ml = (n, over = {}) => ({
  name: `Produto ${n}`, price: 200, store: "Mercado Livre", category: "casa",
  link: `https://produto.mercadolivre.com.br/MLB-${n}-produto-_JM`, ...over,
});
const keyDe = async (link) => (await prisma().catalogProduct.findFirst({ where: { link } })).key;
const IFRAME = () => fs.readFileSync(path.resolve(__dirname, "..", "fixtures", "ml-checkout-cupons-iframe.html"), "utf8");

beforeEach(async () => {
  await catalog.upsertProducts([
    ml(1001, { soldCount: 50 }),
    ml(1002, { soldCount: 10 }),
    ml(1003, { category: "gamer" }),
    // Veio da vitrine do cupom: sem categoria, não é "do scraping".
    ml(1004, { category: null }),
    ml(1005, { store: "Amazon", link: "https://www.amazon.com.br/dp/B000000001" }),
  ]);
});

describe("alvos", () => {
  it("só ML do scraping, com a contagem por categoria", async () => {
    const r = await lote.alvos({ limite: 10 });
    expect(r.produtos.map(p => p.name).sort()).toEqual(["Produto 1001", "Produto 1002", "Produto 1003"]);
    expect(r.total).toBe(3);
    expect(r.porCategoria).toEqual([
      { category: "casa", elegiveis: 2, sondados: 0, comCupom: 0 },
      { category: "gamer", elegiveis: 1, sondados: 0, comCupom: 0 },
    ]);
    // O ritmo vem junto da fila: é com ele que a tela anda.
    expect(r.cfg).toEqual(loteConfig.readConfig());
    expect(r.cfg.paralelo).toBe(1);
  });

  it("filtra por categoria sem sumir com as outras da contagem", async () => {
    const r = await lote.alvos({ categorias: ["gamer"] });
    expect(r.produtos.map(p => p.name)).toEqual(["Produto 1003"]);
    expect(r.total).toBe(1);
    expect(r.porCategoria).toHaveLength(2);
  });

  it("pula quem foi sondado há pouco; quem falhou volta depois de um dia", async () => {
    const k1 = await keyDe(ml(1001).link);
    const k2 = await keyDe(ml(1002).link);
    await lote.gravarResultado({ key: k1, material: { checkout: { reached: true }, paginaDosCupons: { ok: true, html: IFRAME() } } });
    await lote.gravarResultado({ key: k2, erro: "A extensão não respondeu a tempo." });

    let r = await lote.alvos({});
    expect(r.produtos.map(p => p.name)).toEqual(["Produto 1003"]);

    // Dois dias depois: a falha volta, o sucesso (pularDias = 7) não.
    await prisma().mlCheckoutProbe.updateMany({ data: { probedAt: new Date(Date.now() - 2 * 864e5) } });
    r = await lote.alvos({});
    expect(r.produtos.map(p => p.name).sort()).toEqual(["Produto 1002", "Produto 1003"]);
    // Com pularDias = 1, os dois voltam.
    r = await lote.alvos({ pularDias: 1 });
    expect(r.produtos).toHaveLength(3);
  });

  it("só sem cupom: quem já tem vínculo fica de fora", async () => {
    await prisma().mlCoupon.create({ data: { campaignId: "X", title: "X", kind: "percent", value: 10, scope: "campaign" } });
    await coupons.replaceCouponProducts("X", [{ productKey: await keyDe(ml(1001).link), productUrl: ml(1001).link }], { origem: "landing" });
    const r = await lote.alvos({ soSemCupom: true });
    expect(r.produtos.map(p => p.name).sort()).toEqual(["Produto 1002", "Produto 1003"]);
  });

  it("produto que o scraping não vê há mais de uma semana não entra", async () => {
    await prisma().catalogProduct.updateMany({ where: { category: "gamer" }, data: { lastSeenAt: new Date(Date.now() - 10 * 864e5) } });
    const r = await lote.alvos({});
    expect(r.produtos.map(p => p.category)).toEqual(["casa", "casa"]);
  });
});

describe("gravarResultado", () => {
  it("o que o checkout aplicou vira vínculo `checkout` e o produto conta como sondado com cupom", async () => {
    const link = ml(1001).link;
    const key = await keyDe(link);
    const r = await lote.gravarResultado({ key, url: link, material: { checkout: { reached: true }, paginaDosCupons: { ok: true, html: IFRAME() } } });

    expect(r).toMatchObject({ ok: true, cupons: [{ campaignId: "14167118", aplicado: true, descontoNoCarrinho: 20 }], cuponsNovos: 1 });
    const v = await prisma().mlCouponProduct.findFirst({ where: { campaignId: "14167118", productKey: key } });
    expect(v.origem).toBe("checkout");
    const s = await prisma().mlCheckoutProbe.findUnique({ where: { productKey: key } });
    expect(s).toMatchObject({ ok: true, cupons: 1, category: "casa", campaignIds: ["14167118"] });

    const a = await lote.alvos({});
    expect(a.porCategoria.find(c => c.category === "casa")).toMatchObject({ elegiveis: 1, sondados: 1, comCupom: 1 });
  });

  it("checkout sem cupom: anota 0 cupons e não cria vínculo", async () => {
    const key = await keyDe(ml(1002).link);
    const r = await lote.gravarResultado({ key, material: { checkout: { reached: true }, paginaDosCupons: { ok: true, html: IFRAME().replace(/Aplicado/g, "Aplicar").replace(/"given_discount":\s*[\d.]+/g, '"given_discount":0') } } });
    expect(r.ok).toBe(true);
    expect(r.cupons).toEqual([]);
    expect(await prisma().mlCouponProduct.count({ where: { productKey: key } })).toBe(0);
    expect(await prisma().mlCheckoutProbe.findUnique({ where: { productKey: key } })).toMatchObject({ ok: true, cupons: 0 });
  });

  it("sem a página de cupons, é falha com motivo", async () => {
    const key = await keyDe(ml(1003).link);
    const r = await lote.gravarResultado({ key, material: { checkout: { reached: false, blockedReason: "Escolha a variação" } } });
    expect(r).toMatchObject({ ok: false, motivo: "Escolha a variação", cupons: [] });
  });

  it("produto fora do catálogo dá erro claro", async () => {
    await expect(lote.gravarResultado({ key: "nao-existe", erro: "x" })).rejects.toThrow(/catálogo/);
  });
});

describe("o ritmo do lote (/sonda-lote/config)", () => {
  beforeEach(() => appConfig.del(loteConfig.CONFIG_KEY));

  it("GET devolve o padrão; PUT grava só o que veio, dentro das faixas, e a fila passa a andar com ele", async () => {
    const { user, auth } = await createTestUser();
    await authMod.setUserRole(user.id, "admin");

    const antes = await auth("get", "/api/admin/ml-cupons/sonda-lote/config");
    expect(antes.status).toBe(200);
    expect(antes.body.config).toEqual(loteConfig.DEFAULTS);
    expect(antes.body.faixas.paralelo).toEqual([1, 8]);

    const put = await auth("put", "/api/admin/ml-cupons/sonda-lote/config").send({ paralelo: 9, pausaMs: 2000, modoRapido: "false" });
    expect(put.status).toBe(200);
    expect(put.body.config).toMatchObject({ paralelo: 8, pausaMs: 2000, modoRapido: false, settleMs: 1500 });

    const fila = await lote.alvos({ limite: 5 });
    expect(fila.cfg).toMatchObject({ paralelo: 8, pausaMs: 2000 });
  });

  it("não-admin não mexe no ritmo", async () => {
    const { auth } = await createTestUser();
    const r = await auth("put", "/api/admin/ml-cupons/sonda-lote/config").send({ paralelo: 4 });
    expect(r.status).toBe(403);
  });
});

describe("o histórico das execuções (/sonda-lote/runs)", () => {
  beforeEach(() => appConfig.del(lote.RUNS_KEY));
  const RUN = (min, over = {}) => ({
    inicio: `2026-09-21T22:${String(min).padStart(2, "0")}:00.000Z`,
    fim: `2026-09-21T22:${String(min).padStart(2, "0")}:40.000Z`,
    produtos: 4, naFila: 4, ok: 4, comCupom: 1, falhas: 0, mediaSondaMs: 9000,
    ritmo: { paralelo: 2, pausaMs: 0, settleMs: 1500, modoRapido: true }, ...over,
  });

  it("grava o resumo, calcula a duração e devolve a mais nova primeiro", async () => {
    const { user, auth } = await createTestUser();
    await authMod.setUserRole(user.id, "admin");

    expect((await auth("post", "/api/admin/ml-cupons/sonda-lote/runs").send(RUN(1))).status).toBe(200);
    expect((await auth("post", "/api/admin/ml-cupons/sonda-lote/runs").send(RUN(2, { muro: true, parado: "verificação", lixo: "x" }))).status).toBe(200);

    const r = await auth("get", "/api/admin/ml-cupons/sonda-lote/runs");
    expect(r.status).toBe(200);
    expect(r.body.runs.map(x => x.inicio)).toEqual([RUN(2).inicio, RUN(1).inicio]);
    expect(r.body.runs[0]).toMatchObject({ duracaoMs: 40000, muro: true, parado: "verificação", mediaSondaMs: 9000 });
    expect(r.body.runs[0]).not.toHaveProperty("lixo");
  });

  it("guarda só as últimas; sem início ou fim é recusado", async () => {
    for (let i = 0; i < lote.MAX_RUNS + 3; i++) lote.registrarRun(RUN(i % 60));
    expect(lote.ultimasRuns()).toHaveLength(lote.MAX_RUNS);
    expect(() => lote.registrarRun({ produtos: 1 })).toThrow(/início ou o fim/);
  });
});
