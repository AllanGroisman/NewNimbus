// Testes do afiliado Mercado Livre — gerarLinkAfiliadoML com fetch mockado.
// A geração real depende do cookie da sessão do usuário no ML; aqui validamos
// o contrato: headers/body corretos, cache, e os modos de falha (cookie
// expirado, link inválido, erro de rede) — todos devem devolver null sem lançar.

import "../helpers/env.js";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const affiliate = require(path.resolve(__dirname, "..", "..", "backend", "scraping", "affiliate.js"));
const { prisma } = require(path.resolve(__dirname, "..", "..", "backend", "db.js"));

const TEST_USER_ID = "test-user-ml-affiliate";
const LINK = "https://www.mercadolivre.com.br/produto/p/MLB123456";

function okResponse(shortUrl) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ urls: [{ short_url: shortUrl }] }),
  };
}

let fetchMock;

beforeEach(async () => {
  await prisma().user.upsert({
    where: { id: TEST_USER_ID },
    create: { id: TEST_USER_ID, email: `${TEST_USER_ID}@test.local`, name: "Unit", passwordHash: "x" },
    update: {},
  });
  // writeConfig limpa o cache do usuário — garante teste independente do anterior.
  affiliate.writeConfig(TEST_USER_ID, { tag: "minha-tag", cookie: "ssid=cookie-de-teste" });
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("gerarLinkAfiliadoML", () => {
  it("gera o link curto e envia tag + cookie do usuário na requisição", async () => {
    fetchMock.mockResolvedValue(okResponse("https://s.mercadolivre.com.br/abc"));

    const short = await affiliate.gerarLinkAfiliadoML(TEST_USER_ID, LINK);
    expect(short).toBe("https://s.mercadolivre.com.br/abc");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.method).toBe("POST");
    expect(opts.headers.Cookie).toBe("ssid=cookie-de-teste");
    const body = JSON.parse(opts.body);
    expect(body.urls).toEqual([LINK]);
    expect(body.tag).toBe("minha-tag");
  });

  it("cacheia por link: segunda chamada não bate na rede", async () => {
    fetchMock.mockResolvedValue(okResponse("https://s.mercadolivre.com.br/cache1"));

    const first = await affiliate.gerarLinkAfiliadoML(TEST_USER_ID, LINK);
    const second = await affiliate.gerarLinkAfiliadoML(TEST_USER_ID, LINK);
    expect(first).toBe("https://s.mercadolivre.com.br/cache1");
    expect(second).toBe("https://s.mercadolivre.com.br/cache1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("link diferente não usa o cache do outro", async () => {
    fetchMock
      .mockResolvedValueOnce(okResponse("https://s.mercadolivre.com.br/um"))
      .mockResolvedValueOnce(okResponse("https://s.mercadolivre.com.br/dois"));

    const a = await affiliate.gerarLinkAfiliadoML(TEST_USER_ID, `${LINK}?v=1`);
    const b = await affiliate.gerarLinkAfiliadoML(TEST_USER_ID, `${LINK}?v=2`);
    expect(a).toBe("https://s.mercadolivre.com.br/um");
    expect(b).toBe("https://s.mercadolivre.com.br/dois");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("sem tag/cookie configurados devolve null sem chamar a rede", async () => {
    affiliate.clearConfig(TEST_USER_ID);
    const short = await affiliate.gerarLinkAfiliadoML(TEST_USER_ID, LINK);
    expect(short).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("link ausente/não-string devolve null sem chamar a rede", async () => {
    expect(await affiliate.gerarLinkAfiliadoML(TEST_USER_ID, null)).toBeNull();
    expect(await affiliate.gerarLinkAfiliadoML(TEST_USER_ID, 42)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("HTTP não-ok (cookie expirado) → null e registra a falha no status", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });

    const short = await affiliate.gerarLinkAfiliadoML(TEST_USER_ID, LINK);
    expect(short).toBeNull();

    const s = affiliate.status(TEST_USER_ID);
    expect(s.ml.lastFailureAt).toBeTruthy();
    expect(s.ml.lastFailureReason).toMatch(/401/);
  });

  it("resposta sem short_url (URL de home, por ex.) → null com motivo de link inválido", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ urls: [{ error: "url_not_allowed" }] }),
    });

    const short = await affiliate.gerarLinkAfiliadoML(TEST_USER_ID, LINK);
    expect(short).toBeNull();
    expect(affiliate.status(TEST_USER_ID).ml.lastFailureReason).toMatch(/inválido|url_not_allowed/i);
  });

  it("erro de rede (fetch lança) → null, sem propagar a exceção", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNRESET"));

    const short = await affiliate.gerarLinkAfiliadoML(TEST_USER_ID, LINK);
    expect(short).toBeNull();
    expect(affiliate.status(TEST_USER_ID).ml.lastFailureReason).toBe("ECONNRESET");
  });

  it("HTTP 401 vira kind login-wall (cookie vencido pede AÇÃO, não espera)", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });

    const r = await affiliate.criarLinkAfiliadoML(TEST_USER_ID, LINK);
    expect(r.shortUrl).toBeNull();
    expect(r.kind).toBe(affiliate.ML_LINK_KIND.COOKIE);
    expect(r.reason).toMatch(/cookie/i);
    // O contrato antigo continua: os chamadores de sempre recebem null.
    expect(await affiliate.gerarLinkAfiliadoML(TEST_USER_ID, `${LINK}?outro`)).toBeNull();
  });

  it("200 sem short_url vira kind nao-e-produto — o cookie está vivo", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ urls: [{ message: "URL not allowed in affiliates program" }] }),
    });

    const r = await affiliate.criarLinkAfiliadoML(TEST_USER_ID, LINK);
    expect(r.shortUrl).toBeNull();
    expect(r.kind).toBe(affiliate.ML_LINK_KIND.LINK_RECUSADO);
    // 200 é prova de sessão válida: conta como sucesso no status, não como cookie ruim.
    expect(affiliate.status(TEST_USER_ID).ml.lastSuccessAt).toBeTruthy();
  });

  it("sem tag/cookie vira kind afiliado-ausente, sem tocar a rede", async () => {
    affiliate.clearConfig(TEST_USER_ID);
    const r = await affiliate.criarLinkAfiliadoML(TEST_USER_ID, LINK);
    expect(r.kind).toBe(affiliate.ML_LINK_KIND.SEM_CONFIG);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sucesso devolve kind ok e o link curto", async () => {
    fetchMock.mockResolvedValue(okResponse("https://meli.la/abc"));
    const r = await affiliate.criarLinkAfiliadoML(TEST_USER_ID, `${LINK}?novo`);
    expect(r).toMatchObject({ shortUrl: "https://meli.la/abc", kind: affiliate.ML_LINK_KIND.OK });
  });

  it("falha não fica cacheada: próxima chamada tenta a rede de novo", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })
      .mockResolvedValueOnce(okResponse("https://s.mercadolivre.com.br/depois"));

    expect(await affiliate.gerarLinkAfiliadoML(TEST_USER_ID, LINK)).toBeNull();
    expect(await affiliate.gerarLinkAfiliadoML(TEST_USER_ID, LINK)).toBe("https://s.mercadolivre.com.br/depois");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
