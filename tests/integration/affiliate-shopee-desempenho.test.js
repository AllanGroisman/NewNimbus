// GET /api/affiliate/shopee/desempenho — o desempenho de afiliado da Shopee de
// cada usuário, lido da Affiliate Open API com o App ID/senha DELE (fetch
// mockado aqui).
//
// O que se testa é o contrato com a tela e o isolamento: quem não tem
// credencial recebe o motivo, o nome de grupo de OUTRO usuário nunca aparece
// (duas pessoas podem ter a mesma conta Shopee), loja trancada fecha a rota.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import request from "supertest";
import { app, createTestUser, affiliate } from "../helpers/app.js";
import { makeGroup } from "../helpers/fixtures.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const backend = (...p) => path.resolve(__dirname, "..", "..", "backend", ...p);
const shopee = require(backend("affiliate-reports", "shopee.js"));
const storeLocks = require(backend("scraping", "store-locks.js"));
const appConfig = require(backend("config"));
const FX = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "fixtures", "shopee-desempenho.json"), "utf8"));

// Período relativo a hoje: o limite de 3 meses da Shopee é contado a partir de
// hoje, e os totais não dependem das datas da fixture.
const dia = (n) => new Date(Date.now() + n * 86400000).toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
const Q = `from=${dia(-7)}&to=${dia(-1)}`;
const CREDS = { appId: "123456", appSecret: "segredo-de-teste-123456" };

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

let fetchMock;

beforeEach(() => {
  shopee._resetCache();
  appConfig.set(storeLocks.STORE_LOCKS_KEY, {});
  fetchMock = vi.fn(async (_url, opts) => {
    const q = JSON.parse(opts.body).query;
    if (q.includes('scrollId:"scroll-2"')) return json(FX.pagina3);
    if (q.includes('scrollId:"scroll-1"')) return json(FX.pagina2);
    return json(FX.pagina1);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /api/affiliate/shopee/desempenho", () => {
  it("exige login", async () => {
    const res = await request(app).get(`/api/affiliate/shopee/desempenho?${Q}`);
    expect(res.status).toBe(401);
  });

  it("devolve totais, grupos e vendas, assinando com a credencial do próprio usuário", async () => {
    const { user, auth } = await createTestUser({ plan: "pro" });
    affiliate.writeShopeeConfig(user.id, CREDS);
    await auth("put", "/api/state").send({ groups: [makeGroup({ id: 123, name: "Ofertas Tech" })] });

    const res = await auth("get", `/api/affiliate/shopee/desempenho?${Q}`);
    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({ orders: 3, units: 14, sales: 730.75, commission: { total: 21.93 } });
    expect(res.body.groups.map(g => g.name)).toEqual(["Ofertas Tech", "Grupo removido", "Sem grupo"]);
    expect(res.body.sales).toHaveLength(5);
    expect(res.body.days).toHaveLength(7);
    expect(res.body.requestedFrom).toBeNull();
    for (const [, opts] of fetchMock.mock.calls) {
      expect(opts.headers.Authorization).toMatch(/^SHA256 Credential=123456, /);
    }
  });

  it("o nome do grupo de outro usuário nunca aparece, mesmo com a marca dele na venda", async () => {
    const outro = await createTestUser({ plan: "pro" });
    await outro.auth("put", "/api/state").send({ groups: [makeGroup({ id: 999, name: "Grupo do Outro" })] });

    const { user, auth } = await createTestUser({ plan: "pro" });
    affiliate.writeShopeeConfig(user.id, CREDS);
    const res = await auth("get", `/api/affiliate/shopee/desempenho?${Q}`);

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain("Grupo do Outro");
    expect(res.body.groups.find(g => g.groupId === "999").name).toBe("Grupo removido");
  });

  it("usuário sem credencial recebe o motivo, nunca os números de outro em cache", async () => {
    const a = await createTestUser({ plan: "pro" });
    affiliate.writeShopeeConfig(a.user.id, CREDS);
    expect((await a.auth("get", `/api/affiliate/shopee/desempenho?${Q}`)).status).toBe(200);

    const b = await createTestUser({ plan: "pro" });
    const res = await b.auth("get", `/api/affiliate/shopee/desempenho?${Q}`);
    expect(res.status).toBe(409);
    expect(res.body.kind).toBe("afiliado-ausente");
    expect(res.body.summary).toBeUndefined();
  });

  it("credencial recusada pela Shopee vira 409 credencial-recusada", async () => {
    const { user, auth } = await createTestUser({ plan: "pro" });
    affiliate.writeShopeeConfig(user.id, CREDS);
    fetchMock.mockImplementation(async () => json({ errors: [{ message: "error [10020]: Invalid Signature", extensions: { code: 10020, message: "Invalid Signature" } }] }));

    const res = await auth("get", `/api/affiliate/shopee/desempenho?${Q}`);
    expect(res.status).toBe(409);
    expect(res.body.kind).toBe("credencial-recusada");
  });

  it("período todo fora dos 3 meses é 400 e não chega na Shopee", async () => {
    const { user, auth } = await createTestUser({ plan: "pro" });
    affiliate.writeShopeeConfig(user.id, CREDS);
    const res = await auth("get", `/api/affiliate/shopee/desempenho?from=${dia(-200)}&to=${dia(-180)}`);
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("loja Shopee trancada fecha a rota pro usuário comum", async () => {
    const { user, auth } = await createTestUser({ plan: "pro" });
    affiliate.writeShopeeConfig(user.id, CREDS);
    storeLocks.writeStoreLock("shopee", { locked: true, message: "Shopee em manutenção" });

    const res = await auth("get", `/api/affiliate/shopee/desempenho?${Q}`);
    expect(res.status).toBe(403);
    expect(res.body.storeLocked).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
