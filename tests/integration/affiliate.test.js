// Afiliado ML + Amazon: write/read/clear, status. Per-user — cada teste cria
// um usuário próprio e a config fica isolada ao token dele.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { app, request, createTestUser, affiliate } from "../helpers/app.js";

// Salvar o cookie do ML já o testa no ML (busca as etiquetas da conta): aqui o
// ML de mentira lista duas, a primeira em uso.
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url) => (
    String(url).endsWith("/getTags")
      ? new Response(JSON.stringify([{ tag: "tag-em-uso", in_use: true }, { tag: "outra", in_use: false }]), { status: 200 })
      : new Response("", { status: 404 })
  )));
});
afterEach(() => vi.unstubAllGlobals());

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
    await a.auth("put", "/api/affiliate").send({ cookie: "cookie-a-sessid" });
    // User B continua sem config
    const resB = await b.auth("get", "/api/affiliate");
    expect(resB.status).toBe(200);
    expect(resB.body.configured).toBe(false);
    expect(resB.body.ml.configured).toBe(false);
    // E A continua com a config dele
    const resA = await a.auth("get", "/api/affiliate");
    expect(resA.body.ml.configured).toBe(true);
    expect(resA.body.ml.tag).toBe("tag-em-uso");
  });
});

describe("PUT /api/affiliate — config ML", () => {
  it("salva o cookie, pega as etiquetas da conta e ativa configured", async () => {
    const { auth } = await createTestUser();
    const res = await auth("put", "/api/affiliate").send({ cookie: "abc123sessionid" });
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(true);
    expect(res.body.tag).toBe("tag-em-uso");
    expect(res.body.ml.tags.map(t => t.tag)).toEqual(["tag-em-uso", "outra"]);
    expect(res.body.cookiePreview).toContain("abc");
    expect(res.body.cookieLength).toBeGreaterThan(0);
  });

  it("DELETE limpa a config", async () => {
    const { auth } = await createTestUser();
    await auth("put", "/api/affiliate").send({ cookie: "y-cookie-sessid" });
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

describe("Shopee — App ID obrigatório, Senha opcional", () => {
  const ID = "18300000001";
  const PRODUTO = "https://shopee.com.br/product/1082747237/22697179178";
  const redir = (link) => {
    const u = new URL(link);
    return { base: `${u.origin}${u.pathname}`, params: Object.fromEntries(u.searchParams) };
  };

  it("PUT só com o App ID (com ou sem o an_): configurado no modo redir", async () => {
    const { auth } = await createTestUser();
    const res = await auth("put", "/api/affiliate/shopee").send({ appId: `an_${ID}` });
    expect(res.status).toBe(200);
    expect(res.body.shopee).toMatchObject({ configured: true, modo: "redir", apiConfigured: false, appId: ID });
  });

  it("PUT recusa App ID com letras", async () => {
    const { auth } = await createTestUser();
    const res = await auth("put", "/api/affiliate/shopee").send({ appId: "meu-app" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/App ID inválido/);
  });

  it("Testar sem Senha devolve o an_redir com o App ID, sem aviso", async () => {
    const { auth } = await createTestUser();
    await auth("put", "/api/affiliate/shopee").send({ appId: ID });
    const res = await auth("post", "/api/affiliate/shopee/test").send({ url: PRODUTO });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ modo: "redir", aviso: null });
    expect(redir(res.body.shortUrl)).toEqual({ base: "https://s.shopee.com.br/an_redir", params: { origin_link: PRODUTO, affiliate_id: ID } });
  });

  it("Testar com Senha recusada pela Shopee cai pro an_redir e avisa", async () => {
    const { auth } = await createTestUser();
    await auth("put", "/api/affiliate/shopee").send({ appId: ID, appSecret: "senha-errada-1234567" });
    // A Shopee de mentira (beforeEach do arquivo) responde 404 pra API.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await auth("post", "/api/affiliate/shopee/test").send({ url: PRODUTO });
    expect(res.status).toBe(200);
    expect(res.body.modo).toBe("redir");
    expect(res.body.aviso).toMatch(/A API da Shopee recusou \(HTTP 404/);
    expect(redir(res.body.shortUrl).params.affiliate_id).toBe(ID);

    const st = await auth("get", "/api/affiliate");
    expect(st.body.shopee).toMatchObject({ modo: "api", apiFalha: expect.stringMatching(/HTTP 404/) });
  });

  it("descobrir-id lê o ID de um link já aberto", async () => {
    const { auth } = await createTestUser();
    const res = await auth("post", "/api/affiliate/shopee/descobrir-id")
      .send({ url: `${PRODUTO}?mmp_pid=an_${ID}&utm_source=an_${ID}&utm_content=x----` });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ affiliateId: ID });
  });

  it("descobrir-id recusa link que não é da Shopee", async () => {
    const { auth } = await createTestUser();
    const res = await auth("post", "/api/affiliate/shopee/descobrir-id")
      .send({ url: `https://www.amazon.com.br/dp/B000?utm_source=an_${ID}` });
    expect(res.status).toBe(400);
  });

  it("descobrir-id: link sem an_ responde 400", async () => {
    const { auth } = await createTestUser();
    const res = await auth("post", "/api/affiliate/shopee/descobrir-id").send({ url: PRODUTO });
    expect(res.status).toBe(400);
  });
});
