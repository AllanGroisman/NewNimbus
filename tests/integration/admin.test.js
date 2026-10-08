// Endpoints administrativos — users (list/role/password/delete), scraper config,
// catalog admin, DLQ. Cobre tanto gating (403 pra user comum) quanto comportamento.

import { describe, it, expect, beforeEach } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { request, app, createTestUser, auth as authMod, billing as billingMod, catalog, setStripeMock, waConnect, storage, affiliate } from "../helpers/app.js";
import { mlProduct, amazonProduct, shopeeProduct } from "../helpers/fixtures.js";

const require = createRequire(import.meta.url);
const { prisma } = require(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "backend", "db.js"));

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
      ["post", "/api/admin/scraper/shopee/identify"],
      ["post", "/api/admin/users/qualquer-id/manual-trial"],
      ["delete", "/api/admin/users/qualquer-id/manual-trial"],
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

    // A linha também traz os números em si: sem isso, saber QUAL número caiu
    // exigia abrir a ficha de um usuário por vez.
    const porId = Object.fromEntries(linha.numbers.map(n => [n.id, n]));
    expect(Object.keys(porId).sort()).toEqual(["n1", "n2"]);
    expect(porId.n1).toMatchObject({ label: "Um", status: "connected" });
    expect(porId.n2).toMatchObject({ label: "Dois", status: "offline" });
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

// Trial manual = cortesia liberada à mão pelo admin. Não passa pelo Stripe, não
// cobra e não consome o teste de R$1 da conta.
describe("Admin — trial manual (cortesia)", () => {
  const linhaDe = (body, id) => body.users.find(u => u.id === id);

  it("concede cortesia pra conta que nunca teve assinatura", async () => {
    const admin = await makeAdmin();
    const alvo = await createTestUser({ name: "Cortesia" });

    const res = await admin.auth("post", `/api/admin/users/${alvo.user.id}/manual-trial`)
      .send({ planId: "pro", days: 15, note: "beta tester" });
    expect(res.status).toBe(200);
    expect(res.body.manualTrial).toMatchObject({ planId: "pro", active: true });

    const list = await admin.auth("get", "/api/admin/users");
    const linha = linhaDe(list.body, alvo.user.id);
    expect(linha.subscription.manualTrialActive).toBe(true);
    expect(linha.subscription.manualTrialPlanId).toBe("pro");
    expect(linha.subscription.manualTrialDaysLeft).toBe(15);
    // O plano em vigor passa a ser o da cortesia, mesmo sem linha paga nenhuma.
    expect(linha.subscription.effectivePlanId).toBe("pro");
    expect(linha.subscription.manualTrialNote).toBe("beta tester");
  });

  it("desativar encerra na hora — volta pra free", async () => {
    const admin = await makeAdmin();
    const alvo = await createTestUser();
    await admin.auth("post", `/api/admin/users/${alvo.user.id}/manual-trial`).send({ planId: "business", days: 30 });

    const res = await admin.auth("delete", `/api/admin/users/${alvo.user.id}/manual-trial`);
    expect(res.status).toBe(200);

    const list = await admin.auth("get", "/api/admin/users");
    const linha = linhaDe(list.body, alvo.user.id);
    expect(linha.subscription.manualTrialActive).toBe(false);
    expect(linha.subscription.effectivePlanId).toBe("free");
    // O plano concedido fica como histórico — só a data de fim foi puxada pra agora.
    expect(linha.subscription.manualTrialPlanId).toBe("business");
  });

  it("conceder de novo por cima redefine plano e prazo", async () => {
    const admin = await makeAdmin();
    const alvo = await createTestUser();
    await admin.auth("post", `/api/admin/users/${alvo.user.id}/manual-trial`).send({ planId: "basic", days: 7 });
    await admin.auth("post", `/api/admin/users/${alvo.user.id}/manual-trial`).send({ planId: "business", days: 60 });

    const list = await admin.auth("get", "/api/admin/users");
    const linha = linhaDe(list.body, alvo.user.id);
    expect(linha.subscription.manualTrialPlanId).toBe("business");
    expect(linha.subscription.manualTrialDaysLeft).toBe(60);
  });

  it("recusa plano fora do catálogo e duração inválida", async () => {
    const admin = await makeAdmin();
    const alvo = await createTestUser();
    const url = `/api/admin/users/${alvo.user.id}/manual-trial`;

    expect((await admin.auth("post", url).send({ planId: "free", days: 10 })).status).toBe(400);
    expect((await admin.auth("post", url).send({ planId: "enterprise", days: 10 })).status).toBe(400);
    expect((await admin.auth("post", url).send({ planId: "pro", days: 0 })).status).toBe(400);
    expect((await admin.auth("post", url).send({ planId: "pro", days: 999 })).status).toBe(400);
    expect((await admin.auth("post", url).send({ planId: "pro", days: 2.5 })).status).toBe(400);
  });

  it("conceder despausa as campanhas que passam a caber; desativar repausa", async () => {
    const admin = await makeAdmin();
    // Nasce no Pro pra conseguir CRIAR as campanhas (no free o gating recusa),
    // e cai pra free logo em seguida — que é o estado real de quem vai ganhar
    // uma cortesia: tem campanhas, mas nenhuma delas roda.
    const alvo = await createTestUser({ name: "Despausada", plan: "pro" });
    await alvo.auth("put", "/api/state").send({
      groups: [{ id: 1, name: "Uma" }, { id: 2, name: "Duas" }, { id: 3, name: "Três" }],
      numbers: [],
    });
    await billingMod.update(alvo.user.id, { planId: "free", status: "canceled" });
    await alvo.auth("get", "/api/state"); // reconcilia os limites do plano novo

    const semPlano = await admin.auth("get", "/api/admin/users");
    expect(semPlano.body.users.find(u => u.id === alvo.user.id).counts.activeGroups).toBe(0);

    await admin.auth("post", `/api/admin/users/${alvo.user.id}/manual-trial`).send({ planId: "pro", days: 10 });
    const comCortesia = await admin.auth("get", "/api/admin/users");
    expect(comCortesia.body.users.find(u => u.id === alvo.user.id).counts.activeGroups).toBe(3);

    await admin.auth("delete", `/api/admin/users/${alvo.user.id}/manual-trial`);
    const depois = await admin.auth("get", "/api/admin/users");
    expect(depois.body.users.find(u => u.id === alvo.user.id).counts.activeGroups).toBe(0);
  });

  it("404 pra usuário inexistente; 400 ao desativar quem não tem cortesia", async () => {
    const admin = await makeAdmin();
    const alvo = await createTestUser();
    const inexistente = "00000000-0000-0000-0000-000000000000";
    expect((await admin.auth("post", `/api/admin/users/${inexistente}/manual-trial`).send({ planId: "pro", days: 5 })).status).toBe(404);
    expect((await admin.auth("delete", `/api/admin/users/${alvo.user.id}/manual-trial`)).status).toBe(400);
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

describe("Admin — identificar link de afiliado Shopee", () => {
  const GID = 1712345678901;
  const PRODUTO = "https://shopee.com.br/product/1082747237/22697179178";
  const ID = "18399999999";

  it("link já aberto: lê o dono e as marcas sem ir à rede, e acha o grupo do Nimbus", async () => {
    const admin = await makeAdmin();
    const dono = await createTestUser();
    await storage.saveState(dono.user.id, {
      groups: [{
        id: GID, name: "Ofertas Tech #1", paused: false,
        categories: [], whatsappGroupIds: [], messageTemplate: "{link}",
        scraping: { auto: false, sources: ["Shopee"], filters: {} },
        schedule: { windows: [], cooldownValue: 24, cooldownUnit: "horas" },
        queue: [], pending: [], history: [],
        sentToday: 0, sentWeek: 0, weekData: [0, 0, 0, 0, 0, 0, 0], lastSend: "—",
      }],
    });

    const url = `${PRODUTO}?mmp_pid=an_${ID}&utm_content=g${GID}----&utm_medium=affiliates&utm_source=an_${ID}`;
    const r = await admin.auth("post", "/api/admin/scraper/shopee/identify").send({ url });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      finalUrl: url,
      affiliateId: ID,
      subIds: [`g${GID}`, "", "", "", ""],
      product: { shopId: "1082747237", itemId: "22697179178" },
      grupo: { id: String(GID), name: "Ofertas Tech #1", ownerEmail: dono.user.email },
      contas: [],
    });
  });

  it("aponta a conta quando o número é o App ID do sistema ou de um usuário", async () => {
    const admin = await makeAdmin();
    const dono = await createTestUser();
    await prisma().affiliateConfig.upsert({
      where: { userId: dono.user.id },
      create: { userId: dono.user.id, data: { shopee: { appId: ID, appSecret: "segredo-qualquer-1234" } } },
      update: { data: { shopee: { appId: ID, appSecret: "segredo-qualquer-1234" } } },
    });
    affiliate.writeScraperShopeeAdminCreds({ appId: ID, appSecret: "segredo-do-sistema-1234" });
    try {
      const r = await admin.auth("post", "/api/admin/scraper/shopee/identify")
        .send({ url: `${PRODUTO}?utm_source=an_${ID}&utm_content=gurubot----` });
      expect(r.status).toBe(200);
      expect(r.body.grupo).toBeNull();
      expect(r.body.contas).toEqual([{ tipo: "sistema" }, { tipo: "usuario", email: dono.user.email }]);
    } finally {
      affiliate.clearScraperShopeeAdminCreds();
    }
  });

  it("recusa link que não é da Shopee e URL vazia", async () => {
    const admin = await makeAdmin();
    const fora = await admin.auth("post", "/api/admin/scraper/shopee/identify")
      .send({ url: "https://www.amazon.com.br/dp/B0000000?utm_source=an_123" });
    expect(fora.status).toBe(400);
    const vazio = await admin.auth("post", "/api/admin/scraper/shopee/identify").send({ url: "" });
    expect(vazio.status).toBe(400);
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
