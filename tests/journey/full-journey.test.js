// JORNADA COMPLETA DO USUARIO — simula o que um usuario real faz na primeira sessao:
//
// 1. Registra conta
// 2. Verifica que /api/auth/me funciona
// 3. Configura afiliado Amazon
// 4. Admin (outro user) atualiza catalogo
// 5. Usuario cria uma campanha (group) vinculada a um WhatsApp group
// 6. Forca refill — campanha recebe candidatos
// 7. Envia 1 produto manualmente (manual-add)
// 8. Dispara "Enviar agora" — checa que o mock recebeu chamada de envio
// 9. Limpa historico

import { describe, it, expect, beforeAll } from "vitest";
import { createTestUser, catalog, affiliate, waCalls, resetWa, waConnect } from "../helpers/app.js";
import { mlProduct, amazonProduct, makeGroup, makeWhatsAppGroup } from "../helpers/fixtures.js";
import { truncateAll } from "../helpers/pg-helpers.js";

describe("Jornada completa — primeira sessao do usuario", () => {
  let user;
  beforeAll(async () => {
    // Esta jornada depende de estado acumulado entre `it` blocks — opta por
    // pular o truncate-between-tests do setup-each.js. Trunca uma vez aqui.
    globalThis.__NIMBUS_SKIP_TRUNCATE_BETWEEN_TESTS = true;
    await truncateAll();
    resetWa();
  });

  it("etapa 1: usuario registra conta", async () => {
    user = await createTestUser({ name: "Carlos", plan: "pro" });
    expect(user.user.id).toBeTruthy();
    expect(user.token).toBeTruthy();
  });

  it("etapa 2: /me funciona com o token", async () => {
    const me = await user.auth("get", "/api/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.user.name).toBe("Carlos");
    expect(me.body.user.role).toBe("user");
  });

  it("etapa 3: configura afiliado Amazon", async () => {
    const res = await user.auth("put", "/api/affiliate/amazon").send({ tag: "carlos-test-20" });
    expect(res.status).toBe(200);
    expect(res.body.amazon.configured).toBe(true);
    affiliate.writeConfig(user.user.id, { tag: "ml-test", cookie: "ml-cookie-sessid" });
  });

  it("etapa 4: admin atualiza catalogo (via call direta — sem rodar puppeteer)", async () => {
    await catalog.upsertProducts([
      amazonProduct(501, { category: "eletronicos", discount: 35 }),
      amazonProduct(502, { category: "eletronicos", discount: 55 }),
      mlProduct(503, { category: "eletronicos", discount: 25 }),
    ]);
    const stats = await catalog.getStats();
    expect(stats.total).toBeGreaterThan(0);
  });

  it("etapa 5: cria WhatsApp group + campanha vinculada", async () => {
    const waGroup = makeWhatsAppGroup({ id: "wa-jornada", numberId: "num-jornada", jid: "jornada@g.us" });
    const group = makeGroup({
      id: 5000,
      name: "Eletronicos top",
      categories: ["eletronicos"],
      sources: ["amazon", "ml"],
      whatsappGroupIds: ["wa-jornada"],
      filters: { minDiscount: 30 },
    });
    const res = await user.auth("put", "/api/state").send({
      groups: [group],
      whatsappGroups: [waGroup],
      numbers: [{ id: "num-jornada", phone: "5511999999999" }],
    });
    expect(res.status).toBe(200);

    const get = await user.auth("get", "/api/state");
    expect(get.body.groups).toHaveLength(1);
    expect(get.body.whatsappGroups).toHaveLength(1);
  });

  it("etapa 6: forca refill — campanha recebe candidatos do catalogo", async () => {
    const r = await user.auth("post", "/api/state/groups/5000/refill").send({});
    expect(r.status).toBe(200);
    expect(r.body.queueSize).toBeGreaterThan(0);

    const state = await user.auth("get", "/api/state");
    const g = state.body.groups.find(g => g.id === 5000);
    for (const item of g.queue) {
      expect(item.discount).toBeGreaterThanOrEqual(30);
    }
  });

  it("etapa 7: adiciona produto manualmente via URL", async () => {
    const r = await user.auth("post", "/api/state/groups/5000/manual-add").send({
      url: "https://www.amazon.com.br/dp/B0CMANUAL777",
      overrides: { name: "Headset Premium", price: 299, originalPrice: 599, discount: 50, store: "Amazon" },
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.target).toBe("queue");
  });

  it("etapa 8: dispara 'Enviar agora' — chama wa.sendText/Image", async () => {
    resetWa();
    waConnect(user.user.id, "num-jornada"); // simula QR escaneado — whatsappGate exige sessão conectada
    const r = await user.auth("post", "/api/state/groups/5000/send-now");
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.sent).toBeGreaterThanOrEqual(1);
    const total = waCalls.sendText.length + waCalls.sendImage.length;
    expect(total).toBeGreaterThanOrEqual(1);

    const ops = await user.auth("get", "/api/state/ops");
    const g = ops.body.groups.find(g => g.id === 5000);
    expect(g.history.length).toBeGreaterThanOrEqual(1);
    expect(g.sentToday).toBeGreaterThanOrEqual(1);
  });

  it("etapa 9: limpa historico — reset cooldown", async () => {
    const r = await user.auth("delete", "/api/state/groups/5000/history");
    expect(r.status).toBe(200);
    const ops = await user.auth("get", "/api/state/ops");
    const g = ops.body.groups.find(g => g.id === 5000);
    expect(g.history).toHaveLength(0);
    expect(g.sentToday).toBe(0);
  });

  it("etapa 10: bloqueio quando ML desconfigurado e campanha usa ML", async () => {
    affiliate.clearConfig(user.user.id);
    const r = await user.auth("post", "/api/state/groups/5000/send-now");
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/afiliado|configure|pausada/i);
  });
});

describe("Jornada — multiplos usuarios isolados", () => {
  it("user A nao ve estado de user B", async () => {
    const userA = await createTestUser({ name: "A", plan: "pro" });
    const userB = await createTestUser({ name: "B", plan: "pro" });

    await userA.auth("put", "/api/state").send({
      groups: [makeGroup({ id: 1, name: "Apenas de A" })],
    });

    const stateB = await userB.auth("get", "/api/state");
    expect(stateB.body.groups).toEqual([]);

    const stateA = await userA.auth("get", "/api/state");
    expect(stateA.body.groups).toHaveLength(1);
    expect(stateA.body.groups[0].name).toBe("Apenas de A");
  });
});
