// A rodada do robô que testa os cupons do repasse, de ponta a ponta — com o banco
// de verdade e o Mercado Livre mockado.
//
// O que estes testes protegem não é "o cupom foi testado": é o FREIO. O robô abre
// um Chrome com a conta do sistema por palavra, então uma rodada que não sabe
// parar não deixa a tela lenta, deixa a conta bloqueada — e aí o teste manual, que
// é o caminho que funcionava antes, para de funcionar também.
//
// Por isso os casos centrais aqui são: parar no primeiro CAPTCHA, não rodar junto
// com a rodada do admin, e gravar no diário o que aconteceu inclusive quando nada
// aconteceu. A parte que DECIDE (pura) fica em unit/repasse-coupon-autotest.test.js.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestUser, auth as authMod } from "../helpers/app.js";
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
async function capturado(coupon, { outcome = "queued", groupId = 1n } = {}) {
  await prisma().repasseCaptureLog.create({
    data: {
      groupId, userId, waJid: "120363@g.us",
      rawUrl: `https://mercadolivre.com.br/p/${Math.random()}`,
      coupon, outcome,
    },
  });
}

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

describe("a rodada testa as palavras novas", () => {
  it("testa o cupom nunca testado e registra o veredito no diário", async () => {
    await capturado("JBL20");
    const checkWord = vi.spyOn(sync, "checkWord").mockResolvedValue({
      word: "JBL20", verdict: "valid", campaignId: "42", message: null, coupon: { title: "20% em áudio" },
    });

    const r = await autotest.runOnce();

    expect(r.testados).toBe(1);
    // A origem é o que separa "o admin clicou" de "o robô testou" — é ela que faz
    // a aba escrever "(automático)" ao lado da data.
    expect(checkWord).toHaveBeenCalledWith("JBL20", { source: "repasse-auto" });

    const log = await logDe("JBL20");
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ action: "test", ok: true, verdict: "valid", campaignId: "42" });
    expect(log[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("registra o 'não reconheceu' como tentativa concluída, não como erro", async () => {
    // O cupom continua indo na mensagem do cliente; o valor desta linha é alguém
    // poder SABER que ele não vale.
    await capturado("NAOEXISTE");
    vi.spyOn(sync, "checkWord").mockResolvedValue({
      verdict: "invalid", campaignId: null, message: "Confira se o cupom está correto",
    });

    await autotest.runOnce();

    const log = await logDe("NAOEXISTE");
    expect(log[0]).toMatchObject({ action: "test", ok: false, verdict: "invalid" });
    expect(log[0].errorKind).toBeNull();
    expect(log[0].message).toContain("Confira se o cupom");
  });

  it("não testa de novo a palavra que o ML já recusou", async () => {
    await capturado("NAOEXISTE");
    await palavraTestada("NAOEXISTE", { verdict: "invalid", horasAtras: 500 });
    const checkWord = vi.spyOn(sync, "checkWord");

    const r = await autotest.runOnce();

    expect(checkWord).not.toHaveBeenCalled();
    expect(r.testados).toBe(0);
  });

  it("respeita o teto de palavras por rodada", async () => {
    for (const c of ["A1000", "B1000", "C1000", "D1000"]) await capturado(c);
    const checkWord = vi.spyOn(sync, "checkWord").mockResolvedValue({ verdict: "invalid" });

    await autotest.runOnce();

    // O default é 5; aqui o que se confirma é que as 4 couberam e nenhuma repetiu.
    expect(checkWord).toHaveBeenCalledTimes(4);
  });

  it("uma exceção numa palavra não derruba a rodada", async () => {
    await capturado("QUEBRA");
    await capturado("SEGUE");
    const checkWord = vi.spyOn(sync, "checkWord").mockImplementation(async (code) => {
      if (code === "QUEBRA") throw new Error("dados insuficientes");
      return { verdict: "invalid" };
    });

    const r = await autotest.runOnce();

    expect(checkWord).toHaveBeenCalledTimes(2);
    expect(r.testados).toBe(1);
    const log = await logDe("QUEBRA");
    expect(log[0]).toMatchObject({ action: "test", ok: false });
    expect(log[0].errorKind).toBeTruthy();
  });
});

describe("o freio", () => {
  it("para na primeira parede do ML e arma o breaker", async () => {
    for (const c of ["P1000", "P2000", "P3000"]) await capturado(c);
    const checkWord = vi.spyOn(sync, "checkWord").mockResolvedValue({
      verdict: "indeterminado", message: "Página de CAPTCHA do Mercado Livre",
    });

    await autotest.runOnce();

    // A segunda palavra levaria o mesmo CAPTCHA, e cada tentativa é um Chrome novo.
    expect(checkWord).toHaveBeenCalledTimes(1);
    expect(autotest.status().bloqueadoAte).toBeTruthy();
    expect(new Date(autotest.status().bloqueadoAte) > new Date()).toBe(true);

    // E o diário explica a parada, senão a tela mostraria "1 testada" sem motivo.
    const skips = (await autotestLog.listAutotestLog({ code: "-" })).items;
    expect(skips[0].errorKind).toBe("captcha");
    expect(skips[0].message).toContain("barrou");
  });

  it("com o breaker armado, a rodada seguinte não abre navegador nenhum", async () => {
    await capturado("Q1000");
    vi.spyOn(sync, "checkWord").mockResolvedValue({
      verdict: "indeterminado", message: "Página de CAPTCHA do Mercado Livre",
    });
    await autotest.runOnce();

    const checkWord = vi.spyOn(sync, "checkWord").mockResolvedValue({ verdict: "valid" });
    const r = await autotest.runOnce();

    expect(r.skipped).toBe("bloqueado");
    expect(checkWord).not.toHaveBeenCalled();
    expect(autotest.status().pulada).toContain("barrou");
  });

  it("'Rodar agora' fura o bloqueio — é um pedido explícito de quem vê o aviso", async () => {
    await capturado("X1000");
    vi.spyOn(sync, "checkWord").mockResolvedValue({
      verdict: "indeterminado", message: "Página de CAPTCHA do Mercado Livre",
    });
    await autotest.runOnce();
    expect(autotest.status().bloqueadoAte).toBeTruthy();

    const checkWord = vi.spyOn(sync, "checkWord").mockResolvedValue({ verdict: "valid" });
    await autotest.runOnce({ manual: true });

    expect(checkWord).toHaveBeenCalledTimes(1);
    expect(autotest.status().bloqueadoAte).toBeNull();
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

  it("sem cookie do ML explica no diário em vez de estourar palavra por palavra", async () => {
    await capturado("T1000");
    affiliate.getScraperMLSession.mockReturnValue(null);
    const checkWord = vi.spyOn(sync, "checkWord");

    const r = await autotest.runOnce();

    expect(r.skipped).toBe("sem-sessao");
    expect(checkWord).not.toHaveBeenCalled();
    const skips = (await autotestLog.listAutotestLog({ code: "-" })).items;
    expect(skips[0].message).toContain("Admin › Mercado Livre");
  });

  it("desligado não roda; 'Rodar agora' roda mesmo desligado", async () => {
    await capturado("U1000");
    const cfgStore = require(path.join(backendDir, "repasse", "coupon-autotest-config.js"));
    vi.spyOn(cfgStore, "readConfig").mockReturnValue({ ...cfgStore.DEFAULTS, enabled: false });
    const checkWord = vi.spyOn(sync, "checkWord").mockResolvedValue({ verdict: "invalid" });

    expect((await autotest.runOnce()).skipped).toBe("desligado");
    expect(checkWord).not.toHaveBeenCalled();

    // O botão da tela é um pedido explícito — serve pra conferir a config antes de ligar.
    await autotest.runOnce({ manual: true });
    expect(checkWord).toHaveBeenCalledTimes(1);
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
    // A campanha existe no sistema, mas sem vínculo de produto.
    await prisma().mlCoupon.create({ data: { campaignId: "888", title: "10% em casa" } });
    const syncOne = vi.spyOn(sync, "syncOneCoupon").mockResolvedValue({ produtos: 12 });

    const r = await autotest.runOnce();

    expect(syncOne).toHaveBeenCalledWith("888");
    expect(r.vitrines).toBe(1);
    expect((await logDe("VITRINE")).find(l => l.action === "vitrine")).toMatchObject({ ok: true, produtos: 12 });
  });

  it("uma parede no teste cancela o trabalho pesado da rodada", async () => {
    // Importar é mais Chrome e mais longo; insistir depois de um CAPTCHA é o
    // caminho mais curto pra queimar a conta.
    await capturado("W1000");
    await capturado("VALE20");
    await palavraTestada("VALE20", { verdict: "valid", campaignId: "999" });
    vi.spyOn(sync, "checkWord").mockResolvedValue({
      verdict: "indeterminado", message: "Página de CAPTCHA do Mercado Livre",
    });
    const startImport = vi.spyOn(sync, "startImport").mockResolvedValue({ started: true });

    await autotest.runOnce();

    expect(startImport).not.toHaveBeenCalled();
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
    vi.spyOn(sync, "checkWord").mockResolvedValue({ verdict: "invalid" });
    await autotest.runOnce();
    await autotest.runOnce();

    const r = await autotestLog.listAutotestLog({ pageSize: 1 });
    expect(r.total).toBeGreaterThanOrEqual(2);
    expect(r.items).toHaveLength(1);
    // `id` é BigInt no banco: sem a conversão o JSON.stringify da rota explodiria.
    expect(typeof r.items[0].id).toBe("string");
  });

  it("filtra o histórico de um cupom só", async () => {
    await capturado("E1000");
    await capturado("F1000");
    vi.spyOn(sync, "checkWord").mockResolvedValue({ verdict: "invalid" });
    await autotest.runOnce();

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
    vi.spyOn(sync, "checkWord").mockResolvedValue({ verdict: "invalid" });
    await autotest.runOnce({ manual: true });

    const r = await adminReq("get", "/api/admin/repasse/coupon-autotest/log?pageSize=5").expect(200);
    expect(r.body.total).toBeGreaterThan(0);
    expect(typeof r.body.items[0].id).toBe("string");
  });

  it("'Rodar agora' responde na hora, sem segurar a conexão", async () => {
    // A rodada abre um Chrome por palavra e passa do timeout do proxy; a rota
    // dispara solta e responde 202.
    vi.spyOn(sync, "checkWord").mockResolvedValue({ verdict: "invalid" });
    const r = await adminReq("post", "/api/admin/repasse/coupon-autotest/run").expect(202);
    expect(r.body.started).toBe(true);
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
