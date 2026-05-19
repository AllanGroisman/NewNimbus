// Endpoints WhatsApp — sessões, grupos, envios. WA mockado em wa-mock.js
// registra chamadas pra inspeção. Plan-gating de número novo testado aqui.

import { describe, it, expect, beforeEach } from "vitest";
import { request, app, createTestUser, waCalls, resetWa, auth as authMod, billing } from "../helpers/app.js";

// Helper pra forçar plano específico no usuário recém-criado (que nasce em trial pro).
async function userOnPlan(planId) {
  const u = await createTestUser();
  await billing.update(u.user.id, {
    planId,
    status: "active",
    currentPeriodEnd: new Date(Date.now() + 30 * 86400e3),
  });
  return u;
}

describe("WhatsApp — sessões (gating + auth)", () => {
  it("sem token retorna 401 em todas as rotas", async () => {
    const rotas = [
      ["get", "/api/whatsapp/sessions"],
      ["post", "/api/whatsapp/sessions/num-1"],
      ["get", "/api/whatsapp/sessions/num-1"],
      ["delete", "/api/whatsapp/sessions/num-1"],
      ["get", "/api/whatsapp/sessions/num-1/groups"],
    ];
    for (const [m, u] of rotas) {
      const r = await request(app)[m](u);
      expect(r.status, `${m.toUpperCase()} ${u}`).toBe(401);
    }
  });

  it("lista vazia pra user novo", async () => {
    const { auth } = await createTestUser();
    const r = await auth("get", "/api/whatsapp/sessions");
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
    expect(r.body).toEqual([]);
  });

  it("user em trial (pro) consegue criar 1 sessão", async () => {
    // Register cria trial automático = pro, status=trialing
    const { auth } = await createTestUser();
    const r = await auth("post", "/api/whatsapp/sessions/num-1");
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(waCalls.startSession).toHaveLength(1);
  });

  it("user pro pode criar até 3 sessões; a 4ª retorna 402", async () => {
    const u = await userOnPlan("pro");
    for (let i = 1; i <= 3; i++) {
      const r = await u.auth("post", `/api/whatsapp/sessions/num-${i}`);
      expect(r.status, `criação ${i}`).toBe(200);
    }
    const fourth = await u.auth("post", "/api/whatsapp/sessions/num-4");
    expect(fourth.status).toBe(402);
    expect(fourth.body.error).toMatch(/numbers/i);
    expect(fourth.body.limit).toBe(3);
    expect(fourth.body.current).toBe(4);
    expect(fourth.body.planRequired).toBe("business");
  });

  it("user basic só pode criar 1 sessão; 2ª retorna 402 com planRequired=pro", async () => {
    const u = await userOnPlan("basic");
    const r1 = await u.auth("post", "/api/whatsapp/sessions/num-1");
    expect(r1.status).toBe(200);
    const r2 = await u.auth("post", "/api/whatsapp/sessions/num-2");
    expect(r2.status).toBe(402);
    expect(r2.body.planRequired).toBe("pro");
  });

  it("re-conectar sessão já criada NÃO conta como nova (não estoura limite)", async () => {
    const u = await userOnPlan("basic"); // limite 1
    await u.auth("post", "/api/whatsapp/sessions/num-1");
    // Mesma id de novo — não deve disparar 402
    const r = await u.auth("post", "/api/whatsapp/sessions/num-1");
    expect(r.status).toBe(200);
  });

  it("admin bypass: pode criar quantas sessões quiser", async () => {
    const u = await createTestUser();
    await authMod.setUserRole(u.user.id, "admin");
    for (let i = 1; i <= 5; i++) {
      const r = await u.auth("post", `/api/whatsapp/sessions/num-${i}`);
      expect(r.status, `admin criação ${i}`).toBe(200);
    }
  });
});

describe("WhatsApp — sessão (GET/DELETE)", () => {
  it("GET 404 quando sessão não existe", async () => {
    const { auth } = await createTestUser();
    const r = await auth("get", "/api/whatsapp/sessions/inexistente");
    expect(r.status).toBe(404);
  });

  it("GET retorna shape esperado depois de start", async () => {
    const { auth } = await createTestUser();
    await auth("post", "/api/whatsapp/sessions/num-1");
    const r = await auth("get", "/api/whatsapp/sessions/num-1");
    expect(r.status).toBe(200);
    expect(r.body.id).toBe("num-1");
    expect(r.body.status).toBe("open");
    expect(r.body).toHaveProperty("qr");
    expect(r.body).toHaveProperty("info");
  });

  it("DELETE remove sessão e chama mock", async () => {
    const { auth } = await createTestUser();
    await auth("post", "/api/whatsapp/sessions/num-x");
    const r = await auth("delete", "/api/whatsapp/sessions/num-x");
    expect(r.status).toBe(200);
    expect(waCalls.deleteSession).toHaveLength(1);
    expect(waCalls.deleteSession[0].numberId).toBe("num-x");
  });
});

describe("WhatsApp — grupos", () => {
  it("GET /groups chama o mock", async () => {
    const { auth } = await createTestUser();
    await auth("post", "/api/whatsapp/sessions/num-1");
    const r = await auth("get", "/api/whatsapp/sessions/num-1/groups");
    expect(r.status).toBe(200);
    expect(waCalls.listGroups).toHaveLength(1);
  });

  it("POST /groups exige name + participants", async () => {
    const { auth } = await createTestUser();
    await auth("post", "/api/whatsapp/sessions/num-1");
    const sem = await auth("post", "/api/whatsapp/sessions/num-1/groups").send({});
    expect(sem.status).toBe(400);

    const semPart = await auth("post", "/api/whatsapp/sessions/num-1/groups").send({ name: "G", participants: [] });
    expect(semPart.status).toBe(400);
  });

  it("POST /groups cria com sucesso", async () => {
    const { auth } = await createTestUser();
    await auth("post", "/api/whatsapp/sessions/num-1");
    const r = await auth("post", "/api/whatsapp/sessions/num-1/groups").send({
      name: "Promos Teste",
      participants: ["5511999999999"],
    });
    expect(r.status).toBe(200);
    expect(r.body.name).toBe("Promos Teste");
    expect(waCalls.createGroup).toHaveLength(1);
  });
});

describe("WhatsApp — envio direto via /send", () => {
  it("rejeita sem jid", async () => {
    const { auth } = await createTestUser();
    await auth("post", "/api/whatsapp/sessions/num-1");
    const r = await auth("post", "/api/whatsapp/sessions/num-1/send").send({ text: "oi" });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/jid/);
  });

  it("rejeita sem text e sem imageUrl", async () => {
    const { auth } = await createTestUser();
    await auth("post", "/api/whatsapp/sessions/num-1");
    const r = await auth("post", "/api/whatsapp/sessions/num-1/send").send({ jid: "x@g.us" });
    expect(r.status).toBe(400);
  });

  it("envia texto puro", async () => {
    const { auth } = await createTestUser();
    await auth("post", "/api/whatsapp/sessions/num-1");
    const r = await auth("post", "/api/whatsapp/sessions/num-1/send").send({ jid: "x@g.us", text: "olá" });
    expect(r.status).toBe(200);
    expect(waCalls.sendText).toHaveLength(1);
    expect(waCalls.sendText[0]).toMatchObject({ jid: "x@g.us", text: "olá" });
  });

  it("envia imagem quando imageUrl presente (text vira caption)", async () => {
    const { auth } = await createTestUser();
    await auth("post", "/api/whatsapp/sessions/num-1");
    const r = await auth("post", "/api/whatsapp/sessions/num-1/send").send({
      jid: "x@g.us", text: "legenda", imageUrl: "https://img.test/a.jpg",
    });
    expect(r.status).toBe(200);
    expect(waCalls.sendImage).toHaveLength(1);
    expect(waCalls.sendImage[0]).toMatchObject({
      jid: "x@g.us", imageUrl: "https://img.test/a.jpg", caption: "legenda",
    });
  });
});

describe("WhatsApp — broadcast", () => {
  it("envia pra múltiplos jids", async () => {
    const { auth } = await createTestUser();
    await auth("post", "/api/whatsapp/sessions/num-1");
    const r = await auth("post", "/api/whatsapp/sessions/num-1/broadcast").send({
      jids: ["a@g.us", "b@g.us", "c@g.us"],
      text: "promoção",
      intervalMs: 0,
    });
    expect(r.status).toBe(200);
    expect(waCalls.sendText.length).toBeGreaterThanOrEqual(3);
  });
});

describe("WhatsApp — invite link", () => {
  it("GET invite retorna link", async () => {
    const { auth } = await createTestUser();
    await auth("post", "/api/whatsapp/sessions/num-1");
    const r = await auth("get", "/api/whatsapp/sessions/num-1/groups/x@g.us/invite");
    expect(r.status).toBe(200);
    expect(r.body.inviteLink).toMatch(/^https:\/\/chat\.whatsapp\.com\//);
  });

  it("POST revoke retorna novo link", async () => {
    const { auth } = await createTestUser();
    await auth("post", "/api/whatsapp/sessions/num-1");
    const r = await auth("post", "/api/whatsapp/sessions/num-1/groups/x@g.us/invite/revoke");
    expect(r.status).toBe(200);
    expect(r.body.inviteLink).toMatch(/revoked/);
  });
});
