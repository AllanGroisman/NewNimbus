// Testes do afiliado Shopee — partes puras (sem rede).
// Verifica: assinatura HMAC-SHA256 e montagem do payload GraphQL.

import "../helpers/env.js";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const affiliate = require(path.resolve(__dirname, "..", "..", "backend", "scraping", "affiliate.js"));
const { prisma } = require(path.resolve(__dirname, "..", "..", "backend", "db.js"));

const TEST_USER_ID = "test-user-shopee";

beforeEach(async () => {
  await prisma().user.upsert({
    where: { id: TEST_USER_ID },
    create: { id: TEST_USER_ID, email: `${TEST_USER_ID}@test.local`, name: "Unit", passwordHash: "x" },
    update: {},
  });
});

describe("signShopeeRequest", () => {
  it("monta o header no formato esperado pela Shopee", () => {
    const header = affiliate.signShopeeRequest({
      appId: "1234567",
      appSecret: "secret-fake",
      timestamp: 1700000000,
      payload: '{"query":"x"}',
    });
    expect(header.startsWith("SHA256 Credential=1234567")).toBe(true);
    expect(header).toContain("Timestamp=1700000000");
    expect(header).toMatch(/Signature=[a-f0-9]{64}$/);
  });

  it("usa sha256(appId + timestamp + payload + appSecret) em hex", () => {
    const appId = "appA";
    const appSecret = "secretB";
    const timestamp = 42;
    const payload = '{"query":"hello"}';
    const expected = crypto
      .createHash("sha256")
      .update(appId + timestamp + payload + appSecret)
      .digest("hex");
    const header = affiliate.signShopeeRequest({ appId, appSecret, timestamp, payload });
    expect(header).toContain(`Signature=${expected}`);
  });

  it("muda a assinatura quando qualquer entrada muda", () => {
    const base = { appId: "a", appSecret: "s", timestamp: 1, payload: "p" };
    const h1 = affiliate.signShopeeRequest(base);
    const h2 = affiliate.signShopeeRequest({ ...base, timestamp: 2 });
    const h3 = affiliate.signShopeeRequest({ ...base, payload: "q" });
    const h4 = affiliate.signShopeeRequest({ ...base, appSecret: "t" });
    expect(h1).not.toBe(h2);
    expect(h1).not.toBe(h3);
    expect(h1).not.toBe(h4);
  });
});

describe("buildShopeeShortLinkPayload", () => {
  it("gera JSON com mutation generateShortLink", () => {
    const p = affiliate.buildShopeeShortLinkPayload("https://shopee.com.br/produto-i.1.2");
    const parsed = JSON.parse(p);
    expect(parsed.query).toContain("generateShortLink");
    expect(parsed.query).toContain("https://shopee.com.br/produto-i.1.2");
    expect(parsed.query).toContain("shortLink");
  });

  it("escapa aspas duplas dentro da URL pra não quebrar o GraphQL", () => {
    const p = affiliate.buildShopeeShortLinkPayload('https://shopee.com.br/produto"hack');
    const parsed = JSON.parse(p);
    // Depois de parse do JSON, a query é uma string GraphQL com \" embutida.
    // O importante é que não exploda o JSON.parse acima.
    expect(parsed.query).toContain('\\"');
  });
});

describe("sub_ids do link (vendas por grupo)", () => {
  const subIds = (p) => JSON.parse(p).query.match(/subIds:\[(.*?)\]/)[1];

  it("sem marca: as 5 posições vão vazias, como sempre foi", () => {
    expect(subIds(affiliate.buildShopeeShortLinkPayload("https://shopee.com.br/i.1.2"))).toBe('"","","","",""');
  });

  it("a marca do grupo vai na primeira posição, e só letras e números passam", () => {
    const p = affiliate.buildShopeeShortLinkPayload("https://shopee.com.br/i.1.2", ["g1727640000000", 'a-b"c d']);
    expect(subIds(p)).toBe('"g1727640000000","abcd","","",""');
    expect(subIds(affiliate.buildShopeeShortLinkPayload("u", ["x".repeat(80)]))).toBe(`"${"x".repeat(50)}","","","",""`);
  });

  it("subIdDoGrupo: g + id numérico; id que não é número fica sem marca", () => {
    expect(affiliate.subIdDoGrupo(1727640000000)).toBe("g1727640000000");
    expect(affiliate.subIdDoGrupo("42")).toBe("g42");
    expect(affiliate.subIdDoGrupo(undefined)).toBe("");
    expect(affiliate.subIdDoGrupo("abc")).toBe("");
    expect(affiliate.SUBID_GRUPO_RE.exec("g42")[1]).toBe("42");
  });

  it("o mesmo produto em grupos diferentes gera links diferentes (cache separado por marca)", async () => {
    affiliate.writeShopeeConfig(TEST_USER_ID, { appId: "1234567", appSecret: "0123456789abcdef" });
    let n = 0;
    const fetchMock = vi.fn(async (_url, opts) => {
      const marca = JSON.parse(opts.body).query.match(/subIds:\["(\w*)"/)[1];
      return new Response(JSON.stringify({ data: { generateShortLink: { shortLink: `https://s.shopee.com.br/${marca || "sem"}-${++n}` } } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const url = "https://shopee.com.br/produto-i.9.9";
      const a = await affiliate.gerarLinkAfiliadoShopee(TEST_USER_ID, url, { subId: "g1" });
      const b = await affiliate.gerarLinkAfiliadoShopee(TEST_USER_ID, url, { subId: "g2" });
      const a2 = await affiliate.gerarLinkAfiliadoShopee(TEST_USER_ID, url, { subId: "g1" });
      const semMarca = await affiliate.gerarLinkAfiliadoShopee(TEST_USER_ID, url);
      expect(a).toMatch(/\/g1-/);
      expect(b).toMatch(/\/g2-/);
      expect(a2).toBe(a);   // do cache
      expect(semMarca).toMatch(/\/sem-/);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.unstubAllGlobals();
      affiliate.clearShopeeConfig(TEST_USER_ID);
    }
  });
});

describe("buildShopeeProductOfferPayload", () => {
  it("monta query productOfferV2 com keyword + paginação", () => {
    const p = affiliate.buildShopeeProductOfferPayload({ keyword: "celular", page: 2, limit: 30, sortType: 4 });
    const parsed = JSON.parse(p);
    expect(parsed.query).toContain("productOfferV2");
    expect(parsed.query).toContain('keyword:"celular"');
    expect(parsed.query).toContain("page:2");
    expect(parsed.query).toContain("limit:30");
    expect(parsed.query).toContain("sortType:4");
    expect(parsed.query).toContain("nodes");
    expect(parsed.query).toContain("pageInfo");
  });

  it("usa defaults sensatos", () => {
    const p = affiliate.buildShopeeProductOfferPayload({ keyword: "x" });
    const parsed = JSON.parse(p);
    expect(parsed.query).toContain("page:1");
    expect(parsed.query).toContain("limit:50");
    expect(parsed.query).toContain("sortType:4");
  });

  it("inclui listType:0 por default (sem pré-seleção)", () => {
    const p = affiliate.buildShopeeProductOfferPayload({ keyword: "x" });
    expect(JSON.parse(p).query).toContain("listType:0");
  });

  it("propaga o listType escolhido (pré-seleção da Shopee)", () => {
    const p = affiliate.buildShopeeProductOfferPayload({ keyword: "x", listType: 2 });
    expect(JSON.parse(p).query).toContain("listType:2");
  });

  it("listType coexiste com keyword e sortType na mesma query", () => {
    const parsed = JSON.parse(affiliate.buildShopeeProductOfferPayload({ keyword: "celular", listType: 1, sortType: 5 }));
    expect(parsed.query).toContain('keyword:"celular"');
    expect(parsed.query).toContain("listType:1");
    expect(parsed.query).toContain("sortType:5");
  });
});

describe("gerarLinkAfiliadoShopee", () => {
  it("retorna null quando não há config", async () => {
    affiliate.clearShopeeConfig(TEST_USER_ID);
    const r = await affiliate.gerarLinkAfiliadoShopee(TEST_USER_ID, "https://shopee.com.br/i.1.2");
    expect(r).toBeNull();
  });

  it("retorna null em URL inválida (tipo)", async () => {
    expect(await affiliate.gerarLinkAfiliadoShopee(TEST_USER_ID, null)).toBeNull();
    expect(await affiliate.gerarLinkAfiliadoShopee(TEST_USER_ID, "")).toBeNull();
    expect(await affiliate.gerarLinkAfiliadoShopee(TEST_USER_ID, 123)).toBeNull();
  });
});

describe("writeShopeeConfig", () => {
  it("rejeita App ID inválido", () => {
    expect(() => affiliate.writeShopeeConfig(TEST_USER_ID, { appId: "ab", appSecret: "0123456789abcdef" })).toThrow();
    expect(() => affiliate.writeShopeeConfig(TEST_USER_ID, { appId: "tem espaço", appSecret: "0123456789abcdef" })).toThrow();
  });

  it("rejeita App Secret muito curto", () => {
    expect(() => affiliate.writeShopeeConfig(TEST_USER_ID, { appId: "1234", appSecret: "curto" })).toThrow();
  });

  it("salva config válida e marca configured=true no status", () => {
    affiliate.writeShopeeConfig(TEST_USER_ID, { appId: "1234567", appSecret: "0123456789abcdef" });
    const s = affiliate.status(TEST_USER_ID);
    expect(s.shopee.configured).toBe(true);
    expect(s.shopee.appId).toBe("1234567");
    expect(s.shopee.appSecretLength).toBeGreaterThan(0);
    affiliate.clearShopeeConfig(TEST_USER_ID);
  });
});

// O App ID é o próprio ID de afiliado. Sem Senha — ou se a API não der link —
// o link sai pelo redirecionador da Shopee (an_redir) com esse número.
describe("an_redir — só com o App ID, ou quando a API falha", () => {
  const urlGuard = require(path.resolve(__dirname, "..", "..", "backend", "scraping", "urlGuard.js"));
  const ID = "18300000001";
  const SENHA = "0123456789abcdef";
  const PRODUTO = "https://shopee.com.br/product/1082747237/22697179178";
  const params = (link) => Object.fromEntries(new URL(link).searchParams);
  const apiOk = (short) => vi.fn(async () => new Response(JSON.stringify({ data: { generateShortLink: { shortLink: short } } }), { status: 200 }));

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    affiliate.clearShopeeConfig(TEST_USER_ID);
  });

  it("buildShopeeRedirLink: origem codificada, ID, e sub_id só quando há marca", () => {
    const link = affiliate.buildShopeeRedirLink(PRODUTO, ID, "g7");
    expect(link.startsWith("https://s.shopee.com.br/an_redir?origin_link=https%3A%2F%2Fshopee.com.br%2Fproduct%2F")).toBe(true);
    expect(params(link)).toEqual({ origin_link: PRODUTO, affiliate_id: ID, sub_id: "g7" });
    expect(params(affiliate.buildShopeeRedirLink(PRODUTO, ID))).not.toHaveProperty("sub_id");
  });

  it("writeShopeeConfig: App ID sozinho basta (aceita o an_ do link) e o status diz o modo", () => {
    affiliate.writeShopeeConfig(TEST_USER_ID, { appId: `an_${ID}` });
    expect(affiliate.status(TEST_USER_ID).shopee).toMatchObject({ configured: true, modo: "redir", apiConfigured: false, appId: ID, apiFalha: null });

    affiliate.writeShopeeConfig(TEST_USER_ID, { appSecret: SENHA });
    expect(affiliate.status(TEST_USER_ID).shopee).toMatchObject({ configured: true, modo: "api", apiConfigured: true, appId: ID });
  });

  it("writeShopeeConfig: recusa App ID com letras", () => {
    expect(() => affiliate.writeShopeeConfig(TEST_USER_ID, { appId: "abc123" })).toThrow(/App ID inválido/);
  });

  it("só App ID: an_redir com o produto limpo (sem o rastreio de outro afiliado), sem chamar a API", async () => {
    affiliate.writeShopeeConfig(TEST_USER_ID, { appId: ID });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const link = await affiliate.gerarLinkAfiliadoShopee(
      TEST_USER_ID,
      "https://shopee.com.br/opaanlp/1082747237/22697179178?mmp_pid=an_999&utm_content=dele----",
      { subId: "g5" },
    );
    expect(params(link)).toEqual({ origin_link: PRODUTO, affiliate_id: ID, sub_id: "g5" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("link curto na origem: abre antes e embrulha só o produto", async () => {
    affiliate.writeShopeeConfig(TEST_USER_ID, { appId: ID });
    const abrir = vi.spyOn(urlGuard, "safeFetchFollow").mockResolvedValue({
      res: { body: { cancel: async () => {} } },
      finalUrl: "https://shopee.com.br/product/111111/222222?mmp_pid=an_999",
    });

    const link = await affiliate.gerarLinkAfiliadoShopee(TEST_USER_ID, "https://s.shopee.com.br/curtoDeOutro");
    expect(params(link).origin_link).toBe("https://shopee.com.br/product/111111/222222");
    expect(abrir).toHaveBeenCalledTimes(1);
  });

  it("link curto que não abre: sem link (não arrisca a comissão de outra pessoa)", async () => {
    affiliate.writeShopeeConfig(TEST_USER_ID, { appId: ID });
    vi.spyOn(urlGuard, "safeFetchFollow").mockRejectedValue(new Error("timeout"));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await affiliate.gerarLinkAfiliadoShopee(TEST_USER_ID, "https://s.shopee.com.br/quebrado")).toBeNull();
    expect(affiliate.status(TEST_USER_ID).shopee.lastFailureReason).toMatch(/Não consegui ler o produto/);
  });

  it("com Senha e a API dando certo: link curto oficial, sem apiFalha", async () => {
    affiliate.writeShopeeConfig(TEST_USER_ID, { appId: ID, appSecret: SENHA });
    vi.stubGlobal("fetch", apiOk("https://s.shopee.com.br/oficial"));

    expect(await affiliate.gerarLinkAfiliadoShopee(TEST_USER_ID, PRODUTO, { subId: "g5" })).toBe("https://s.shopee.com.br/oficial");
    expect(affiliate.status(TEST_USER_ID).shopee.apiFalha).toBeNull();
  });

  it("Senha recusada (HTTP 401): cai pro an_redir com o App ID e anota o motivo", async () => {
    affiliate.writeShopeeConfig(TEST_USER_ID, { appId: ID, appSecret: SENHA });
    const fetchMock = vi.fn(async () => new Response("", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const link = await affiliate.gerarLinkAfiliadoShopee(TEST_USER_ID, PRODUTO, { subId: "g5" });
    expect(params(link)).toEqual({ origin_link: PRODUTO, affiliate_id: ID, sub_id: "g5" });
    expect(String(fetchMock.mock.calls[0][0])).toContain("open-api.affiliate.shopee.com.br");
    const st = affiliate.status(TEST_USER_ID).shopee;
    expect(st.apiFalha).toMatch(/HTTP 401/);
    expect(st.lastFailureReason).toBeNull(); // o link saiu, pelo reserva
  });

  it("erro da API no corpo (código 10020) também cai pro an_redir", async () => {
    affiliate.writeShopeeConfig(TEST_USER_ID, { appId: ID, appSecret: SENHA });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ errors: [{ message: "Invalid Signature", extensions: { code: 10020 } }] }), { status: 200 })));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const link = await affiliate.gerarLinkAfiliadoShopee(TEST_USER_ID, PRODUTO);
    expect(link.startsWith("https://s.shopee.com.br/an_redir?")).toBe(true);
    expect(affiliate.status(TEST_USER_ID).shopee.apiFalha).toMatch(/Invalid Signature/);
  });

  it("o reserva usado por falha não fica no cache: o próximo pedido tenta a API de novo", async () => {
    affiliate.writeShopeeConfig(TEST_USER_ID, { appId: ID, appSecret: SENHA });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
    const reserva = await affiliate.gerarLinkAfiliadoShopee(TEST_USER_ID, PRODUTO, { subId: "g5" });
    expect(reserva.startsWith("https://s.shopee.com.br/an_redir?")).toBe(true);

    vi.stubGlobal("fetch", apiOk("https://s.shopee.com.br/voltou"));
    expect(await affiliate.gerarLinkAfiliadoShopee(TEST_USER_ID, PRODUTO, { subId: "g5" })).toBe("https://s.shopee.com.br/voltou");
    expect(affiliate.status(TEST_USER_ID).shopee.apiFalha).toBeNull();
  });
});
