// O robô dos cupons do repasse, de ponta a ponta — com o banco de verdade e o
// Mercado Livre mockado.
//
// Desde a task 7 ele tem duas metades:
//   - a FILA do teste no checkout: o servidor diz o que falta testar, a aba do
//     admin reivindica, roda na extensão e devolve o material (registrarCheckout);
//   - a rodada do servidor, que só traz a campanha e raspa a vitrine — ela não
//     testa mais palavra nenhuma no Chrome do servidor.
//
// O que estes testes protegem é o FREIO: muro na aba pausa a fila, uma aba não pega
// o cupom da outra, e o diário conta o que aconteceu inclusive quando nada
// aconteceu. A parte que DECIDE (pura) fica em unit/repasse-coupon-autotest.test.js
// e a leitura do material em unit/repasse-checkout-cupom.test.js.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestUser, auth as authMod } from "../helpers/app.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const backendDir = path.resolve(__dirname, "..", "..", "backend");
const autotest = require(path.join(backendDir, "repasse", "coupon-autotest.js"));
const autotestLog = require(path.join(backendDir, "repasse", "coupon-autotest-log.js"));
const sync = require(path.join(backendDir, "coupons", "sync.js"));
const affiliate = require(path.join(backendDir, "scraping", "affiliate.js"));
const { prisma } = require(path.join(backendDir, "db.js"));

let userId;
let adminReq;

// Uma captura com cupom, como a legenda de um grupo líder produz.
async function capturado(coupon, { outcome = "queued", groupId = 1n, store = "Mercado Livre", rawUrl = null } = {}) {
  await prisma().repasseCaptureLog.create({
    data: {
      groupId, userId, waJid: "120363@g.us",
      rawUrl: rawUrl || `https://mercadolivre.com.br/p/${Math.random()}`,
      coupon, outcome, store,
    },
  });
}

// O material que a extensão devolve, nos três desfechos que importam.
const CARTAO = "Com JBL20\n20% OFF\nCompra mínima R$ 99 | Limite de R$ 60 | Venc. 30/09/2026\nAplicado";
const MATERIAL = {
  aplicado: {
    checkout: { reached: true }, modal: { aberto: true, campo: true },
    cartaoDepois: { texto: CARTAO, aplicado: true },
    resumoDepois: "Cupons (1/1 em uso) - R$ 40,00 Você pagará R$ 160,00",
  },
  indisponivel: {
    checkout: { reached: true }, modal: { aberto: true, campo: true },
    erroCampo: "O cupom não está mais disponível.",
  },
  captcha: { muro: "captcha", checkout: { reached: false } },
};

// A palavra já testada antes, do jeito que o checkWord a deixaria.
async function palavraTestada(code, { verdict, campaignId = null, checkCount = 1, horasAtras = 0 } = {}) {
  await prisma().mlCouponCode.create({
    data: {
      code, verdict, campaignId, checkCount,
      source: "repasse-auto",
      checkedAt: new Date(Date.now() - horasAtras * 3600_000),
    },
  });
}

const logDe = async (code) => (await autotestLog.listAutotestLog({ code, pageSize: 50 })).items;
const acoes = (itens) => itens.map(i => i.action);

beforeEach(async () => {
  await prisma().repasseCouponAutotest.deleteMany({});
  await prisma().repasseCupomManual.deleteMany({});
  await prisma().repasseCaptureLog.deleteMany({});
  await prisma().mlCouponCode.deleteMany({});
  await prisma().mlCoupon.deleteMany({});
  const u = await createTestUser();
  await authMod.setUserRole(u.user.id, "admin");
  userId = u.user.id;
  adminReq = u.auth;
  autotest._resetEstado();

  // Sem sessão do ML a rodada sai na porta — e não é isso que se quer medir aqui.
  vi.spyOn(affiliate, "getScraperMLSession").mockReturnValue({ cookie: "cookie-de-teste" });
  // Nenhuma rodada do admin em curso, por padrão.
  vi.spyOn(sync, "status").mockReturnValue({ running: false, importing: false });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a fila do teste no checkout", () => {
  it("põe na fila o cupom nunca testado, com o link do ML que chegou com ele", async () => {
    await capturado("JBL20", { rawUrl: "https://www.mercadolivre.com.br/caixa-jbl/p/MLB111" });
    const { itens } = await autotest.pendentesCheckout();
    expect(itens).toEqual([expect.objectContaining({
      origem: "repasse", code: "JBL20", url: "https://www.mercadolivre.com.br/caixa-jbl/p/MLB111",
      motivo: "nunca-testado", capturas: 1, reservado: false,
    })]);
  });

  it("prefere o link que virou produto ao de um descartado", async () => {
    await capturado("JBL20", { outcome: "queued", rawUrl: "https://www.mercadolivre.com.br/p/BOM" });
    await capturado("JBL20", { outcome: "discarded", rawUrl: "https://www.mercadolivre.com.br/p/DESCARTADO" });
    const { itens } = await autotest.pendentesCheckout();
    expect(itens[0].url).toBe("https://www.mercadolivre.com.br/p/BOM");
  });

  it("cupom sem link do ML não entra — não há produto onde testar", async () => {
    await capturado("AMZ10", { store: "Amazon", rawUrl: "https://amzn.to/x" });
    expect((await autotest.pendentesCheckout()).itens).toEqual([]);
  });

  it("o 'indeterminado' do teste antigo de palavra volta pra fila, mesmo no teto de tentativas", async () => {
    // Aquilo era o Chrome do servidor barrado, não uma resposta sobre o cupom.
    await capturado("VELHO10");
    await palavraTestada("VELHO10", { verdict: "indeterminado", checkCount: 3 });
    expect((await autotest.pendentesCheckout()).itens.map(i => i.code)).toEqual(["VELHO10"]);
  });

  it("não volta num cupom que o ML recusou", async () => {
    await capturado("NAOEXISTE");
    await palavraTestada("NAOEXISTE", { verdict: "invalid", horasAtras: 500 });
    expect((await autotest.pendentesCheckout()).itens).toEqual([]);
  });

  it("uma aba não pega o cupom que a outra reivindicou — e a tela o vê como 'testando'", async () => {
    await capturado("A1000");
    await capturado("B1000");
    expect(autotest.reivindicarCheckout("a1000")).toEqual({ ok: true, code: "A1000" });
    expect(autotest.reivindicarCheckout("A1000").ok).toBe(false);
    const { itens } = await autotest.pendentesCheckout();
    expect(Object.fromEntries(itens.map(i => [i.code, i.reservado]))).toEqual({ A1000: true, B1000: false });
  });

  it("o pedido manual vem antes do repasse, e o mesmo código não aparece duas vezes", async () => {
    await capturado("MELIKIDS", { rawUrl: "https://www.mercadolivre.com.br/p/DO-REPASSE" });
    await capturado("JBL20");
    await autotest.adicionarManual({ code: "melikids", url: "https://www.mercadolivre.com.br/boneca/p/MLB9" });

    const { itens, total } = await autotest.pendentesCheckout();
    expect(total).toBe(2);
    expect(itens[0]).toMatchObject({ origem: "manual", code: "MELIKIDS", url: "https://www.mercadolivre.com.br/boneca/p/MLB9" });
    expect(itens[0].manualId).toEqual(expect.any(String));
    expect(itens[1]).toMatchObject({ origem: "repasse", code: "JBL20" });
  });

  it("o pedido manual sai da fila com o desfecho do teste", async () => {
    const item = await autotest.adicionarManual({ code: "MELIKIDS", url: "https://www.mercadolivre.com.br/boneca/p/MLB9" });
    await autotest.registrarCheckout({ code: "MELIKIDS", url: item.url, material: MATERIAL.indisponivel, manualId: item.manualId });

    expect((await autotest.pendentesCheckout()).itens).toEqual([]);
    const linha = await prisma().repasseCupomManual.findUnique({ where: { id: BigInt(item.manualId) } });
    expect(linha.testedAt).toBeTruthy();
    expect(linha.verdict).toBe("invalid");
  });

  it("recusa código ou link que não servem", async () => {
    await expect(autotest.adicionarManual({ code: "X", url: "https://www.mercadolivre.com.br/p/MLB1" })).rejects.toThrow(/Código inválido/);
    await expect(autotest.adicionarManual({ code: "VALE10", url: "https://www.amazon.com.br/dp/B0" })).rejects.toThrow(/Mercado Livre/);
    await expect(autotest.adicionarManual({ code: "VALE10", url: "não é link" })).rejects.toThrow(/Mercado Livre/);
  });

  it("remover tira só o pedido que ainda não foi testado", async () => {
    const item = await autotest.adicionarManual({ code: "MELIKIDS", url: "https://www.mercadolivre.com.br/boneca/p/MLB9" });
    expect(await autotest.removerManual(item.manualId)).toEqual({ removido: 1 });
    expect(await autotest.removerManual(item.manualId)).toEqual({ removido: 0 });
    expect(await autotest.removerManual("lixo")).toEqual({ removido: 0 });
  });

  it("aplicado no checkout → valid, com as condições na mensagem e no diário", async () => {
    await capturado("JBL20");
    const r = await autotest.registrarCheckout({
      code: "jbl20", url: "https://www.mercadolivre.com.br/p/MLB111",
      material: MATERIAL.aplicado, source: "repasse-checkout-auto", durationMs: 1234,
    });
    expect(r.verdict).toBe("valid");
    expect(r.resultado).toMatchObject({ status: "aplicado_agora", desconto: "20% OFF", compra_minima: 99, limite_desconto: 60 });

    const chk = await prisma().mlCouponCode.findUnique({ where: { code: "JBL20" } });
    expect(chk).toMatchObject({ verdict: "valid", source: "repasse-checkout-auto" });
    expect(chk.message).toMatch(/Aplicado no checkout.*20% OFF/);
    expect(chk.raw).toMatchObject({ url: "https://www.mercadolivre.com.br/p/MLB111", status: "aplicado_agora" });

    const log = await logDe("JBL20");
    expect(log[0]).toMatchObject({ action: "test", ok: true, verdict: "valid", durationMs: 1234 });
    // Testado: sai da fila.
    expect((await autotest.pendentesCheckout()).itens).toEqual([]);
  });

  it("'não está mais disponível' → invalid, e o texto do ML fica guardado", async () => {
    await capturado("NAOEXISTE");
    const r = await autotest.registrarCheckout({ code: "NAOEXISTE", material: MATERIAL.indisponivel });
    expect(r.verdict).toBe("invalid");
    const log = await logDe("NAOEXISTE");
    expect(log[0]).toMatchObject({ action: "test", ok: false, verdict: "invalid" });
    expect(log[0].errorKind).toBeNull();
    expect(log[0].message).toContain("O cupom não está mais disponível.");
  });

  it("a rodada do servidor não testa mais palavra nenhuma", async () => {
    await capturado("JBL20");
    const checkWord = vi.spyOn(sync, "checkWord");
    await autotest.runOnce();
    expect(checkWord).not.toHaveBeenCalled();
  });
});

describe("cupom que valeu vira vínculo com o produto", () => {
  // A captura real da página de cupons (campanha 14167118, 25% OFF, mínimo R$ 25,
  // teto R$ 20). O modelo não traz o código: a campanha sai das condições do cartão.
  const htmlCupons = fs.readFileSync(path.resolve(__dirname, "..", "fixtures", "ml-checkout-cupons-iframe.html"), "utf8");
  const PRODUTO = "https://www.mercadolivre.com.br/porteiro/p/MLB12345";
  const valeu = (extra = {}) => ({
    finalUrl: PRODUTO,
    checkout: { reached: true }, modal: { aberto: true, campo: true },
    cartaoDepois: { texto: "Com CASA25\n25% OFF\nCompra mínima R$ 25 | Limite de R$ 20\nAplicado", aplicado: true },
    htmlCupons,
    ...extra,
  });

  beforeEach(async () => {
    await prisma().mlCouponProduct.deleteMany({});
    await prisma().catalogProduct.deleteMany({});
  });

  it("cria a campanha e liga ela ao produto testado", async () => {
    const r = await autotest.registrarCheckout({ code: "CASA25", url: "https://meli.la/abc", material: valeu() });

    expect(r.verdict).toBe("valid");
    expect(r.resultado.campaignId).toBe("14167118");
    expect(r.vinculo.vinculados).toBeGreaterThanOrEqual(1);
    expect(r.message).toMatch(/ligado ao produto/);

    const cupom = await prisma().mlCoupon.findUnique({ where: { campaignId: "14167118" } });
    expect(cupom).toMatchObject({ origin: "checkout", code: "CASA25" });
    const vinculos = await prisma().mlCouponProduct.findMany({ where: { campaignId: "14167118" } });
    expect(vinculos.length).toBeGreaterThanOrEqual(1);
    // A página final do ML, não o link de afiliado que chegou no grupo.
    expect(vinculos.every(v => v.origem === "checkout" && v.productUrl === PRODUTO)).toBe(true);
    expect((await logDe("CASA25"))[0].produtos).toBe(r.vinculo.vinculados);
  });

  // O que a extensão leu na PDP (cupom-checkout.js:naPagina_produto).
  const PDP = "https://produto.mercadolivre.com.br/MLB-5175399912-jogo-de-cama-king-_JM?searchVariation=1#polycard_client=x";
  const LIDO = { name: "Jogo De Cama King Percal 400 Fios", price: 359, originalPrice: 499.9, discount: 28, img: "https://http2.mlstatic.com/D_NQ_NP_1-O.webp", sold: "+1.000 vendidos" };

  it("produto fora do catálogo entra nele, já com o cupom", async () => {
    const r = await autotest.registrarCheckout({ code: "CASA25", material: valeu({ finalUrl: PDP, produto: LIDO }) });

    expect(r.vinculo.noCatalogo).toBe(true);
    expect(r.message).toMatch(/adicionado ao catálogo/);
    const linhas = await prisma().catalogProduct.findMany({ where: { mlAnuncioId: "MLB5175399912" } });
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toMatchObject({
      name: LIDO.name, price: 359, originalPrice: 499.9, discount: 28,
      store: "Mercado Livre", couponCampaignId: "14167118",
    });
  });

  it("produto que já está no catálogo não é duplicado nem reescrito, só ganha o cupom", async () => {
    const catalog = require(path.join(backendDir, "catalog", "pg.js"));
    // O mesmo anúncio, por outro link — como o scraping o teria gravado.
    await catalog.upsertProducts([{ name: "Nome do scraping", link: "https://produto.mercadolivre.com.br/MLB-5175399912-outro-slug-_JM", price: 400, store: "Mercado Livre", category: "casa" }]);

    const r = await autotest.registrarCheckout({ code: "CASA25", material: valeu({ finalUrl: PDP, produto: LIDO }) });

    expect(r.vinculo.noCatalogo).toBe(false);
    expect(r.message).toMatch(/ligado ao produto/);
    const linhas = await prisma().catalogProduct.findMany({ where: { mlAnuncioId: "MLB5175399912" } });
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toMatchObject({ name: "Nome do scraping", price: 400, category: "casa", couponCampaignId: "14167118" });
  });

  it("sem os dados do produto (extensão antiga) não cria linha no catálogo", async () => {
    const r = await autotest.registrarCheckout({ code: "CASA25", material: valeu({ finalUrl: PDP }) });
    expect(r.vinculo.noCatalogo).toBe(false);
    expect(await prisma().catalogProduct.count()).toBe(0);
  });

  it("vínculo de vitrine que já existia continua vitrine", async () => {
    await autotest.registrarCheckout({ code: "CASA25", material: valeu() });
    await prisma().mlCouponProduct.updateMany({ where: { campaignId: "14167118" }, data: { origem: "vitrine" } });

    await autotest.registrarCheckout({ code: "CASA25", material: valeu() });

    const vinculos = await prisma().mlCouponProduct.findMany({ where: { campaignId: "14167118" } });
    expect(vinculos.every(v => v.origem === "vitrine")).toBe(true);
  });

  it("cupom recusado não cria nada", async () => {
    const r = await autotest.registrarCheckout({ code: "CASA25", material: valeu({ cartaoDepois: null, erroCampo: "O cupom não está mais disponível." }) });
    expect(r.vinculo).toBeNull();
    expect(await prisma().mlCoupon.count()).toBe(0);
    expect(await prisma().mlCouponProduct.count()).toBe(0);
  });

  // Os outros produtos que o grupo mandou com o mesmo código (repasse/coupon-products.js).
  const DO_GRUPO = "https://produto.mercadolivre.com.br/MLB-4810869377-kit-3-calcas-legging-_JM";
  const capturaDoGrupo = (coupon, extra = {}) => prisma().repasseCaptureLog.create({
    data: {
      groupId: 1n, userId, waJid: "120363@g.us", rawUrl: "https://meli.la/2ZLewRA", resolvedUrl: DO_GRUPO,
      store: "Mercado Livre", coupon, outcome: "queued",
      productName: "Kit 3 Calças Legging", price: 89.9, originalPrice: 129.9, discount: 30, ...extra,
    },
  });

  it("aprovado: os outros produtos do repasse entram no catálogo ligados como 'repasse'", async () => {
    await capturaDoGrupo("CASA25");
    // Um link que não é produto não vira nada.
    await capturaDoGrupo("CASA25", { resolvedUrl: "https://www.mercadolivre.com.br/ofertas", productName: "Ofertas" });

    const r = await autotest.registrarCheckout({ code: "CASA25", url: "https://meli.la/abc", material: valeu() });

    expect(r.repasse).toMatchObject({ campaignId: "14167118", produtos: 1, noCatalogo: 1 });
    const produto = await prisma().catalogProduct.findFirst({ where: { mlAnuncioId: "MLB4810869377" } });
    expect(produto).toMatchObject({ name: "Kit 3 Calças Legging", price: 89.9, couponCampaignId: "14167118" });
    const vinculos = await prisma().mlCouponProduct.findMany({ where: { campaignId: "14167118" } });
    expect(vinculos.filter(v => v.productUrl === DO_GRUPO).every(v => v.origem === "repasse")).toBe(true);
    // O produto testado continua "checkout".
    expect(vinculos.filter(v => v.productUrl === PRODUTO).every(v => v.origem === "checkout")).toBe(true);
    expect(await prisma().catalogProduct.count({ where: { name: "Ofertas" } })).toBe(0);
  });

  it("a rodada do robô liga os produtos de código já aprovado cuja campanha está aqui", async () => {
    await palavraTestada("TEMAQUI", { verdict: "valid", campaignId: "555" });
    await prisma().mlCoupon.create({ data: { campaignId: "555", title: "10% OFF", containerUrl: "https://www.mercadolivre.com.br/cupons/_Container_555" } });
    await capturaDoGrupo("TEMAQUI");
    vi.spyOn(sync, "syncOneCoupon").mockResolvedValue({ produtos: 0 });

    const r = await autotest.runOnce();

    expect(r.produtosRepasse).toBe(1);
    const vinculos = await prisma().mlCouponProduct.findMany({ where: { campaignId: "555" } });
    expect(vinculos.length).toBeGreaterThanOrEqual(1);
    expect(vinculos.every(v => v.origem === "repasse")).toBe(true);
  });

  it("código aprovado com a campanha fora do sistema não liga nada ainda", async () => {
    await palavraTestada("FORA10", { verdict: "valid", campaignId: "556" });
    await capturaDoGrupo("FORA10");
    vi.spyOn(sync, "startImport").mockResolvedValue({ started: false });

    await autotest.runOnce();

    expect(await prisma().mlCouponProduct.count()).toBe(0);
    expect(await prisma().catalogProduct.count()).toBe(0);
  });

  it("valeu mas a campanha não foi achada: fica só a palavra", async () => {
    const r = await autotest.registrarCheckout({
      code: "OUTRO15",
      material: valeu({ cartaoDepois: { texto: "Com OUTRO15\n15% OFF\nCompra mínima R$ 59 | Limite de R$ 50", aplicado: true } }),
    });
    expect(r.verdict).toBe("valid");
    expect(r.vinculo).toBeNull();
    expect(await prisma().mlCouponProduct.count()).toBe(0);
  });
});

describe("o freio", () => {
  it("muro na fila automática pausa a fila e avisa o grupo de admin", async () => {
    const notifier = require(path.join(backendDir, "notifications", "admin-notifier.js"));
    const aviso = vi.spyOn(notifier, "notifyBlockDetected").mockResolvedValue();
    await capturado("P1000");
    await capturado("P2000");

    const r = await autotest.registrarCheckout({ code: "P1000", material: MATERIAL.captcha, source: "repasse-checkout-auto" });

    expect(r.verdict).toBe("indeterminado");
    expect(autotest.status().bloqueadoAte).toBeTruthy();
    expect(new Date(autotest.status().bloqueadoAte) > new Date()).toBe(true);
    expect(aviso).toHaveBeenCalledWith(expect.objectContaining({ motivo: "captcha" }));
    expect((await logDe("P1000"))[0].errorKind).toBe("captcha");
    // A fila continua à mostra, mas o automático fica parado até a pausa passar.
    const fila = await autotest.pendentesCheckout();
    expect(fila).toMatchObject({ auto: false, checkoutAuto: true });
    expect(fila.bloqueadoAte).toBeTruthy();
    expect(fila.itens.map(i => i.code)).toContain("P2000");
  });

  it("muro no botão Testar não pausa a fila — foi um pedido de quem está olhando", async () => {
    const notifier = require(path.join(backendDir, "notifications", "admin-notifier.js"));
    const aviso = vi.spyOn(notifier, "notifyBlockDetected").mockResolvedValue();
    await capturado("Q1000");
    await autotest.registrarCheckout({ code: "Q1000", material: MATERIAL.captcha, source: "repasse-checkout" });
    expect(autotest.status().bloqueadoAte).toBeNull();
    expect(aviso).not.toHaveBeenCalled();
  });

  it("com o automático desligado, a fila continua à mostra mas marcada como parada", async () => {
    await capturado("U1000");
    const cfgStore = require(path.join(backendDir, "repasse", "coupon-autotest-config.js"));
    vi.spyOn(cfgStore, "readConfig").mockReturnValue({ ...cfgStore.DEFAULTS, checkoutAuto: false });
    const fila = await autotest.pendentesCheckout();
    expect(fila).toMatchObject({ auto: false, checkoutAuto: false });
    expect(fila.itens.map(i => i.code)).toEqual(["U1000"]);
  });

  it("não roda junto com a rodada de cupons do admin", async () => {
    await capturado("R1000");
    sync.status.mockReturnValue({ running: true, importing: false });
    const checkWord = vi.spyOn(sync, "checkWord");

    const r = await autotest.runOnce();

    expect(r.skipped).toBe("rodada-em-curso");
    expect(checkWord).not.toHaveBeenCalled();
    // A rodada que desistiu também vira linha: é ela que responde "por que nada
    // aconteceu?" quando o admin abre a tela.
    const skips = (await autotestLog.listAutotestLog({ code: "-" })).items;
    expect(skips[0].message).toContain("rodada de cupons do admin");
  });

  it("não roda junto com uma busca de campanha em curso", async () => {
    await capturado("S1000");
    sync.status.mockReturnValue({ running: false, importing: true });
    const r = await autotest.runOnce();
    expect(r.skipped).toBe("import-em-curso");
  });

  it("sem cookie do ML explica no diário em vez de estourar a cada campanha", async () => {
    await capturado("T1000");
    affiliate.getScraperMLSession.mockReturnValue(null);

    const r = await autotest.runOnce();

    expect(r.skipped).toBe("sem-sessao");
    const skips = (await autotestLog.listAutotestLog({ code: "-" })).items;
    expect(skips[0].message).toContain("Admin › Mercado Livre");
  });

  it("desligado não roda; 'Rodar agora' roda mesmo desligado", async () => {
    await capturado("U1000");
    await palavraTestada("U1000", { verdict: "valid", campaignId: "555" });
    const cfgStore = require(path.join(backendDir, "repasse", "coupon-autotest-config.js"));
    vi.spyOn(cfgStore, "readConfig").mockReturnValue({ ...cfgStore.DEFAULTS, enabled: false });
    const startImport = vi.spyOn(sync, "startImport").mockResolvedValue({ already: true });

    expect((await autotest.runOnce()).skipped).toBe("desligado");
    expect(startImport).not.toHaveBeenCalled();

    // O botão da tela é um pedido explícito — serve pra conferir a config antes de ligar.
    await autotest.runOnce({ manual: true });
    expect(startImport).toHaveBeenCalledTimes(1);
  });
});

describe("trazer a campanha e a vitrine", () => {
  it("importa a campanha da palavra que valeu e ainda não está no sistema", async () => {
    await capturado("VALE10");
    await palavraTestada("VALE10", { verdict: "valid", campaignId: "777" });
    const startImport = vi.spyOn(sync, "startImport").mockResolvedValue({ started: true });
    vi.spyOn(sync, "importStatus").mockReturnValue({
      running: false, result: { ok: true, produtos: 34 }, error: null,
    });

    const r = await autotest.runOnce();

    expect(startImport).toHaveBeenCalledWith("777", { withProducts: true });
    expect(r.importados).toBe(1);
    const log = await logDe("VALE10");
    expect(log.find(l => l.action === "import")).toMatchObject({ ok: true, produtos: 34, campaignId: "777" });
  });

  it("raspa a vitrine da campanha que está aqui sem produto nenhum", async () => {
    await capturado("VITRINE");
    await palavraTestada("VITRINE", { verdict: "valid", campaignId: "888" });
    // A campanha existe no sistema, com a URL da vitrine, mas sem vínculo de
    // produto. Sem a URL quem vai é o "trazer campanha" (selecionar).
    await prisma().mlCoupon.create({ data: { campaignId: "888", title: "10% em casa", containerUrl: "https://www.mercadolivre.com.br/cupons/_Container_888" } });
    const syncOne = vi.spyOn(sync, "syncOneCoupon").mockResolvedValue({ produtos: 12 });

    const r = await autotest.runOnce();

    expect(syncOne).toHaveBeenCalledWith("888");
    expect(r.vitrines).toBe(1);
    expect((await logDe("VITRINE")).find(l => l.action === "vitrine")).toMatchObject({ ok: true, produtos: 12 });
  });

  it("a importação que falha vira linha de erro, não exceção", async () => {
    await capturado("FALHA10");
    await palavraTestada("FALHA10", { verdict: "valid", campaignId: "111" });
    vi.spyOn(sync, "startImport").mockRejectedValue(new Error("Tem uma rodada de cupons rodando"));

    const r = await autotest.runOnce();

    expect(r.importados).toBe(0);
    expect((await logDe("FALHA10"))[0]).toMatchObject({ action: "import", ok: false });
  });

  it("a campanha que já estava aqui não é buscada de novo", async () => {
    await capturado("PRONTO");
    await palavraTestada("PRONTO", { verdict: "valid", campaignId: "222" });
    await prisma().mlCoupon.create({ data: { campaignId: "222", title: "já aqui" } });
    await prisma().mlCouponProduct.create({
      data: { campaignId: "222", productKey: "ml:MLB1", productUrl: "https://mercadolivre.com.br/p/MLB1", origem: "vitrine" },
    });
    const startImport = vi.spyOn(sync, "startImport");
    const syncOne = vi.spyOn(sync, "syncOneCoupon");

    await autotest.runOnce();

    expect(startImport).not.toHaveBeenCalled();
    expect(syncOne).not.toHaveBeenCalled();
  });
});

describe("o diário", () => {
  it("lista do mais recente pro mais antigo e pagina", async () => {
    await capturado("D1000");
    await autotest.registrarCheckout({ code: "D1000", material: MATERIAL.indisponivel });
    await autotest.registrarCheckout({ code: "D1000", material: MATERIAL.indisponivel });

    const r = await autotestLog.listAutotestLog({ pageSize: 1 });
    expect(r.total).toBeGreaterThanOrEqual(2);
    expect(r.items).toHaveLength(1);
    // `id` é BigInt no banco: sem a conversão o JSON.stringify da rota explodiria.
    expect(typeof r.items[0].id).toBe("string");
  });

  it("filtra o histórico de um cupom só", async () => {
    await capturado("E1000");
    await capturado("F1000");
    await autotest.registrarCheckout({ code: "E1000", material: MATERIAL.indisponivel });

    expect(acoes(await logDe("E1000"))).toEqual(["test"]);
    expect(await logDe("NUNCAVISTO")).toEqual([]);
  });
});

// As rotas são finas, mas é nelas que um require errado ou uma variável fora de
// escopo se esconde — e o erro só apareceria com a tela aberta em produção.
describe("as rotas do admin", () => {
  it("GET devolve config, defaults e status juntos", async () => {
    const r = await adminReq("get", "/api/admin/repasse/coupon-autotest").expect(200);
    expect(r.body.config).toMatchObject({ enabled: expect.any(Boolean), maxPorRodada: expect.any(Number) });
    expect(r.body.defaults.maxPorRodada).toBeGreaterThan(0);
    expect(r.body.status).toHaveProperty("bloqueadoAte");
  });

  it("PUT salva já saneado e devolve o que foi gravado", async () => {
    const r = await adminReq("put", "/api/admin/repasse/coupon-autotest")
      .send({ maxPorRodada: 9999, enabled: false })
      .expect(200);
    // O corpo chega cru do formulário: o teto é o que impede uma rajada de Chrome.
    expect(r.body.config.maxPorRodada).toBeLessThan(9999);
    expect(r.body.config.enabled).toBe(false);
  });

  it("o log responde paginado, com o id serializável", async () => {
    await capturado("H1000");
    await autotest.registrarCheckout({ code: "H1000", material: MATERIAL.indisponivel });

    const r = await adminReq("get", "/api/admin/repasse/coupon-autotest/log?pageSize=5").expect(200);
    expect(r.body.total).toBeGreaterThan(0);
    expect(typeof r.body.items[0].id).toBe("string");
  });

  it("'Rodar agora' responde na hora, sem segurar a conexão", async () => {
    // A rodada abre Chrome (campanha, vitrine) e passa do timeout do proxy; a rota
    // dispara solta e responde 202.
    const r = await adminReq("post", "/api/admin/repasse/coupon-autotest/run").expect(202);
    expect(r.body.started).toBe(true);
  });

  it("a fila do checkout: pendentes → reivindicar (409 na segunda) → resultado", async () => {
    await capturado("ROTA10", { rawUrl: "https://www.mercadolivre.com.br/p/MLB222" });
    // O PUT acima gravou `enabled: false` na config de verdade.
    const cfgStore = require(path.join(backendDir, "repasse", "coupon-autotest-config.js"));
    vi.spyOn(cfgStore, "readConfig").mockReturnValue({ ...cfgStore.DEFAULTS, enabled: true });

    const p = await adminReq("get", "/api/admin/repasse/cupom-checkout/pendentes?limit=3").expect(200);
    expect(p.body.itens).toEqual([expect.objectContaining({ code: "ROTA10", url: "https://www.mercadolivre.com.br/p/MLB222" })]);

    await adminReq("post", "/api/admin/repasse/cupom-checkout/reivindicar").send({ code: "ROTA10" }).expect(200);
    await adminReq("post", "/api/admin/repasse/cupom-checkout/reivindicar").send({ code: "ROTA10" }).expect(409);

    const r = await adminReq("post", "/api/admin/repasse/cupom-checkout/resultado")
      .send({ code: "ROTA10", url: "https://www.mercadolivre.com.br/p/MLB222", material: MATERIAL.indisponivel, source: "repasse-checkout-auto" })
      .expect(200);
    expect(r.body).toMatchObject({ verdict: "invalid", source: "repasse-checkout-auto", resultado: { status: "falha", motivo: "indisponivel" } });
    expect(r.body.checkedAt).toBeTruthy();
  });

  it("o pedido manual pela rota: link fora do ML é 400; certo entra e sai com DELETE", async () => {
    const ruim = await adminReq("post", "/api/admin/repasse/cupom-checkout/manual")
      .send({ code: "VALE10", url: "https://www.amazon.com.br/dp/B0" }).expect(400);
    expect(ruim.body.error).toMatch(/Mercado Livre/);

    const ok = await adminReq("post", "/api/admin/repasse/cupom-checkout/manual")
      .send({ code: "vale10", url: "https://www.mercadolivre.com.br/p/MLB1" }).expect(200);
    expect(ok.body).toMatchObject({ origem: "manual", code: "VALE10" });

    await adminReq("delete", `/api/admin/repasse/cupom-checkout/manual/${ok.body.manualId}`).expect(200);
    await adminReq("delete", `/api/admin/repasse/cupom-checkout/manual/${ok.body.manualId}`).expect(404);
  });

  it("PUT auto liga e desliga o automático sem mexer no robô do servidor", async () => {
    const antes = (await adminReq("get", "/api/admin/repasse/coupon-autotest").expect(200)).body.config.enabled;
    const r = await adminReq("put", "/api/admin/repasse/cupom-checkout/auto").send({ auto: false }).expect(200);
    expect(r.body).toEqual({ checkoutAuto: false });
    const depois = (await adminReq("get", "/api/admin/repasse/coupon-autotest").expect(200)).body.config;
    expect(depois).toMatchObject({ checkoutAuto: false, enabled: antes });
    await adminReq("put", "/api/admin/repasse/cupom-checkout/auto").send({ auto: true }).expect(200);
  });

  it("resultado sem material é 400", async () => {
    await adminReq("post", "/api/admin/repasse/cupom-checkout/resultado").send({ code: "X" }).expect(400);
  });

  it("o log de captura diz se o cupom daquela linha foi validado", async () => {
    await capturado("SELO10");
    await palavraTestada("SELO10", { verdict: "invalid" });
    // E uma linha sem cupom nenhum, que não pode ganhar veredito de lugar nenhum.
    await capturado(null);

    const r = await adminReq("get", "/api/admin/repasse/logs?pageSize=50").expect(200);
    const comCupom = r.body.items.find(i => i.coupon === "SELO10");
    expect(comCupom.couponVerdict).toBe("invalid");
    expect(comCupom.couponCheckedAt).toBeTruthy();
    expect(r.body.items.find(i => i.coupon === null).couponVerdict).toBeNull();
  });
});
