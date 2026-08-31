// Os cupons capturados pelo repasse, agregados por código — o que alimenta a aba
// Admin › Cupom › Repasse.
//
// O log de captura tem uma linha por LINK: o mesmo código aparece dezenas de
// vezes, em campanhas e contas diferentes. O que a tela precisa é o contrário —
// um código por linha, com o que o sistema sabe dele. É essa dobra, e o cruzamento
// com o dicionário palavra → campanha, que estes testes protegem.
//
// O cuidado que se repete aqui: "nunca testado" (verdict null) é um estado
// próprio. Confundi-lo com "o ML não reconheceu" faria a tela mandar descartar
// cupom bom.

import { describe, it, expect, beforeEach } from "vitest";
import { createTestUser, auth as authMod } from "../helpers/app.js";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const backendDir = path.resolve(__dirname, "..", "..", "backend");
const coupons = require(path.join(backendDir, "coupons"));
const repasseCoupons = require(path.join(backendDir, "repasse", "coupons.js"));
const { prisma } = require(path.join(backendDir, "db.js"));

const diasAtras = (n) => new Date(Date.now() - n * 86400000);

let userId;

// Uma linha do log de captura. Só os campos que a agregação lê; o resto do
// pipeline não interessa aqui.
async function capturado(coupon, { groupId = 1n, outcome = "queued", quando = new Date(), user = userId } = {}) {
  await prisma().repasseCaptureLog.create({
    data: {
      groupId, userId: user, waJid: "120363@g.us",
      rawUrl: `https://mercadolivre.com.br/p/${Math.random()}`,
      coupon, outcome, createdAt: quando,
    },
  });
}

const acha = (r, code) => r.items.find(i => i.code === code);

beforeEach(async () => {
  await prisma().repasseCaptureLog.deleteMany({});
  const u = await createTestUser();
  await authMod.setUserRole(u.user.id, "admin");
  userId = u.user.id;
});

describe("cupons capturados pelo repasse", () => {
  it("agrega o log por código: capturas, período, campanhas e quantas foram pra fila", async () => {
    await capturado("JBL20", { groupId: 1n, quando: diasAtras(10) });
    await capturado("JBL20", { groupId: 2n, quando: diasAtras(2) });
    await capturado("JBL20", { groupId: 2n, outcome: "discarded", quando: diasAtras(1) });
    // Mensagem sem cupom: não pode virar linha nenhuma.
    await capturado(null);

    const r = await repasseCoupons.listCapturedCoupons({});
    expect(r.items).toHaveLength(1);

    const jbl = r.items[0];
    expect(jbl.code).toBe("JBL20");
    expect(jbl.capturas).toBe(3);
    expect(jbl.campanhas).toBe(2);
    expect(jbl.usuarios).toBe(1);
    // Só `queued`/`pending` contam: das três capturas, uma foi descartada e a
    // tela não pode contá-la como produto que entrou.
    expect(jbl.aproveitados).toBe(2);
    expect(new Date(jbl.primeira) < new Date(jbl.ultima)).toBe(true);
  });

  it("cupom nunca testado vem com verdict null — não com 'invalid'", async () => {
    await capturado("NUNCATESTADO");
    const r = await repasseCoupons.listCapturedCoupons({});
    expect(acha(r, "NUNCATESTADO").verdict).toBeNull();
    expect(acha(r, "NUNCATESTADO").inSystem).toBeNull();
  });

  it("cruza com o dicionário de palavras: veredito, campanha e se ela está no sistema", async () => {
    await capturado("TEMCAMPANHA");
    await capturado("SOAPALAVRA");
    await coupons.recordCodeCheck({ code: "TEMCAMPANHA", verdict: "valid", campaignId: "9920001", source: "repasse" });
    await coupons.recordCodeCheck({ code: "SOAPALAVRA", verdict: "valid", campaignId: "9920099" });
    await coupons.upsertCoupons([{ campaignId: "9920001", title: "20% JBL", kind: "percent", value: 20, scope: "campaign" }]);

    const r = await repasseCoupons.listCapturedCoupons({});

    const comCampanha = acha(r, "TEMCAMPANHA");
    expect(comCampanha.verdict).toBe("valid");
    expect(comCampanha.campaignId).toBe("9920001");
    expect(comCampanha.couponTitle).toBe("20% JBL");
    expect(comCampanha.inSystem).toBe(true);
    expect(comCampanha.source).toBe("repasse");

    // A palavra resolveu, mas a campanha nunca foi raspada pra cá: é a fila de
    // trabalho da tela ("trazer campanha"), e depende deste false.
    expect(acha(r, "SOAPALAVRA").inSystem).toBe(false);
  });

  it("conta os produtos da campanha — é o que separa 'integrada' de só cadastrada", async () => {
    await capturado("COMVITRINE");
    await coupons.recordCodeCheck({ code: "COMVITRINE", verdict: "valid", campaignId: "9920002" });
    await coupons.upsertCoupons([{ campaignId: "9920002", title: "Vitrine", kind: "percent", value: 10, scope: "campaign" }]);
    await coupons.replaceCouponProducts("9920002", [
      { productKey: "k1", productUrl: "https://mercadolivre.com.br/p/1" },
      { productKey: "k2", productUrl: "https://mercadolivre.com.br/p/2" },
    ], { origem: "vitrine" });

    const r = await repasseCoupons.listCapturedCoupons({});
    expect(acha(r, "COMVITRINE").produtos).toBe(2);
  });

  it("filtra por situação, e o total do período continua visível", async () => {
    await capturado("VIRGEM");
    await capturado("VALIDA");
    await capturado("RECUSADA");
    await coupons.recordCodeCheck({ code: "VALIDA", verdict: "valid", campaignId: "9920003" });
    await coupons.recordCodeCheck({ code: "RECUSADA", verdict: "invalid" });

    const naoTestados = await repasseCoupons.listCapturedCoupons({ status: "nao-testado" });
    expect(naoTestados.items.map(i => i.code)).toEqual(["VIRGEM"]);
    // O universo do período não muda com o filtro — é o que dá sentido ao
    // "1 de 3" na tela.
    expect(naoTestados.totalCapturados).toBe(3);

    const invalidos = await repasseCoupons.listCapturedCoupons({ status: "invalid" });
    expect(invalidos.items.map(i => i.code)).toEqual(["RECUSADA"]);

    // "valid mas fora do sistema": VALIDA aponta uma campanha que ninguém raspou.
    const semCampanha = await repasseCoupons.listCapturedCoupons({ status: "sem-campanha" });
    expect(semCampanha.items.map(i => i.code)).toEqual(["VALIDA"]);
  });

  it("respeita o período e o filtro por código", async () => {
    await capturado("VELHO", { quando: diasAtras(120) });
    await capturado("NOVO", { quando: diasAtras(3) });

    const noventa = await repasseCoupons.listCapturedCoupons({ days: 90 });
    expect(noventa.items.map(i => i.code)).toEqual(["NOVO"]);

    const tudo = await repasseCoupons.listCapturedCoupons({ days: "tudo" });
    expect(tudo.items.map(i => i.code).sort()).toEqual(["NOVO", "VELHO"]);

    const busca = await repasseCoupons.listCapturedCoupons({ days: "tudo", q: "vel" });
    expect(busca.items.map(i => i.code)).toEqual(["VELHO"]);
  });

  it("pagina, e ordena do visto mais recente pro mais antigo", async () => {
    await capturado("C1", { quando: diasAtras(3) });
    await capturado("C2", { quando: diasAtras(2) });
    await capturado("C3", { quando: diasAtras(1) });

    const p1 = await repasseCoupons.listCapturedCoupons({ pageSize: 2 });
    expect(p1.items.map(i => i.code)).toEqual(["C3", "C2"]);
    expect(p1.total).toBe(3);

    const p2 = await repasseCoupons.listCapturedCoupons({ pageSize: 2, page: 2 });
    expect(p2.items.map(i => i.code)).toEqual(["C1"]);
  });
});

// "Excluir" aqui é ESQUECER o código, não apagar a captura: a linha do log fica
// inteira (é dela que saem as estatísticas do repasse), só a coluna `coupon` vai
// a null. E a palavra já testada sobrevive — ela custou um Chrome aberto com a
// conta do ML. É essa distinção que estes testes seguram.
describe("esquecer cupons capturados", () => {
  it("zera o código em TODAS as capturas dele, sem tocar na linha nem nas outras", async () => {
    // Uma captura fora da janela de 90 dias: se a limpeza respeitasse período, a
    // linha voltaria pra tela remontada por esta, e o botão pareceria não funcionar.
    await capturado("LIXO", { quando: diasAtras(200) });
    await capturado("LIXO", { outcome: "discarded" });
    await capturado("BOM");

    const r = await repasseCoupons.forgetCoupons(["lixo"]);
    expect(r).toEqual({ cupons: 1, capturas: 2 });

    expect(await repasseCoupons.listCapturedCoupons({ days: "tudo" }))
      .toMatchObject({ items: [{ code: "BOM" }], total: 1 });

    // Nenhuma linha some do log, e o que não é cupom continua lá.
    const linhas = await prisma().repasseCaptureLog.findMany({ orderBy: { createdAt: "asc" } });
    expect(linhas).toHaveLength(3);
    expect(linhas.map(l => l.coupon)).toEqual([null, null, "BOM"]);
    expect(linhas.every(l => l.rawUrl && l.outcome)).toBe(true);
  });

  it("a palavra já testada continua no dicionário", async () => {
    await capturado("TESTADA");
    await coupons.recordCodeCheck({ code: "TESTADA", verdict: "valid", campaignId: "9930001", source: "repasse" });

    await repasseCoupons.forgetCoupons(["TESTADA"]);

    const chk = await prisma().mlCouponCode.findUnique({ where: { code: "TESTADA" } });
    expect(chk).toMatchObject({ verdict: "valid", campaignId: "9930001" });
  });

  it("código que ninguém capturou não é erro, é zero", async () => {
    expect(await repasseCoupons.forgetCoupons(["NAOEXISTE"])).toEqual({ cupons: 1, capturas: 0 });
    expect(await repasseCoupons.forgetCoupons([])).toEqual({ cupons: 0, capturas: 0 });
    expect(await repasseCoupons.forgetCoupons(["  ", null])).toEqual({ cupons: 0, capturas: 0 });
  });

  it("a limpeza filtrada apaga exatamente o que o mesmo filtro listava", async () => {
    await capturado("RECUSADA");
    await capturado("VALIDA");
    await capturado("NUNCATESTADA");
    await coupons.recordCodeCheck({ code: "RECUSADA", verdict: "invalid" });
    await coupons.recordCodeCheck({ code: "VALIDA", verdict: "valid", campaignId: "9930002" });

    const filtro = { days: "tudo", status: "invalid" };
    const antes = await repasseCoupons.listCapturedCoupons(filtro);
    expect(antes.items.map(i => i.code)).toEqual(["RECUSADA"]);

    expect(await repasseCoupons.forgetFiltered(filtro)).toEqual({ cupons: 1, capturas: 1 });

    const depois = await repasseCoupons.listCapturedCoupons({ days: "tudo" });
    expect(depois.items.map(i => i.code).sort()).toEqual(["NUNCATESTADA", "VALIDA"]);
  });

  it("a limpeza respeita a busca por código e o período", async () => {
    await capturado("JBL20");
    await capturado("JBL50");
    await capturado("SONY10");
    await capturado("ANTIGO", { quando: diasAtras(200) });

    expect(await repasseCoupons.forgetFiltered({ days: "tudo", q: "jbl" }))
      .toEqual({ cupons: 2, capturas: 2 });

    // O período recorta QUEM entra na limpeza: o ANTIGO está fora dos 90 dias.
    expect(await repasseCoupons.forgetFiltered({ days: 90 })).toEqual({ cupons: 1, capturas: 1 });

    const sobrou = await repasseCoupons.listCapturedCoupons({ days: "tudo" });
    expect(sobrou.items.map(i => i.code)).toEqual(["ANTIGO"]);
  });
});

describe("rotas de cupom do repasse", () => {
  it("lista pela API, e o log aceita filtrar por um cupom só", async () => {
    const admin = await createTestUser();
    await authMod.setUserRole(admin.user.id, "admin");
    await capturado("JBL20", { user: admin.user.id });
    await capturado("OUTRO", { user: admin.user.id });

    const r = await admin.auth("get", "/api/admin/repasse/coupons?days=tudo");
    expect(r.status).toBe(200);
    expect(r.body.items.map(i => i.code).sort()).toEqual(["JBL20", "OUTRO"]);

    // O mesmo filtro que a tela usa ao expandir uma linha.
    const logs = await admin.auth("get", "/api/admin/repasse/logs?coupon=jbl20");
    expect(logs.status).toBe(200);
    expect(logs.body.items).toHaveLength(1);
    expect(logs.body.items[0].coupon).toBe("JBL20");
  });

  it("user comum não vê os cupons do repasse", async () => {
    const { auth } = await createTestUser();
    const r = await auth("get", "/api/admin/repasse/coupons");
    expect(r.status).toBe(403);
  });

  it("exclui um cupom e limpa a lista filtrada pela API", async () => {
    const admin = await createTestUser();
    await authMod.setUserRole(admin.user.id, "admin");
    await capturado("JBL20", { user: admin.user.id });
    await capturado("SONY10", { user: admin.user.id });
    await capturado("LG5", { user: admin.user.id });

    // O código chega em minúsculo da URL e é normalizado, como no filtro do log.
    const um = await admin.auth("delete", "/api/admin/repasse/coupons/jbl20");
    expect(um.status).toBe(200);
    expect(um.body).toMatchObject({ ok: true, code: "JBL20", capturas: 1 });

    const todos = await admin.auth("delete", "/api/admin/repasse/coupons?days=tudo");
    expect(todos.status).toBe(200);
    expect(todos.body).toMatchObject({ ok: true, cupons: 2, capturas: 2 });

    const resta = await admin.auth("get", "/api/admin/repasse/coupons?days=tudo");
    expect(resta.body.items).toEqual([]);
  });

  it("user comum não apaga cupom do repasse", async () => {
    const { auth } = await createTestUser();
    expect((await auth("delete", "/api/admin/repasse/coupons/JBL20")).status).toBe(403);
    expect((await auth("delete", "/api/admin/repasse/coupons")).status).toBe(403);
  });
});
