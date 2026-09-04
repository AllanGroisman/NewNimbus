// Endpoints WhatsApp — sessões, grupos, envios. WA mockado em wa-mock.js
// registra chamadas pra inspeção. Plan-gating de número novo testado aqui.

import { describe, it, expect, beforeEach } from "vitest";
import { request, app, createTestUser, waCalls, resetWa, waFailSend, auth as authMod, billing } from "../helpers/app.js";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __require = createRequire(import.meta.url);
const whatsnimbus = __require(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "backend", "notifications", "whatsnimbus.js"));

// Helper pra forçar plano específico no usuário recém-criado (que nasce sem assinatura = free).
async function userOnPlan(planId) {
  const u = await createTestUser();
  await billing.update(u.user.id, {
    planId,
    status: "active",
    currentPeriodEnd: new Date(Date.now() + 30 * 86400e3),
  });
  return u;
}

// Registra números (e opcionalmente grupos de WhatsApp) no estado do usuário.
// As rotas de envio direto viraram whitelist: só despacham por número que está
// em `state.numbers` — número com sessão viva mas fora do estado não é pausável
// pelo plano, e era por aí que dava pra furar o limite depois de um downgrade.
async function registerNumbers(auth, ids, whatsappGroups = []) {
  const r = await auth("put", "/api/state").send({
    groups: [],
    numbers: ids.map(id => ({ id, phone: `5511${id}` })),
    whatsappGroups,
  });
  expect(r.status, "registro de números no estado").toBe(200);
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

  it("user com plano pro consegue criar 1 sessão", async () => {
    const { auth } = await createTestUser({ plan: "pro" });
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
    // Mensagem é em pt-BR, pro cliente entender o que fazer (limits.js).
    expect(fourth.body.error).toMatch(/números de WhatsApp/i);
    expect(fourth.body.code).toBe("plan_limit");
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
    const { auth } = await createTestUser({ plan: "pro" });
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

  it("POST /groups exige name", async () => {
    const { auth } = await userOnPlan("pro");
    await auth("post", "/api/whatsapp/sessions/num-1");
    const sem = await auth("post", "/api/whatsapp/sessions/num-1/groups").send({});
    expect(sem.status).toBe(400);
  });

  // Sem participantes o backend usa o próprio número do criador (o WhatsApp
  // exige ao menos 1 além dele). Só dá 400 quando não há sessão pra consultar.
  it("POST /groups sem participants cria com o próprio número", async () => {
    const { auth } = await userOnPlan("pro");
    await auth("post", "/api/whatsapp/sessions/num-1");
    const r = await auth("post", "/api/whatsapp/sessions/num-1/groups").send({ name: "G", participants: [] });
    expect(r.status).toBe(200);
    expect(waCalls.createGroup[0].participants).toEqual(["5511999999999"]);
  });

  it("POST /groups sem sessão retorna 400", async () => {
    const { auth } = await userOnPlan("pro");
    const r = await auth("post", "/api/whatsapp/sessions/num-sem-sessao/groups").send({ name: "G", participants: [] });
    expect(r.status).toBe(400);
  });

  it("POST /groups cria com sucesso", async () => {
    const { auth } = await userOnPlan("pro");
    await auth("post", "/api/whatsapp/sessions/num-1");
    const r = await auth("post", "/api/whatsapp/sessions/num-1/groups").send({
      name: "Promos Teste",
      participants: ["5511999999999"],
    });
    expect(r.status).toBe(200);
    expect(r.body.name).toBe("Promos Teste");
    expect(waCalls.createGroup).toHaveLength(1);
  });

  // Criar grupo real no WhatsApp não passava por gating nenhum — o limite por
  // campanha só é cobrado no PUT /api/state. Teto global = campanhas × grupos
  // por campanha (basic = 1 × 3).
  it("POST /groups respeita o teto global do plano (basic = 3)", async () => {
    const { auth } = await userOnPlan("basic");
    await auth("post", "/api/whatsapp/sessions/num-1");
    const wgs = ["a@g.us", "b@g.us", "c@g.us"].map((jid, i) => ({
      id: jid, jid, numberId: "num-1", name: `G${i + 1}`,
    }));
    await registerNumbers(auth, ["num-1"], wgs);
    const r = await auth("post", "/api/whatsapp/sessions/num-1/groups")
      .send({ name: "Quarto", participants: ["5511999999999"] });
    expect(r.status).toBe(402);
    expect(r.body.code).toBe("plan_limit");
    expect(r.body.limit).toBe(3);
    expect(waCalls.createGroup).toHaveLength(0);
  });
});

describe("WhatsApp — envio direto via /send", () => {
  it("rejeita sem jid", async () => {
    const { auth } = await userOnPlan("pro");
    await auth("post", "/api/whatsapp/sessions/num-1");
    await registerNumbers(auth, ["num-1"]);
    const r = await auth("post", "/api/whatsapp/sessions/num-1/send").send({ text: "oi" });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/jid/);
  });

  it("rejeita sem text e sem imageUrl", async () => {
    const { auth } = await userOnPlan("pro");
    await auth("post", "/api/whatsapp/sessions/num-1");
    await registerNumbers(auth, ["num-1"]);
    const r = await auth("post", "/api/whatsapp/sessions/num-1/send").send({ jid: "x@g.us" });
    expect(r.status).toBe(400);
  });

  it("envia texto puro", async () => {
    const { auth } = await userOnPlan("pro");
    await auth("post", "/api/whatsapp/sessions/num-1");
    await registerNumbers(auth, ["num-1"]);
    const r = await auth("post", "/api/whatsapp/sessions/num-1/send").send({ jid: "x@g.us", text: "olá" });
    expect(r.status).toBe(200);
    expect(waCalls.sendText).toHaveLength(1);
    expect(waCalls.sendText[0]).toMatchObject({ jid: "x@g.us", text: "olá" });
  });

  it("envia imagem quando imageUrl presente (text vira caption)", async () => {
    const { auth } = await userOnPlan("pro");
    await auth("post", "/api/whatsapp/sessions/num-1");
    await registerNumbers(auth, ["num-1"]);
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

describe("WhatsApp — teste de conexão (/test)", () => {
  // A config do WhatsNimbus vive num cache write-through em memória
  // (backend/config/pg.js), então o TRUNCATE entre testes não a invalida sozinho.
  beforeEach(() => { whatsnimbus.clearConfig(); });

  it("sem token retorna 401", async () => {
    const r = await request(app).post("/api/whatsapp/sessions/num-1/test");
    expect(r.status).toBe(401);
  });

  it("número fora do estado retorna 402 (herda o requireUsableNumber)", async () => {
    const { auth } = await userOnPlan("pro");
    await auth("post", "/api/whatsapp/sessions/num-1");
    // sem registerNumbers: sessão viva, mas número não cadastrado no estado
    const r = await auth("post", "/api/whatsapp/sessions/num-1/test");
    expect(r.status).toBe(402);
    expect(r.body.code).toBe("number_not_registered");
    expect(waCalls.sendText).toHaveLength(0);
  });

  it("as duas pernas passam: auto-DM do próprio número + DM do WhatsNimbus", async () => {
    const { user, auth } = await userOnPlan("pro");
    await auth("post", "/api/whatsapp/sessions/num-1");
    await registerNumbers(auth, ["num-1"]);
    whatsnimbus.writeConfig({ numberId: "5511888888888", phone: "5511888888888" });

    const r = await auth("post", "/api/whatsapp/sessions/num-1/test");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, self: { ok: true }, whatsnimbus: { ok: true } });

    expect(waCalls.sendText).toHaveLength(2);
    // Perna 1: o PRÓPRIO número mandando pra ele mesmo (jid = seu telefone).
    expect(waCalls.sendText[0]).toMatchObject({
      userId: user.id, numberId: "num-1", jid: "5511999999999@s.whatsapp.net",
    });
    // Perna 2: remetente é o userId sintético do WhatsNimbus, destino é o usuário.
    expect(waCalls.sendText[1]).toMatchObject({
      userId: whatsnimbus.WHATSNIMBUS_USER_ID,
      numberId: "5511888888888",
      jid: "5511999999999@s.whatsapp.net",
    });
  });

  it("WhatsNimbus não conectado: perna 2 vira `skipped` e NÃO reprova o teste", async () => {
    const { auth } = await userOnPlan("pro");
    await auth("post", "/api/whatsapp/sessions/num-1");
    await registerNumbers(auth, ["num-1"]);

    const r = await auth("post", "/api/whatsapp/sessions/num-1/test");
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);          // o que importa é o número do usuário
    expect(r.body.self.ok).toBe(true);
    expect(r.body.whatsnimbus).toMatchObject({ ok: false, skipped: true });
    expect(r.body.whatsnimbus.error).toMatch(/WhatsNimbus não está conectado/);
    expect(waCalls.sendText).toHaveLength(1);
  });

  it("sessão do usuário caída: `ok:false` com a mensagem, mas a perna do WhatsNimbus ainda roda", async () => {
    const { auth } = await userOnPlan("pro");
    await auth("post", "/api/whatsapp/sessions/num-1");
    await registerNumbers(auth, ["num-1"]);
    whatsnimbus.writeConfig({ numberId: "5511888888888", phone: "5511888888888" });
    waFailSend("Sessão não está conectada (status: disconnected).");

    const r = await auth("post", "/api/whatsapp/sessions/num-1/test");
    // 200: resultado parcial é diagnóstico bem-sucedido, não erro de servidor.
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(false);
    expect(r.body.self.ok).toBe(false);
    expect(r.body.self.error).toMatch(/não está conectada/);
    // A perna 2 tentou (e falhou junto, porque o mock derruba todo sendText) —
    // o que importa é que a falha da perna 1 não abortou a rota.
    expect(r.body.whatsnimbus.ok).toBe(false);
    expect(r.body.whatsnimbus.skipped).toBeUndefined();
  });
});

describe("WhatsApp — broadcast", () => {
  const wgs = ["a@g.us", "b@g.us", "c@g.us"].map((jid, i) => ({
    id: jid, jid, numberId: "num-1", name: `G${i + 1}`,
  }));

  it("envia pra múltiplos jids", async () => {
    const { auth } = await userOnPlan("pro");
    await auth("post", "/api/whatsapp/sessions/num-1");
    await registerNumbers(auth, ["num-1"], wgs);
    const r = await auth("post", "/api/whatsapp/sessions/num-1/broadcast").send({
      jids: ["a@g.us", "b@g.us", "c@g.us"],
      text: "promoção",
      intervalMs: 0,
    });
    expect(r.status).toBe(200);
    expect(waCalls.sendText.length).toBeGreaterThanOrEqual(3);
  });

  // O broadcast era um caminho paralelo sem plano nenhum: aceitava qualquer
  // lista de jids, de qualquer tamanho. Dava pra criar 50 grupos pela API e
  // disparar pra todos no Básico (limite 3 por campanha).
  it("recusa jid que não está cadastrado neste número", async () => {
    const { auth } = await userOnPlan("pro");
    await auth("post", "/api/whatsapp/sessions/num-1");
    await registerNumbers(auth, ["num-1"], wgs);
    const r = await auth("post", "/api/whatsapp/sessions/num-1/broadcast").send({
      jids: ["a@g.us", "intruso@g.us"], text: "promoção", intervalMs: 0,
    });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("unknown_jid");
    expect(waCalls.sendText).toHaveLength(0);
  });

  it("recusa mais jids que o limite do plano (basic = 3)", async () => {
    const { auth } = await userOnPlan("basic");
    await auth("post", "/api/whatsapp/sessions/num-1");
    const quatro = ["a@g.us", "b@g.us", "c@g.us", "d@g.us"].map((jid, i) => ({
      id: jid, jid, numberId: "num-1", name: `G${i + 1}`,
    }));
    await registerNumbers(auth, ["num-1"], quatro);
    const r = await auth("post", "/api/whatsapp/sessions/num-1/broadcast").send({
      jids: quatro.map(w => w.jid), text: "promoção", intervalMs: 0,
    });
    expect(r.status).toBe(402);
    expect(r.body.code).toBe("plan_limit");
    expect(r.body.key).toBe("whatsappGroupsPerCampaign");
    expect(waCalls.sendText).toHaveLength(0);
  });
});

// Furo fechado: a pausa por plano só marca número que existe em `state.numbers`
// (enforce.js descarta id desconhecido). Quem caía de Pro pra Básico apagava os
// números pausados da lista, mantinha as sessões vivas e seguia enviando pelos
// três — o número virava impausável por construção. Agora é whitelist.
describe("WhatsApp — número fora do estado não envia", () => {
  it("/send responde 402 quando o número não está cadastrado no estado", async () => {
    const { auth } = await userOnPlan("pro");
    await auth("post", "/api/whatsapp/sessions/num-1");
    await auth("post", "/api/whatsapp/sessions/num-2");
    // Só num-1 fica no estado; num-2 continua com a sessão viva.
    await registerNumbers(auth, ["num-1"]);
    const r = await auth("post", "/api/whatsapp/sessions/num-2/send")
      .send({ jid: "x@g.us", text: "olá" });
    expect(r.status).toBe(402);
    expect(r.body.code).toBe("number_not_registered");
    expect(waCalls.sendText).toHaveLength(0);
  });

  it("downgrade Pro→Básico: apagar o número pausado do estado não libera o envio", async () => {
    const { auth, user } = await userOnPlan("pro");
    for (const id of ["num-1", "num-2", "num-3"]) {
      await auth("post", `/api/whatsapp/sessions/${id}`);
    }
    await registerNumbers(auth, ["num-1", "num-2", "num-3"]);
    await billing.update(user.id, { planId: "basic", status: "active" });
    // Reconcilia (pausa 2) e depois "limpa a lista" deixando só num-1.
    await auth("get", "/api/state");
    await registerNumbers(auth, ["num-1"]);

    for (const id of ["num-2", "num-3"]) {
      const r = await auth("post", `/api/whatsapp/sessions/${id}/send`)
        .send({ jid: "x@g.us", text: "olá" });
      expect(r.status, `envio por ${id}`).toBe(402);
    }
    expect(waCalls.sendText).toHaveLength(0);
  });
});

// As rotas de envio direto passaram a exigir assinatura ativa. Antes, quem
// cancelava continuava enviando por elas na mão — o gate só existia no envio
// automático do scheduler.
describe("WhatsApp — envio exige assinatura ativa", () => {
  it("/send responde 402 com assinatura cancelada", async () => {
    const { auth, user } = await createTestUser();
    await auth("post", "/api/whatsapp/sessions/num-1");
    await billing.update(user.id, { planId: "pro", status: "canceled" });
    const r = await auth("post", "/api/whatsapp/sessions/num-1/send")
      .send({ jid: "x@g.us", text: "olá" });
    expect(r.status).toBe(402);
    expect(r.body.code).toBe("subscription_inactive");
    expect(waCalls.sendText).toHaveLength(0);
  });

  it("/broadcast responde 402 com assinatura cancelada", async () => {
    const { auth, user } = await createTestUser();
    await auth("post", "/api/whatsapp/sessions/num-1");
    await billing.update(user.id, { planId: "pro", status: "canceled" });
    const r = await auth("post", "/api/whatsapp/sessions/num-1/broadcast")
      .send({ jids: ["a@g.us"], text: "promoção", intervalMs: 0 });
    expect(r.status).toBe(402);
    expect(waCalls.sendText).toHaveLength(0);
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
