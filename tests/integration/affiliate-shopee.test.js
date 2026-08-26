// Testes do afiliado Shopee — partes puras (sem rede).
// Verifica: assinatura HMAC-SHA256 e montagem do payload GraphQL.

import "../helpers/env.js";
import { describe, it, expect, beforeEach } from "vitest";
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
