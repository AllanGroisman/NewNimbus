// Afiliado ML + Amazon: write/read/clear, status. Per-user — cada teste cria
// um usuário próprio e a config fica isolada ao token dele.

import { describe, it, expect } from "vitest";
import { app, request, createTestUser, affiliate } from "../helpers/app.js";

describe("GET /api/affiliate — status", () => {
  it("devolve configured=false quando nada esta setado", async () => {
    const { auth } = await createTestUser();
    const res = await auth("get", "/api/affiliate");
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(false);
    expect(res.body.ml.configured).toBe(false);
    expect(res.body.amazon.configured).toBe(false);
  });

  it("usuários diferentes não enxergam config um do outro", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    // User A configura ML
    await a.auth("put", "/api/affiliate").send({ tag: "tag-a", cookie: "cookie-a-sessid" });
    // User B continua sem config
    const resB = await b.auth("get", "/api/affiliate");
    expect(resB.status).toBe(200);
    expect(resB.body.configured).toBe(false);
    expect(resB.body.ml.configured).toBe(false);
    // E A continua com a config dele
    const resA = await a.auth("get", "/api/affiliate");
    expect(resA.body.ml.configured).toBe(true);
    expect(resA.body.ml.tag).toBe("tag-a");
  });
});

describe("PUT /api/affiliate — config ML", () => {
  it("salva tag + cookie e ativa configured", async () => {
    const { auth } = await createTestUser();
    const res = await auth("put", "/api/affiliate").send({ tag: "minha-tag", cookie: "abc123sessionid" });
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(true);
    expect(res.body.tag).toBe("minha-tag");
    expect(res.body.cookiePreview).toContain("abc");
    expect(res.body.cookieLength).toBeGreaterThan(0);
  });

  it("DELETE limpa a config", async () => {
    const { auth } = await createTestUser();
    await auth("put", "/api/affiliate").send({ tag: "x", cookie: "y-cookie-sessid" });
    const res = await auth("delete", "/api/affiliate");
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(false);
  });
});

describe("PUT /api/affiliate/amazon — config Amazon", () => {
  it("salva tag valida", async () => {
    const { auth } = await createTestUser();
    const res = await auth("put", "/api/affiliate/amazon").send({ tag: "minhatag-20" });
    expect(res.status).toBe(200);
    expect(res.body.amazon.configured).toBe(true);
    expect(res.body.amazon.tag).toBe("minhatag-20");
  });

  it("rejeita tag invalida (com espaco)", async () => {
    const { auth } = await createTestUser();
    const res = await auth("put", "/api/affiliate/amazon").send({ tag: "tag com espaco" });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/affiliate/amazon/test — gera link", () => {
  it("falha se nao ha tag configurada", async () => {
    const { auth } = await createTestUser();
    const res = await auth("post", "/api/affiliate/amazon/test").send({ url: "https://www.amazon.com.br/dp/B0CXXX1234" });
    expect(res.status).toBe(400);
  });

  it("retorna shortUrl quando tag esta setada e URL valida", async () => {
    const { auth } = await createTestUser();
    await auth("put", "/api/affiliate/amazon").send({ tag: "tag-test-20" });
    const res = await auth("post", "/api/affiliate/amazon/test").send({ url: "https://www.amazon.com.br/dp/B0CXXX1234" });
    expect(res.status).toBe(200);
    expect(res.body.shortUrl).toContain("?tag=tag-test-20");
    expect(res.body.shortUrl).toContain("/dp/B0CXXX1234");
  });

  it("falha pra URL nao-Amazon", async () => {
    const { auth } = await createTestUser();
    await auth("put", "/api/affiliate/amazon").send({ tag: "tag-test-20" });
    const res = await auth("post", "/api/affiliate/amazon/test").send({ url: "https://www.outraloja.com/produto" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/ASIN|Amazon/i);
  });
});
