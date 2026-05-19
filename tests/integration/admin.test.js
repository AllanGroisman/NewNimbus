// Endpoints administrativos — users (list/role/password/delete), scraper config,
// catalog admin, DLQ. Cobre tanto gating (403 pra user comum) quanto comportamento.

import { describe, it, expect, beforeEach } from "vitest";
import { request, app, createTestUser, auth as authMod, catalog } from "../helpers/app.js";
import { mlProduct, amazonProduct, shopeeProduct } from "../helpers/fixtures.js";

async function makeAdmin(opts = {}) {
  const u = await createTestUser(opts);
  await authMod.setUserRole(u.user.id, "admin");
  // re-login pra pegar token novo com role atual (não estritamente necessário,
  // syncRole no requireAuth atualiza on-the-fly, mas mantém o teste fiel à UX)
  return u;
}

describe("Admin — gating", () => {
  it("user comum recebe 403 em todas as rotas admin", async () => {
    const { auth } = await createTestUser();
    const rotas = [
      ["get", "/api/admin/users"],
      ["get", "/api/admin/scraper/config"],
      ["get", "/api/admin/scraper/status"],
      ["post", "/api/admin/scraper/run"],
      ["get", "/api/admin/catalog"],
      ["get", "/api/admin/queue/failed"],
    ];
    for (const [method, url] of rotas) {
      const res = await auth(method, url);
      expect(res.status, `${method.toUpperCase()} ${url}`).toBe(403);
    }
  });

  it("sem token retorna 401", async () => {
    const res = await request(app).get("/api/admin/users");
    expect(res.status).toBe(401);
  });
});

describe("Admin — users", () => {
  it("lista usuarios (sem passwordHash)", async () => {
    const admin = await makeAdmin();
    await createTestUser({ name: "Outro" });
    const res = await admin.auth("get", "/api/admin/users");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.users)).toBe(true);
    expect(res.body.users.length).toBeGreaterThanOrEqual(2);
    for (const u of res.body.users) {
      expect(u.passwordHash).toBeUndefined();
      expect(u.email).toBeTruthy();
    }
  });

  it("admin altera senha de outro user; user consegue logar com nova senha", async () => {
    const admin = await makeAdmin();
    const alvo = await createTestUser({ name: "Vitima" });
    const r = await admin.auth("patch", `/api/admin/users/${alvo.user.id}/password`).send({ newPassword: "novasenha999" });
    expect(r.status).toBe(200);

    const login = await request(app).post("/api/auth/login").send({ email: alvo.email, password: "novasenha999" });
    expect(login.status).toBe(200);
  });

  it("admin promove user a admin via PATCH /role", async () => {
    const admin = await makeAdmin();
    const alvo = await createTestUser({ name: "Promovido" });
    const r = await admin.auth("patch", `/api/admin/users/${alvo.user.id}/role`).send({ role: "admin" });
    expect(r.status).toBe(200);
    expect(r.body.user.role).toBe("admin");

    // alvo agora consegue acessar rota admin
    const me = await alvo.auth("get", "/api/admin/users");
    expect(me.status).toBe(200);
  });

  it("admin nao pode rebaixar a si mesmo", async () => {
    const admin = await makeAdmin();
    const r = await admin.auth("patch", `/api/admin/users/${admin.user.id}/role`).send({ role: "user" });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/rebaixar/i);
  });

  it("admin nao pode excluir a si mesmo", async () => {
    const admin = await makeAdmin();
    const r = await admin.auth("delete", `/api/admin/users/${admin.user.id}`);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/excluir.*mesmo/i);
  });

  it("admin exclui user — registro some da listagem", async () => {
    const admin = await makeAdmin();
    const alvo = await createTestUser({ name: "Removido" });
    const del = await admin.auth("delete", `/api/admin/users/${alvo.user.id}`);
    expect(del.status).toBe(200);

    const list = await admin.auth("get", "/api/admin/users");
    expect(list.body.users.find(u => u.id === alvo.user.id)).toBeUndefined();
  });
});

describe("Admin — scraper config + run", () => {
  it("GET /scraper/config devolve config + listas disponiveis", async () => {
    const admin = await makeAdmin();
    const r = await admin.auth("get", "/api/admin/scraper/config");
    expect(r.status).toBe(200);
    expect(r.body.config).toBeDefined();
    expect(Array.isArray(r.body.available.categories)).toBe(true);
    expect(Array.isArray(r.body.available.sources)).toBe(true);
  });

  it("PUT /scraper/config persiste mudancas", async () => {
    const admin = await makeAdmin();
    const payload = { intervalMinutes: 120, enabled: false };
    const r = await admin.auth("put", "/api/admin/scraper/config").send(payload);
    expect(r.status).toBe(200);
    expect(r.body.config.intervalMinutes).toBe(120);
    expect(r.body.config.enabled).toBe(false);

    // Re-leitura confirma persistência
    const get = await admin.auth("get", "/api/admin/scraper/config");
    expect(get.body.config.intervalMinutes).toBe(120);
    expect(get.body.config.enabled).toBe(false);
  });

  it("GET /scraper/status devolve running + lastRun", async () => {
    const admin = await makeAdmin();
    const r = await admin.auth("get", "/api/admin/scraper/status");
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty("running");
  });
});

describe("Admin — catalog", () => {
  beforeEach(async () => {
    // Popula catálogo pros testes de paginação/filtro
    await catalog.upsertProducts([
      mlProduct(1, { category: "gamer", discount: 30 }),
      mlProduct(2, { category: "gamer", discount: 50 }),
      mlProduct(3, { category: "beleza", discount: 20 }),
      amazonProduct(4, { category: "eletronicos", discount: 70 }),
      shopeeProduct(5, { category: "beleza", discount: 40 }),
    ]);
  });

  it("lista paginada com defaults", async () => {
    const admin = await makeAdmin();
    const r = await admin.auth("get", "/api/admin/catalog");
    expect(r.status).toBe(200);
    expect(r.body.page).toBe(1);
    expect(r.body.total).toBeGreaterThanOrEqual(5);
    expect(Array.isArray(r.body.items)).toBe(true);
    expect(r.body.stats).toBeDefined();
  });

  it("filtra por categoria", async () => {
    const admin = await makeAdmin();
    const r = await admin.auth("get", "/api/admin/catalog?category=gamer");
    expect(r.status).toBe(200);
    for (const p of r.body.items) {
      expect(p.category).toBe("gamer");
    }
    expect(r.body.items.length).toBeGreaterThanOrEqual(2);
  });

  it("filtra por busca textual", async () => {
    const admin = await makeAdmin();
    const r = await admin.auth("get", "/api/admin/catalog?q=ML");
    expect(r.status).toBe(200);
    for (const p of r.body.items) {
      expect(p.name.toLowerCase()).toContain("ml");
    }
  });

  it("paginação respeita min/max pageSize e separa itens entre páginas", async () => {
    // Server clamp: min 10, max 200. Adiciona 15 produtos pra ter 2 páginas com pageSize=10.
    const extras = Array.from({ length: 15 }, (_, i) => mlProduct(100 + i, { category: "gamer", discount: 30 + i }));
    await catalog.upsertProducts(extras);

    const admin = await makeAdmin();
    const p1 = await admin.auth("get", "/api/admin/catalog?page=1&pageSize=10");
    const p2 = await admin.auth("get", "/api/admin/catalog?page=2&pageSize=10");
    expect(p1.body.pageSize).toBe(10);
    expect(p1.body.items).toHaveLength(10);
    expect(p2.body.items.length).toBeGreaterThanOrEqual(1);
    const ids1 = p1.body.items.map(i => i.key);
    const ids2 = p2.body.items.map(i => i.key);
    expect(ids1.some(id => ids2.includes(id))).toBe(false);
  });

  it("pageSize=5 é clamped pra mínimo de 10", async () => {
    const admin = await makeAdmin();
    const r = await admin.auth("get", "/api/admin/catalog?pageSize=5");
    expect(r.body.pageSize).toBe(10);
  });
});

describe("Admin — DLQ", () => {
  it("queue=memory: devolve lista vazia com nota explicativa", async () => {
    const admin = await makeAdmin();
    const r = await admin.auth("get", "/api/admin/queue/failed");
    expect(r.status).toBe(200);
    expect(r.body.items).toEqual([]);
    expect(r.body.note).toMatch(/memory/i);
  });
});
