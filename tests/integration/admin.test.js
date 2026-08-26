// Endpoints administrativos — users (list/role/password/delete), scraper config,
// catalog admin, DLQ. Cobre tanto gating (403 pra user comum) quanto comportamento.

import { describe, it, expect, beforeEach } from "vitest";
import { request, app, createTestUser, auth as authMod, catalog, setStripeMock, waConnect } from "../helpers/app.js";
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
      ["get", "/api/admin/users/qualquer-id/detail"],
      ["get", "/api/admin/scraper/config"],
      ["get", "/api/admin/scraper/status"],
      ["post", "/api/admin/scraper/run"],
      ["get", "/api/admin/catalog"],
      ["get", "/api/admin/queue/failed"],
      ["get", "/api/admin/scraper/ml/filters"],
      ["put", "/api/admin/scraper/ml/filters"],
      ["get", "/api/admin/scraper/amazon/filters"],
      ["put", "/api/admin/scraper/amazon/filters"],
      ["get", "/api/admin/scraper/shopee/filters"],
      ["put", "/api/admin/scraper/shopee/filters"],
      ["get", "/api/admin/system/disk"],
      ["get", "/api/admin/stripe"],
      ["put", "/api/admin/stripe"],
      ["get", "/api/admin/emails/templates"],
      ["put", "/api/admin/emails/templates"],
      ["post", "/api/admin/emails/preview"],
      ["post", "/api/admin/emails/test"],
      // Destrutiva: apaga a tabela de cupons inteira.
      ["delete", "/api/admin/ml-cupons"],
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
    const r = await admin.auth("patch", `/api/admin/users/${alvo.user.id}/password`).send({ newPassword: "Novasenha999" });
    expect(r.status).toBe(200);

    const login = await request(app).post("/api/auth/login").send({ email: alvo.email, password: "Novasenha999" });
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

  it("lista traz contagens que separam campanha ativa de campanha pausada", async () => {
    const admin = await makeAdmin();
    // Precisa de plano pago: no free o gating recusa criar campanha, e o
    // cenário a testar é justamente ativa x pausada.
    const alvo = await createTestUser({ name: "ComCampanhas", plan: "pro" });
    const put = await alvo.auth("put", "/api/state").send({
      groups: [
        { id: 1, name: "Viva", paused: false },
        { id: 2, name: "Pausada", paused: true },
      ],
      numbers: [{ id: "n1", label: "Um" }, { id: "n2", label: "Dois" }],
    });
    expect(put.status).toBe(200);
    // Só um dos dois números chega a conectar — é a diferença que o contador
    // cru de `whatsapp_numbers` não sabia mostrar.
    waConnect(alvo.user.id, "n1");

    const res = await admin.auth("get", "/api/admin/users");
    const linha = res.body.users.find(u => u.id === alvo.user.id);
    expect(linha.counts.groups).toBe(2);
    // O bug que isto trava: `_count.groups` contava as duas como se ambas
    // estivessem rodando, e a tela dizia "2 campanhas" pra quem tinha 1 ativa.
    expect(linha.counts.activeGroups).toBe(1);
    expect(linha.counts.numbers).toBe(2);
    expect(linha.counts.connectedNumbers).toBe(1);
  });

  it("GET /:id/detail devolve a ficha completa e nao vaza credencial de afiliado", async () => {
    const admin = await makeAdmin();
    const alvo = await createTestUser({ name: "Ficha" });

    const res = await admin.auth("get", `/api/admin/users/${alvo.user.id}/detail`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("subscription");
    expect(Array.isArray(res.body.groups)).toBe(true);
    expect(Array.isArray(res.body.numbers)).toBe(true);
    expect(Array.isArray(res.body.emails)).toBe(true);

    // Sem campanha de repasse o bloco vem nulo — zeros pareceriam falha em vez
    // de ausência.
    expect(res.body.repasse).toBeNull();

    // A rota é de leitura ampla: tag, cookie do ML e appSecret da Shopee são
    // credenciais do usuário e nao podem trafegar por aqui de forma alguma.
    const aff = JSON.stringify(res.body.affiliate);
    expect(aff).not.toMatch(/cookie|appSecret|Preview|"tag"/i);
    expect(res.body.affiliate.ml).toHaveProperty("configured");
  });

  it("GET /:id/detail devolve 404 pra usuario inexistente", async () => {
    const admin = await makeAdmin();
    const res = await admin.auth("get", "/api/admin/users/00000000-0000-0000-0000-000000000000/detail");
    expect(res.status).toBe(404);
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

describe("Admin — espaço em disco", () => {
  it("GET /system/disk devolve o disco da máquina, os backups e o banco", async () => {
    const admin = await makeAdmin();
    const r = await admin.auth("get", "/api/admin/system/disk");
    expect(r.status).toBe(200);
    expect(r.body.totalBytes).toBeGreaterThan(0);
    expect(r.body.freeBytes).toBeGreaterThan(0);
    expect(r.body.freeBytes).toBeLessThanOrEqual(r.body.totalBytes);
    expect(r.body.usedPct).toBeGreaterThanOrEqual(0);
    expect(r.body.usedPct).toBeLessThanOrEqual(100);
    expect(r.body.backups).toHaveProperty("count");
    expect(r.body.database).toHaveProperty("bytes");
    // Backblaze: só o ocupado — o B2 não expõe espaço livre. Sem credencial no
    // ambiente de teste vem configured=false, e mesmo assim a rota responde 200.
    expect(r.body.remote).toHaveProperty("configured");
    expect(r.body.remote).toHaveProperty("bytes");
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

  it("PUT /scraper/config aceita horarios fixos e normaliza a lista", async () => {
    const admin = await makeAdmin();
    const payload = { scheduleMode: "times", times: ["20:00", "08:00", "xx", "20:00"], intervalMinutes: 120 };
    const r = await admin.auth("put", "/api/admin/scraper/config").send(payload);
    expect(r.status).toBe(200);
    expect(r.body.config.scheduleMode).toBe("times");
    expect(r.body.config.times).toEqual(["08:00", "20:00"]);
    // Trocar de modo não pode apagar o intervalo escolhido antes.
    expect(r.body.config.intervalMinutes).toBe(120);

    const volta = await admin.auth("put", "/api/admin/scraper/config").send({ scheduleMode: "interval" });
    expect(volta.body.config.scheduleMode).toBe("interval");
    expect(volta.body.config.intervalMinutes).toBe(120);
    expect(volta.body.config.times).toEqual(["08:00", "20:00"]);
  });

  it("GET /scraper/status devolve running + lastRun", async () => {
    const admin = await makeAdmin();
    const r = await admin.auth("get", "/api/admin/scraper/status");
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty("running");
  });
});

describe("Admin — ScrapTester", () => {
  it("GET /scrap-tester/config lista o Hub como fonte testável", async () => {
    const admin = await makeAdmin();
    const r = await admin.auth("get", "/api/admin/scrap-tester/config");
    expect(r.status).toBe(200);
    expect(r.body.available.sources.map(s => s.id)).toContain("ml-hub");
    expect(r.body.fieldSpecs.map(s => s.key)).toContain("imgQuality");
  });

  it("PUT /scrap-tester/config persiste fonte do Hub e conferência de fotos", async () => {
    const admin = await makeAdmin();
    const payload = { sources: ["ml", "ml-hub"], checkImages: true, imageMinPx: 800, thresholds: { "ml-hub.commission": 60 } };
    const r = await admin.auth("put", "/api/admin/scrap-tester/config").send(payload);
    expect(r.status).toBe(200);
    expect(r.body.config.sources).toEqual(["ml", "ml-hub"]);
    expect(r.body.config.imageMinPx).toBe(800);
    expect(r.body.config.thresholds).toEqual({ "ml-hub.commission": 60 });

    const get = await admin.auth("get", "/api/admin/scrap-tester/config");
    expect(get.body.config.sources).toEqual(["ml", "ml-hub"]);
    expect(get.body.config.checkImages).toBe(true);
  });

  it("POST /scrap-tester/link recusa link vazio ou de domínio desconhecido", async () => {
    const admin = await makeAdmin();
    const vazio = await admin.auth("post", "/api/admin/scrap-tester/link").send({ url: "  " });
    expect(vazio.status).toBe(400);

    const estranho = await admin.auth("post", "/api/admin/scrap-tester/link").send({ url: "https://exemplo.com/produto" });
    expect(estranho.status).toBe(400);
  });

  it("rotas do ScrapTester são só de admin", async () => {
    const { auth } = await createTestUser();
    for (const [method, url] of [
      ["get", "/api/admin/scrap-tester/config"],
      ["put", "/api/admin/scrap-tester/config"],
      ["post", "/api/admin/scrap-tester/link"],
      ["get", "/api/admin/scrap-tester/history"],
    ]) {
      const res = await auth(method, url).send({});
      expect(res.status).toBe(403);
    }
  });
});

describe("Admin — Stripe (modo teste ↔ produção)", () => {
  // O mock guarda o modo em memória; volta pro default entre casos.
  beforeEach(() => setStripeMock({ mode: "test" }));

  it("GET devolve modo ativo, o que está configurado e o catálogo", async () => {
    const admin = await makeAdmin();
    const r = await admin.auth("get", "/api/admin/stripe");
    expect(r.status).toBe(200);
    expect(r.body.mode).toBe("test");
    expect(r.body.modes.test.hasSecret).toBe(true);
    expect(r.body.modes.live).toBeDefined();
    // Nunca devolve segredo, só se existe.
    expect(JSON.stringify(r.body)).not.toMatch(/sk_/);
    expect(r.body.catalog.map(p => p.id)).toEqual(["basic", "pro", "business"]);
  });

  it("PUT troca o modo e a troca persiste", async () => {
    const admin = await makeAdmin();
    const r = await admin.auth("put", "/api/admin/stripe").send({ mode: "live" });
    expect(r.status).toBe(200);
    expect(r.body.mode).toBe("live");

    const get = await admin.auth("get", "/api/admin/stripe");
    expect(get.body.mode).toBe("live");
  });

  it("modo inválido → 400 e nada muda", async () => {
    const admin = await makeAdmin();
    const r = await admin.auth("put", "/api/admin/stripe").send({ mode: "producao" });
    expect(r.status).toBe(400);
    const get = await admin.auth("get", "/api/admin/stripe");
    expect(get.body.mode).toBe("test");
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

describe("Admin — scraper filters ML", () => {
  it("GET /scraper/ml/filters devolve filtros com defaults", async () => {
    const admin = await makeAdmin();
    const r = await admin.auth("get", "/api/admin/scraper/ml/filters");
    expect(r.status).toBe(200);
    expect(r.body.filters).toBeDefined();
    expect(typeof r.body.filters.minRating).toBe("number");
    expect(typeof r.body.filters.minSales).toBe("number");
    expect(r.body.defaults).toBeDefined();
  });

  it("PUT /scraper/ml/filters persiste e valida campos", async () => {
    const admin = await makeAdmin();
    const payload = { minRating: 4.2, minSales: 75, minPrice: 25, maxPrice: 3000, maxDiscount: 80 };
    const r = await admin.auth("put", "/api/admin/scraper/ml/filters").send(payload);
    expect(r.status).toBe(200);
    expect(r.body.filters.minRating).toBeCloseTo(4.2);
    expect(r.body.filters.minSales).toBe(75);
    expect(r.body.filters.maxDiscount).toBe(80);

    const get = await admin.auth("get", "/api/admin/scraper/ml/filters");
    expect(get.body.filters.minRating).toBeCloseTo(4.2);
  });

  it("PUT /scraper/ml/filters clampeia minRating > 5 para 5", async () => {
    const admin = await makeAdmin();
    const r = await admin.auth("put", "/api/admin/scraper/ml/filters").send({ minRating: 9 });
    expect(r.status).toBe(200);
    expect(r.body.filters.minRating).toBe(5);
  });

  it("PUT /scraper/ml/filters clampeia maxDiscount > 100 para 100", async () => {
    const admin = await makeAdmin();
    const r = await admin.auth("put", "/api/admin/scraper/ml/filters").send({ maxDiscount: 150 });
    expect(r.status).toBe(200);
    expect(r.body.filters.maxDiscount).toBe(100);
  });
});

describe("Admin — scraper filters Amazon", () => {
  it("GET /scraper/amazon/filters devolve filtros com defaults", async () => {
    const admin = await makeAdmin();
    const r = await admin.auth("get", "/api/admin/scraper/amazon/filters");
    expect(r.status).toBe(200);
    expect(r.body.filters).toBeDefined();
    expect(typeof r.body.filters.minRating).toBe("number");
    expect(typeof r.body.filters.minReviews).toBe("number");
    expect(r.body.defaults).toBeDefined();
  });

  it("PUT /scraper/amazon/filters persiste e valida campos", async () => {
    const admin = await makeAdmin();
    const payload = { minRating: 4.0, minReviews: 30, minPrice: 15, maxPrice: 2000, maxDiscount: 85 };
    const r = await admin.auth("put", "/api/admin/scraper/amazon/filters").send(payload);
    expect(r.status).toBe(200);
    expect(r.body.filters.minReviews).toBe(30);
    expect(r.body.filters.minRating).toBeCloseTo(4.0);

    const get = await admin.auth("get", "/api/admin/scraper/amazon/filters");
    expect(get.body.filters.minReviews).toBe(30);
  });

  it("PUT /scraper/amazon/filters clampeia minRating > 5 para 5", async () => {
    const admin = await makeAdmin();
    const r = await admin.auth("put", "/api/admin/scraper/amazon/filters").send({ minRating: 10 });
    expect(r.status).toBe(200);
    expect(r.body.filters.minRating).toBe(5);
  });

  it("ignora campos negativos (usa 0 como mínimo)", async () => {
    const admin = await makeAdmin();
    const r = await admin.auth("put", "/api/admin/scraper/amazon/filters").send({ minReviews: -5 });
    expect(r.status).toBe(200);
    expect(r.body.filters.minReviews).toBeGreaterThanOrEqual(0);
  });
});

describe("Admin — scraper filters Shopee", () => {
  it("GET /scraper/shopee/filters devolve filtros com defaults", async () => {
    const admin = await makeAdmin();
    const r = await admin.auth("get", "/api/admin/scraper/shopee/filters");
    expect(r.status).toBe(200);
    expect(r.body.filters).toBeDefined();
    expect(typeof r.body.filters.minRating).toBe("number");
    expect(typeof r.body.filters.minCommissionRate).toBe("number");
    expect(r.body.defaults).toBeDefined();
  });

  it("PUT /scraper/shopee/filters persiste e devolve filtros atualizados", async () => {
    const admin = await makeAdmin();
    const payload = { minRating: 4.0, minSales: 100, minPrice: 20, maxPrice: 0, minCommissionRate: 0.03, maxDiscount: 95 };
    const r = await admin.auth("put", "/api/admin/scraper/shopee/filters").send(payload);
    expect(r.status).toBe(200);
    expect(r.body.filters.minSales).toBe(100);
    expect(r.body.filters.maxDiscount).toBe(95);
  });

  it("PUT /scraper/shopee/filters aceita minCommissionRate como inteiro (converte 5 -> 0.05)", async () => {
    const admin = await makeAdmin();
    const r = await admin.auth("put", "/api/admin/scraper/shopee/filters").send({ minCommissionRate: 5 });
    expect(r.status).toBe(200);
    expect(r.body.filters.minCommissionRate).toBeCloseTo(0.05);
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
