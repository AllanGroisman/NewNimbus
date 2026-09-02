// Apagar todos os cupons: o que some e, principalmente, o que NÃO some.
//
// A promessa do botão é que as PALAVRAS testadas sobrevivem — cada uma custou um
// Chrome aberto com a conta do sistema. Se isso quebrar, o prejuízo só aparece
// horas depois, quando alguém for testar a mesma palavra de novo.

import { describe, it, expect, beforeEach } from "vitest";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { catalog } from "../helpers/app.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const backendDir = path.resolve(__dirname, "..", "..", "backend");
const coupons = require(path.join(backendDir, "coupons"));
const { productKey } = require(path.join(backendDir, "catalog", "product-key"));

const CAMPANHA = "9900001";
const PALAVRA = `TESTE${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
const produto = {
  name: "Produto do cupom", link: "https://www.mercadolivre.com.br/produto/p/MLB7770001",
  store: "Mercado Livre", category: "gamer", price: 100, discount: 40,
};

async function semear() {
  await catalog.upsertProducts([produto]);
  await coupons.upsertCoupons([{
    campaignId: CAMPANHA, title: "20% OFF TESTE", kind: "percent", value: 20,
    scope: "campaign", containerUrl: "https://lista.mercadolivre.com.br/_Container_9900001",
    activated: true, expiresAt: new Date(Date.now() + 864e5).toISOString(),
  }]);
  await coupons.replaceCouponProducts(CAMPANHA, [{ productKey: productKey(produto), productUrl: produto.link }]);
  await coupons.syncCatalogCoupons();
}

describe("clearAll — apagar todos os cupons", () => {
  // Semeia a cada teste: o `truncateAll` do setup roda antes de CADA um.
  beforeEach(async () => {
    await semear();
    await coupons.recordCodeCheck({ code: PALAVRA, verdict: "valid", campaignId: CAMPANHA, source: "admin" });
  });

  it("a semeadura vale: cupom, vínculo e carimbo no catálogo", async () => {
    const s = await coupons.stats();
    expect(s.cupons).toBeGreaterThan(0);
    expect(s.vinculos).toBeGreaterThan(0);
    expect(s.catalogo).toBeGreaterThan(0);
  });

  it("apaga cupons, vínculos e o carimbo — e mantém as palavras testadas", async () => {
    const r = await coupons.clearAll();
    expect(r.cupons).toBeGreaterThan(0);
    expect(r.vinculos).toBeGreaterThan(0);

    const s = await coupons.stats();
    expect(s.cupons).toBe(0);
    expect(s.vinculos).toBe(0);
    // O carimbo é coluna solta em catalog_products, sem FK: se a purga não o
    // limpasse, sobrariam produtos apontando pra cupom que não existe mais.
    expect(s.catalogo).toBe(0);

    const palavras = await coupons.listCodeChecks({ limit: 50 });
    expect(palavras.some(p => p.code === PALAVRA)).toBe(true);
  });

  it("a palavra volta a carimbar o cupom quando ele é re-raspado", async () => {
    await coupons.clearAll();
    await coupons.upsertCoupons([{ campaignId: CAMPANHA, title: "20% OFF TESTE", kind: "percent", value: 20, scope: "campaign" }]);
    expect((await coupons.getCoupon(CAMPANHA)).code).toBe(null);

    const r = await coupons.restampCodesFromChecks();
    expect(r.recarimbados).toBeGreaterThan(0);
    expect((await coupons.getCoupon(CAMPANHA)).code).toBe(PALAVRA);
  });
});

// A palavra pode apontar para uma campanha que nunca foi raspada — o ML responde o
// id da campanha, e não existe FK entre `ml_coupon_codes` e `ml_coupons`. É esse
// buraco que a tela oferece preencher ("buscar e adicionar esta campanha"), e ela
// precisa saber quais palavras estão nessa situação.
describe("listCodeChecks — quais palavras apontam para campanha que falta", () => {
  const ORFA = "9900002";
  const PALAVRA_ORFA = `ORFA${crypto.randomBytes(3).toString("hex").toUpperCase()}`;

  beforeEach(async () => {
    await semear();
    await coupons.recordCodeCheck({ code: PALAVRA, verdict: "valid", campaignId: CAMPANHA, source: "admin" });
    await coupons.recordCodeCheck({ code: PALAVRA_ORFA, verdict: "valid", campaignId: ORFA, source: "admin" });
  });

  it("campanha no sistema vem com inSystem e título; a que falta vem false", async () => {
    const palavras = await coupons.listCodeChecks({ limit: 50 });

    const daCampanha = palavras.find(p => p.code === PALAVRA);
    expect(daCampanha.inSystem).toBe(true);
    expect(daCampanha.couponTitle).toBe("20% OFF TESTE");

    const orfa = palavras.find(p => p.code === PALAVRA_ORFA);
    expect(orfa.inSystem).toBe(false);
    expect(orfa.couponTitle).toBe(null);
  });

  it("depois que a campanha entra, a mesma palavra passa a inSystem", async () => {
    await coupons.upsertCoupons([{ campaignId: ORFA, title: "Campanha achada pela palavra", kind: "percent", value: 15 }], { origin: "code" });

    const orfa = (await coupons.listCodeChecks({ limit: 50 })).find(p => p.code === PALAVRA_ORFA);
    expect(orfa.inSystem).toBe(true);
    expect(orfa.couponTitle).toBe("Campanha achada pela palavra");
  });

  it("palavra sem campanha nenhuma não vira 'falta a campanha'", async () => {
    const invalida = `NADA${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
    await coupons.recordCodeCheck({ code: invalida, verdict: "invalid", campaignId: null, source: "admin" });

    const linha = (await coupons.listCodeChecks({ limit: 50 })).find(p => p.code === invalida);
    expect(linha.inSystem).toBe(null);
  });
});

// A busca de UMA campanha e a rodada disputam a MESMA conta do ML. Dois Chromes
// nela ao mesmo tempo dobram a chance de CAPTCHA — e o CAPTCHA vale pra conta,
// então derruba o Hub junto. Uma tem que recusar a outra, nos dois sentidos.
describe("startImport — a guarda contra dois Chromes na mesma conta", () => {
  const mlCupons = require(path.join(backendDir, "coupons", "sync.js"));
  const scraping = require(path.join(backendDir, "scraping", "ml-cupons.js"));

  it("recusa quando uma varredura de cupons está em andamento", async () => {
    // A varredura vive no Chrome do admin (startLocalRun): é ela, e não mais um
    // Puppeteer do servidor, que disputa a conta do ML com a busca de campanha.
    mlCupons.startLocalRun({});
    try {
      await expect(mlCupons.startImport("9900003")).rejects.toThrow(/rodada de cupons rodando/i);
    } finally {
      mlCupons.fimLocalRun({ cancelada: true });
    }
  });

  it("campanha que já está no sistema volta na hora, sem abrir navegador", async () => {
    await semear();
    const r = await mlCupons.startImport(CAMPANHA);

    expect(r.already).toBe(true);
    expect(r.coupon.campaignId).toBe(CAMPANHA);
    // Não disparou busca nenhuma: nada para acompanhar.
    expect(mlCupons.importStatus().running).toBe(false);
  });

  it("sem campanha não dispara nada", async () => {
    await expect(mlCupons.startImport("  ")).rejects.toThrow(/Sem campanha/i);
  });

  // A caixa "Trazer campanha por ID" da aba "Cupons do ML" deixa digitar o número à
  // mão, e um typo aqui não erra rápido: sem a guarda, o `findCampaign` varre as 40
  // páginas da lista navegando com a conta do sistema para não achar nada.
  it("id que não é número recusa na hora, sem abrir navegador", async () => {
    await expect(mlCupons.startImport("13495993x")).rejects.toThrow(/só tem dígitos/i);
    await expect(mlCupons.startImport("BRINQUEDOS")).rejects.toThrow(/só tem dígitos/i);
    expect(mlCupons.importStatus().running).toBe(false);
  });

  it("o status começa limpo e é o que a tela lê", () => {
    const s = mlCupons.importStatus();
    expect(s).toHaveProperty("running");
    expect(s).toHaveProperty("progress");
    expect(s).toHaveProperty("result");
    expect(s).toHaveProperty("error");
  });
});

// O dicionário palavra → campanha é a única cópia dessa informação: a página do ML
// não lista palavra nenhuma. Um engasgo do ML ("Tivemos um problema") já chegou a
// apagar uma linha boa — BRINCADEIRAS perdeu a campanha 13471229 e passou a
// aparecer na tela como "o ML não reconheceu".
describe("o dicionário de palavras sobrevive a um engasgo do ML", () => {
  const PALAVRA_BOA = `BOA${crypto.randomBytes(3).toString("hex").toUpperCase()}`;

  beforeEach(async () => {
    await semear();
  });

  it("indeterminado não apaga a campanha que a palavra já tinha", async () => {
    await coupons.recordCodeCheck({ code: PALAVRA_BOA, verdict: "valid", campaignId: CAMPANHA, source: "admin" });

    await coupons.recordCodeCheck({
      code: PALAVRA_BOA, verdict: "indeterminado", campaignId: null,
      message: "Tivemos um problema", source: "admin",
      raw: { responseMessage: { text: "Tivemos um problema", type: "error" } },
    });

    const linha = (await coupons.listCodeChecks({ limit: 50 })).find(p => p.code === PALAVRA_BOA);
    expect(linha.verdict).toBe("valid");
    expect(linha.campaignId).toBe(CAMPANHA);
    // A tentativa continua contada: o engasgo não some do histórico, só não manda.
    expect(linha.checkCount).toBe(2);
  });

  it("um veredito de verdade continua sobrescrevendo o anterior", async () => {
    await coupons.recordCodeCheck({ code: PALAVRA_BOA, verdict: "valid", campaignId: CAMPANHA, source: "admin" });
    await coupons.recordCodeCheck({
      code: PALAVRA_BOA, verdict: "invalid", campaignId: null,
      message: "Confira se o cupom está correto", responseCode: "INVALID_1", source: "admin",
    });

    const linha = (await coupons.listCodeChecks({ limit: 50 })).find(p => p.code === PALAVRA_BOA);
    expect(linha.verdict).toBe("invalid");
    expect(linha.campaignId).toBe(null);
  });

  it("engasgo não fica em cache: a próxima tentativa vai ao ML de novo", async () => {
    const nova = `NOVA${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
    await coupons.recordCodeCheck({ code: nova, verdict: "indeterminado", campaignId: null, source: "admin" });
    expect(await coupons.findCodeCheck(nova, { maxAgeHours: 12 })).toBe(null);

    // O contraste: veredito de verdade continua servindo do cache.
    await coupons.recordCodeCheck({ code: nova, verdict: "invalid", campaignId: null, responseCode: "INVALID_1", source: "admin" });
    expect((await coupons.findCodeCheck(nova, { maxAgeHours: 12 }))?.verdict).toBe("invalid");
  });

  it("recoverCodesFromCoupons devolve à palavra a campanha que só sobrou no cupom", async () => {
    // O estado exato em que BRINCADEIRAS ficou: a linha perdeu a campanha, mas o
    // cupom ainda carrega o carimbo — e ele só é escrito a partir de um teste válido.
    await coupons.recordCodeCheck({ code: PALAVRA_BOA, verdict: "valid", campaignId: CAMPANHA, source: "admin" });
    expect((await coupons.getCoupon(CAMPANHA)).code).toBe(PALAVRA_BOA);
    await coupons.recordCodeCheck({ code: PALAVRA_BOA, verdict: "invalid", campaignId: null, source: "admin" });

    const r = await coupons.recoverCodesFromCoupons();
    expect(r.recuperados).toBeGreaterThan(0);

    const linha = (await coupons.listCodeChecks({ limit: 50 })).find(p => p.code === PALAVRA_BOA);
    expect(linha.verdict).toBe("valid");
    expect(linha.campaignId).toBe(CAMPANHA);
  });

  it("findCouponByCode é o que o sistema sabe quando o ML não responde", async () => {
    await coupons.recordCodeCheck({ code: PALAVRA_BOA, verdict: "valid", campaignId: CAMPANHA, source: "admin" });
    expect((await coupons.findCouponByCode(PALAVRA_BOA)).campaignId).toBe(CAMPANHA);
    expect(await coupons.findCouponByCode("PALAVRA_QUE_NINGUEM_TESTOU")).toBe(null);
  });
});

// De onde veio a palavra que está carimbada no cupom. A lista do admin mostra as
// duas do mesmo jeito hoje, e elas não valem o mesmo: a testada é resposta do ML, a
// do título é leitura de texto. Quem olha a tabela precisa saber em qual das duas
// pode apostar um repasse.
describe("listCoupons — a procedência da palavra de cada cupom", () => {
  const DO_TITULO = "9900003";
  const SEM_PALAVRA = "9900004";
  const PALAVRA_TITULO = `TIT${crypto.randomBytes(3).toString("hex").toUpperCase()}`;

  const acharCupom = async (id) =>
    (await coupons.listCoupons({ pageSize: 200, onlyValid: false })).items.find(c => c.campaignId === id);

  beforeEach(async () => {
    await semear();
    await coupons.upsertCoupons([
      { campaignId: DO_TITULO, title: `10% OFF com ${PALAVRA_TITULO}`, kind: "percent", value: 10, scope: "campaign", codeFromTitle: PALAVRA_TITULO },
      { campaignId: SEM_PALAVRA, title: "15% OFF sem palavra", kind: "percent", value: 15, scope: "campaign" },
    ]);
  });

  it("palavra testada no ML vem como 'testada', com a data do teste", async () => {
    await coupons.recordCodeCheck({ code: PALAVRA, verdict: "valid", campaignId: CAMPANHA, source: "admin" });

    const c = await acharCupom(CAMPANHA);
    expect(c.code).toBe(PALAVRA);
    expect(c.codeSource).toBe("testada");
    expect(c.codeCheckedAt).toBeTruthy();
  });

  it("palavra lida do título vem como 'titulo', sem data", async () => {
    const c = await acharCupom(DO_TITULO);
    expect(c.code).toBe(PALAVRA_TITULO);
    expect(c.codeSource).toBe("titulo");
    expect(c.codeCheckedAt).toBe(null);
  });

  it("cupom sem palavra não ganha procedência nenhuma", async () => {
    const c = await acharCupom(SEM_PALAVRA);
    expect(c.code).toBe(null);
    expect(c.codeSource).toBe(null);
  });

  // O caso que faz a comparação por `code` valer a pena: a campanha tem uma palavra
  // testada antiga e o cupom carrega outra. Dizer "testada" na segunda seria carimbar
  // como prova do ML uma palavra que ele nunca viu.
  it("palavra testada de OUTRA palavra não carimba a do título como testada", async () => {
    await coupons.recordCodeCheck({ code: `${PALAVRA_TITULO}X`, verdict: "valid", campaignId: DO_TITULO, source: "admin" });

    const c = await acharCupom(DO_TITULO);
    expect(c.code).toBe(PALAVRA_TITULO);
    expect(c.codeSource).toBe("titulo");
  });
});
