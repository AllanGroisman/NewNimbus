// /api/affiliate/ml/etiquetas — listar as etiquetas da conta ML do admin e
// trocar a "em uso" (no ML e na TAG salva aqui). fetch mockado no lugar do ML.
//
// O que pode quebrar sem ninguém notar: a rota perder o requireAdmin, usar o
// cookie errado (o da conta do sistema em vez do do próprio admin), ou salvar a
// TAG mesmo quando o ML recusou a troca.
//
// No fim, o refresh do affiliate-store: é ele que leva a TAG trocada no server
// até o worker, que tem o cache dele.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { request, app, createTestUser, affiliate, prisma, auth as authMod } from "../helpers/app.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const store = require(path.resolve(__dirname, "..", "..", "backend", "scraping", "affiliate-store"));
const FX = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "fixtures", "ml-etiquetas.json"), "utf8"));

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let fetchMock, setTagInUse;

beforeEach(() => {
  setTagInUse = null;
  let lista = FX.getTags.map(t => ({ ...t }));
  fetchMock = vi.fn(async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/getTags")) return json(lista);
    if (u.pathname.endsWith("/setTagInUse")) {
      if (setTagInUse) return setTagInUse(init);
      const { tag } = JSON.parse(init.body);
      lista = lista.map(t => ({ ...t, in_use: t.tag === tag }));
      return json(lista);
    }
    return new Response("", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function makeAdmin() {
  const u = await createTestUser();
  await authMod.setUserRole(u.user.id, "admin");
  return u;
}

describe("GET /api/affiliate/ml/etiquetas", () => {
  it("exige login", async () => {
    const res = await request(app).get("/api/affiliate/ml/etiquetas");
    expect(res.status).toBe(401);
  });

  it("é só de admin", async () => {
    const { user, auth } = await createTestUser();
    affiliate.writeConfig(user.id, { tag: "allangroisman", cookie: "ssid=cookie-do-cliente" });
    const res = await auth("get", "/api/affiliate/ml/etiquetas");
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lista com o cookie do próprio admin", async () => {
    const { user, auth } = await makeAdmin();
    affiliate.writeConfig(user.id, { tag: "allangroisman", cookie: "ssid=cookie-do-admin" });
    affiliate.writeScraperMLAdminSession({ cookie: "ssid=cookie-do-sistema", tag: "sistema" });

    const res = await auth("get", "/api/affiliate/ml/etiquetas");
    expect(res.status).toBe(200);
    expect(res.body.current).toBe("allangroisman");
    expect(res.body.tags).toEqual([
      { tag: "allangroisman", inUse: true, createdAt: "2026-07-21 17:27:07.151627" },
      { tag: "grupo-ofertas", inUse: false, createdAt: "2026-09-30 10:00:00.000000" },
    ]);
    expect(fetchMock.mock.calls[0][1].headers.Cookie).toBe("ssid=cookie-do-admin");
    affiliate.clearScraperMLAdminSession();
  });

  it("sem cookie: 409 com o motivo, sem chamar o ML", async () => {
    const { auth } = await makeAdmin();
    const res = await auth("get", "/api/affiliate/ml/etiquetas");
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(affiliate.ML_LINK_KIND.SEM_CONFIG);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cookie vencido (302 pro login): 409 pedindo cookie novo", async () => {
    const { user, auth } = await makeAdmin();
    affiliate.writeConfig(user.id, { tag: "allangroisman", cookie: "ssid=vencido" });
    fetchMock.mockImplementation(async () => new Response("Found", { status: 302, headers: { location: "https://www.mercadolivre.com/jms/mlb/lgz/login" } }));

    const res = await auth("get", "/api/affiliate/ml/etiquetas");
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(affiliate.ML_LINK_KIND.COOKIE);
    expect(res.body.error).toMatch(/cookie.*venceu/i);
  });
});

describe("PUT /api/affiliate/ml/etiquetas", () => {
  it("é só de admin", async () => {
    const { user, auth } = await createTestUser();
    affiliate.writeConfig(user.id, { tag: "allangroisman", cookie: "ssid=cookie-do-cliente" });
    const res = await auth("put", "/api/affiliate/ml/etiquetas").send({ tag: "grupo-ofertas" });
    expect(res.status).toBe(403);
    expect(affiliate.readMLConfig(user.id).tag).toBe("allangroisman");
  });

  it("troca no ML e salva a TAG — o status volta junto", async () => {
    const { user, auth } = await makeAdmin();
    affiliate.writeConfig(user.id, { tag: "allangroisman", cookie: "ssid=cookie-do-admin" });

    const res = await auth("put", "/api/affiliate/ml/etiquetas").send({ tag: "grupo-ofertas" });
    expect(res.status).toBe(200);
    expect(res.body.current).toBe("grupo-ofertas");
    expect(res.body.tags.find(t => t.inUse).tag).toBe("grupo-ofertas");
    expect(res.body.status.tag).toBe("grupo-ofertas");
    // O cookie fica: só a TAG mudou.
    expect(affiliate.readMLConfig(user.id)).toMatchObject({ tag: "grupo-ofertas", cookie: "ssid=cookie-do-admin" });
  });

  it("ML recusou: a TAG daqui não muda", async () => {
    const { user, auth } = await makeAdmin();
    affiliate.writeConfig(user.id, { tag: "allangroisman", cookie: "ssid=cookie-do-admin" });
    setTagInUse = () => json({ message: "forbidden" }, 403);

    const res = await auth("put", "/api/affiliate/ml/etiquetas").send({ tag: "grupo-ofertas" });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/HTTP 403/);
    expect(affiliate.readMLConfig(user.id).tag).toBe("allangroisman");
  });

  it("etiqueta que não é da conta: 400", async () => {
    const { user, auth } = await makeAdmin();
    affiliate.writeConfig(user.id, { tag: "allangroisman", cookie: "ssid=cookie-do-admin" });

    const res = await auth("put", "/api/affiliate/ml/etiquetas").send({ tag: "de-outra-conta" });
    expect(res.status).toBe(400);
    expect(affiliate.readMLConfig(user.id).tag).toBe("allangroisman");
  });
});

describe("affiliate-store: refresh entre processos", () => {
  it("lê a TAG que outro processo gravou e avisa quem mudou", async () => {
    const { user } = await createTestUser();
    affiliate.writeConfig(user.id, { tag: "antiga", cookie: "ssid=c" });
    await store.flush();

    // Outro processo (o server) grava direto no banco.
    await prisma().affiliateConfig.update({
      where: { userId: user.id },
      data: { data: { ml: { tag: "nova", cookie: "ssid=c", updatedAt: new Date().toISOString() } } },
    });

    const avisados = [];
    const mudou = await store.refresh((id) => avisados.push(id));
    expect(mudou).toContain(user.id);
    expect(avisados).toContain(user.id);
    expect(affiliate.readMLConfig(user.id).tag).toBe("nova");

    // Sem mudança no banco, o próximo refresh não avisa ninguém por ele.
    expect(await store.refresh()).not.toContain(user.id);
  });

  it("linha apagada no banco sai do cache", async () => {
    const { user } = await createTestUser();
    affiliate.writeConfig(user.id, { tag: "x", cookie: "ssid=c" });
    await store.flush();
    await prisma().affiliateConfig.delete({ where: { userId: user.id } });

    expect(await store.refresh()).toContain(user.id);
    expect(affiliate.readMLConfig(user.id).tag).toBeNull();
  });

  it("não pisa numa gravação deste processo que ainda está em vôo", async () => {
    const { user } = await createTestUser();
    affiliate.writeConfig(user.id, { tag: "recente", cookie: "ssid=c" });
    // Sem flush: o upsert pode não ter chegado ao banco quando o refresh lê.
    await store.refresh();
    expect(affiliate.readMLConfig(user.id).tag).toBe("recente");
    await store.flush();
  });
});
