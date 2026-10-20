// GET /api/affiliate/ml/desempenho — o desempenho de afiliado do ML de cada
// usuário, lido da API do painel do ML com o cookie DELE (fetch mockado aqui).
//
// A rota em si é fina; o que se testa é o contrato com a tela: quem não tem
// cookie recebe o motivo (e não os números de outro), loja trancada fecha a
// rota, e período inválido não chega no ML.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import request from "supertest";
import { app, createTestUser, affiliate } from "../helpers/app.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const backend = (...p) => path.resolve(__dirname, "..", "..", "backend", ...p);
const ml = require(backend("affiliate-reports", "ml.js"));
const storeLocks = require(backend("scraping", "store-locks.js"));
const appConfig = require(backend("config"));
const FX = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "fixtures", "ml-desempenho.json"), "utf8"));
const LISTAS = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "fixtures", "ml-desempenho-listas.json"), "utf8"));

const Q = "from=2026-09-20&to=2026-09-25";
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

let fetchMock;

beforeEach(() => {
  ml._resetCache();
  appConfig.set(storeLocks.STORE_LOCKS_KEY, {});
  fetchMock = vi.fn(async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/dashboard/general")) return json(FX.general);
    if (u.pathname.endsWith("/dashboard/ganancias")) return json(FX.ganancias);
    if (u.pathname.endsWith("/dashboard/detalle-diario/general")) {
      return json(u.searchParams.get("page") === "1" ? FX.detalheDiarioPagina1 : FX.detalheDiarioPagina2);
    }
    if (u.pathname.endsWith("/dashboard/sales/general")) return json(LISTAS.vendas);
    if (u.pathname.endsWith("/dashboard/audiences/general")) return json(LISTAS.audiencias);
    return new Response("", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /api/affiliate/ml/desempenho", () => {
  it("exige login", async () => {
    const res = await request(app).get(`/api/affiliate/ml/desempenho?${Q}`);
    expect(res.status).toBe(401);
  });

  it("devolve resumo, dias e etiquetas lidos com o cookie do próprio usuário", async () => {
    const { user, auth } = await createTestUser();
    affiliate.writeConfig(user.id, { tag: "minha-tag", cookie: "ssid=cookie-do-a" });

    const res = await auth("get", `/api/affiliate/ml/desempenho?${Q}`);
    expect(res.status).toBe(200);
    expect(res.body.summary.clicks).toBe(20);
    expect(res.body.summary.earnings.total).toBe(18.5);
    expect(res.body.days).toHaveLength(6);
    expect(res.body.tags.map(t => t.tag)).toEqual(["minha-tag", "tag-secundaria"]);
    for (const [, opts] of fetchMock.mock.calls) expect(opts.headers.Cookie).toBe("ssid=cookie-do-a");
  });

  it("antFrom/antTo trazem o resumo e as etiquetas do período anterior", async () => {
    const { user, auth } = await createTestUser();
    affiliate.writeConfig(user.id, { tag: "minha-tag", cookie: "ssid=cookie-do-a" });

    const res = await auth("get", `/api/affiliate/ml/desempenho?${Q}&antFrom=2026-09-14&antTo=2026-09-19`);
    expect(res.status).toBe(200);
    expect(res.body.anterior).toMatchObject({ from: "2026-09-14", to: "2026-09-19", summary: { clicks: 20 } });
    expect(res.body.anterior.tags[0].tag).toBe("minha-tag");
    expect((await auth("get", `/api/affiliate/ml/desempenho?${Q}`)).body.anterior).toBeNull();
  });

  it("usuário sem cookie recebe o motivo, nunca os números de outro usuário em cache", async () => {
    const a = await createTestUser();
    affiliate.writeConfig(a.user.id, { tag: "tag-a", cookie: "ssid=cookie-do-a" });
    expect((await a.auth("get", `/api/affiliate/ml/desempenho?${Q}`)).status).toBe(200);

    const b = await createTestUser();
    const res = await b.auth("get", `/api/affiliate/ml/desempenho?${Q}`);
    expect(res.status).toBe(409);
    expect(res.body.kind).toBe("afiliado-ausente");
    expect(res.body.summary).toBeUndefined();
  });

  it("cookie vencido (302 pro login) vira 409 login-wall", async () => {
    const { user, auth } = await createTestUser();
    affiliate.writeConfig(user.id, { tag: "minha-tag", cookie: "ssid=vencido" });
    fetchMock.mockImplementation(async () => new Response(null, { status: 302, headers: { location: "https://www.mercadolivre.com/jms/mlb/lgz/login" } }));

    const res = await auth("get", `/api/affiliate/ml/desempenho?${Q}`);
    expect(res.status).toBe(409);
    expect(res.body.kind).toBe("login-wall");
    expect(res.body.error).toMatch(/cookie/i);
  });

  it("período inválido é 400 e não chega no ML", async () => {
    const { user, auth } = await createTestUser();
    affiliate.writeConfig(user.id, { tag: "minha-tag", cookie: "ssid=x" });
    const res = await auth("get", "/api/affiliate/ml/desempenho?from=2026-01-01&to=2026-09-28");
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("loja ML trancada fecha a rota pro usuário comum", async () => {
    const { user, auth } = await createTestUser();
    affiliate.writeConfig(user.id, { tag: "minha-tag", cookie: "ssid=x" });
    storeLocks.writeStoreLock("ml", { locked: true, message: "ML em manutenção" });

    const res = await auth("get", `/api/affiliate/ml/desempenho?${Q}`);
    expect(res.status).toBe(403);
    expect(res.body.storeLocked).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// GET /api/affiliate/ml/desempenho/lista — uma página de uma aba de baixo
// (vendas, produtos, categorias, nao-efetivadas, audiencias), pedida quando a
// aba abre.
describe("GET /api/affiliate/ml/desempenho/lista", () => {
  it("exige login", async () => {
    const res = await request(app).get(`/api/affiliate/ml/desempenho/lista?aba=vendas&${Q}`);
    expect(res.status).toBe(401);
  });

  it("devolve a página pedida da aba, lida com o cookie do próprio usuário", async () => {
    const { user, auth } = await createTestUser();
    affiliate.writeConfig(user.id, { tag: "minha-tag", cookie: "ssid=cookie-do-a" });

    const res = await auth("get", `/api/affiliate/ml/desempenho/lista?aba=vendas&${Q}&page=2`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ aba: "vendas", page: 2, total: 12 });
    expect(res.body.items[0]).toMatchObject({ product: "Fone de Ouvido Bluetooth XYZ", store: "Loja ABC", status: "IN_REVIEW" });
    const [[url, opts]] = fetchMock.mock.calls;
    expect(new URL(url).searchParams.get("page")).toBe("2");
    expect(opts.headers.Cookie).toBe("ssid=cookie-do-a");

    const aud = await auth("get", `/api/affiliate/ml/desempenho/lista?aba=audiencias&${Q}`);
    expect(aud.status).toBe(200);
    expect(aud.body.gender.map(g => g.label)).toEqual(["Não especificado", "Feminino", "Masculino"]);
  });

  it("aba desconhecida é 400 e não chega no ML; sem cookie é 409", async () => {
    const { user, auth } = await createTestUser();
    affiliate.writeConfig(user.id, { tag: "minha-tag", cookie: "ssid=x" });
    const res = await auth("get", `/api/affiliate/ml/desempenho/lista?aba=redes&${Q}`);
    expect(res.status).toBe(400);
    expect(res.body.kind).toBe("aba-invalida");
    expect(fetchMock).not.toHaveBeenCalled();

    const b = await createTestUser();
    const semCookie = await b.auth("get", `/api/affiliate/ml/desempenho/lista?aba=vendas&${Q}`);
    expect(semCookie.status).toBe(409);
    expect(semCookie.body.kind).toBe("afiliado-ausente");
  });

  it("loja ML trancada fecha a rota", async () => {
    const { user, auth } = await createTestUser();
    affiliate.writeConfig(user.id, { tag: "minha-tag", cookie: "ssid=x" });
    storeLocks.writeStoreLock("ml", { locked: true, message: "ML em manutenção" });
    const res = await auth("get", `/api/affiliate/ml/desempenho/lista?aba=vendas&${Q}`);
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
