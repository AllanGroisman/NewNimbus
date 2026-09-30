// Mensagem no privado para os membros dos grupos destino (tasks 4 e 6).
//
// O que estes testes protegem:
//  - a função é só de admin, e só para os grupos destino DA campanha;
//  - cada pessoa recebe uma vez, mesmo estando em dois grupos;
//  - o envio para sozinho: teto diário, número caído, 5 falhas seguidas — é o
//    que impede um número restringido de seguir insistindo e ser banido;
//  - (task 6) números diferentes enviam ao mesmo tempo, no mesmo número o
//    disparo novo espera na fila, e o cancelar do cartão para só aquele grupo.
//
// Intervalos zerados por env; o teto diário, por teste.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { request, app, createTestUser, waCalls, resetWa, waConnect, waFailSend, waMock, auth as authMod } from "../helpers/app.js";
import { setGroupMembers } from "../helpers/wa-mock.js";

const require = createRequire(import.meta.url);
const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "backend");
const runner = require(path.join(backend, "dm-broadcast", "runner.js"));
const { prisma } = require(path.join(backend, "db"));

const ENV = ["DM_MIN_GAP_MS", "DM_MAX_GAP_MS", "DM_OFFLINE_RETRY_MS", "DM_DAILY_CAP"];
const envAntes = {};

beforeAll(() => {
  for (const k of ENV) envAntes[k] = process.env[k];
  process.env.DM_MIN_GAP_MS = "0";
  process.env.DM_MAX_GAP_MS = "0";
  process.env.DM_OFFLINE_RETRY_MS = "30";
});
afterAll(() => {
  for (const k of ENV) {
    if (envAntes[k] === undefined) delete process.env[k]; else process.env[k] = envAntes[k];
  }
});
beforeEach(() => {
  resetWa();
  delete process.env.DM_DAILY_CAP;
});

const CAMPANHA = 7700001;
const WGS = [
  { id: "a@g.us", jid: "a@g.us", numberId: "num-1", name: "Grupo A", members: 3 },
  { id: "b@g.us", jid: "b@g.us", numberId: "num-2", name: "Grupo B", members: 3 },
  { id: "c@g.us", jid: "c@g.us", numberId: "num-1", name: "Grupo C (fora da campanha)", members: 1 },
  { id: "d@g.us", jid: "d@g.us", numberId: "num-1", name: "Grupo D", members: 2 },
];

async function admin() {
  const u = await createTestUser();
  await authMod.setUserRole(u.user.id, "admin");
  return u;
}

// Estado com dois números, quatro grupos e uma campanha que usa A, B e D
// (A e D no num-1, B no num-2).
async function montar(u, campaignId = CAMPANHA) {
  const r = await u.auth("put", "/api/state").send({
    groups: [{ id: campaignId, name: "Ofertas", whatsappGroupIds: ["a@g.us", "b@g.us", "d@g.us"] }],
    numbers: [{ id: "num-1", phone: "5511000000001" }, { id: "num-2", phone: "5511000000002" }],
    whatsappGroups: WGS,
  });
  expect(r.status, "estado inicial").toBe(200);
  waConnect(u.user.id, "num-1");
  waConnect(u.user.id, "num-2");
}

const rota = (gid = CAMPANHA) => `/api/state/groups/${gid}/dm-broadcasts`;
const disparar = (u, body) => u.auth("post", rota()).send(body);
const cancelar = (u, id, body = {}) => u.auth("post", `${rota()}/${id}/cancel`).send(body);

async function lista(u, gid = CAMPANHA) {
  const r = await u.auth("get", rota(gid));
  expect(r.status).toBe(200);
  return r.body.broadcasts;
}

// Espera até `cond(disparo)` valer (o envio roda em segundo plano).
async function esperar(u, id, cond, { ms = 5000, oque = "" } = {}) {
  const fim = Date.now() + ms;
  for (;;) {
    const b = (await lista(u)).find(x => x.id === id);
    if (b && cond(b)) return b;
    if (Date.now() > fim) throw new Error(`não chegou em ${oque}: ${JSON.stringify(b)}`);
    await new Promise(r => setTimeout(r, 20));
  }
}
const esperarStatus = (u, id, quer) => esperar(u, id, b => quer.includes(b.status), { oque: quer.join("|") });
const parte = (b, wg) => b.grupos.find(p => p.whatsappGroupId === wg);
const esperarFase = async (u, id, wg, fase) => parte(await esperar(u, id, b => parte(b, wg)?.fase === fase, { oque: `${wg} ${fase}` }), wg);

describe("DM para membros — acesso", () => {
  it("sem token 401, usuário comum 403", async () => {
    expect((await request(app).get(rota())).status).toBe(401);
    const u = await createTestUser();
    expect((await u.auth("get", rota())).status).toBe(403);
    expect((await u.auth("post", rota()).send({ text: "oi" })).status).toBe(403);
  });

  it("campanha de outro usuário é 404", async () => {
    const dono = await admin();
    await montar(dono);
    const outro = await admin();
    expect((await outro.auth("post", rota()).send({ text: "oi" })).status).toBe(404);
    expect((await outro.auth("get", rota())).status).toBe(404);
  });

  it("grupo que não é destino da campanha é 400", async () => {
    const u = await admin();
    await montar(u);
    const r = await disparar(u, { text: "oi", whatsappGroupIds: ["c@g.us"] });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("not_linked");
  });

  it("texto vazio é 400", async () => {
    const u = await admin();
    await montar(u);
    expect((await disparar(u, { text: "   " })).status).toBe(400);
  });
});

describe("DM para membros — envio", () => {
  it("todos os grupos: cada pessoa uma vez, pelo número do primeiro grupo", async () => {
    const u = await admin();
    await montar(u);
    setGroupMembers("a@g.us", ["p1@s.whatsapp.net", "p2@s.whatsapp.net"]);
    setGroupMembers("b@g.us", ["p2@s.whatsapp.net", "p3@lid"]);

    const r = await disparar(u, { text: "Oi! Novidade no grupo." });
    expect(r.status).toBe(201);
    await runner._ocioso();

    const b = await esperarStatus(u, r.body.broadcast.id, ["done"]);
    expect(b).toMatchObject({ total: 3, sent: 3, failed: 0 });
    expect(parte(b, "a@g.us")).toMatchObject({ total: 2, sent: 2, fase: "finished" });
    expect(parte(b, "b@g.us")).toMatchObject({ total: 1, sent: 1, numberId: "num-2", fase: "finished" });
    const enviados = waCalls.sendText.map(c => `${c.numberId}>${c.jid}`).sort();
    expect(enviados).toEqual(["num-1>p1@s.whatsapp.net", "num-1>p2@s.whatsapp.net", "num-2>p3@lid"]);
    expect(waCalls.sendText.every(c => c.text === "Oi! Novidade no grupo.")).toBe(true);
  });

  it("um grupo só: manda só para os membros dele", async () => {
    const u = await admin();
    await montar(u);
    setGroupMembers("a@g.us", ["p1@s.whatsapp.net"]);
    setGroupMembers("b@g.us", ["p9@s.whatsapp.net"]);
    const r = await disparar(u, { text: "oi", whatsappGroupIds: ["a@g.us"] });
    expect(r.status).toBe(201);
    await runner._ocioso();
    expect(waCalls.sendText.map(c => c.jid)).toEqual(["p1@s.whatsapp.net"]);
  });

  it("grupos sem ninguém além de você: falha com o motivo", async () => {
    const u = await admin();
    await montar(u);
    const r = await disparar(u, { text: "oi" });
    await runner._ocioso();
    const b = await esperarStatus(u, r.body.broadcast.id, ["failed"]);
    expect(b.error).toMatch(/Nenhum membro/);
    expect(waCalls.sendText).toHaveLength(0);
  });

  it("5 falhas seguidas param o disparo", async () => {
    const u = await admin();
    await montar(u);
    setGroupMembers("a@g.us", Array.from({ length: 8 }, (_, i) => `p${i}@s.whatsapp.net`));
    waFailSend("not-acceptable");
    const r = await disparar(u, { text: "oi", whatsappGroupIds: ["a@g.us"] });
    await runner._ocioso();
    const b = await esperarStatus(u, r.body.broadcast.id, ["failed"]);
    expect(b).toMatchObject({ total: 8, sent: 0, failed: 5 });
    expect(b.error).toMatch(/5 falhas seguidas/);
  });
});

describe("DM para membros — esperas e cancelamento", () => {
  it("teto diário: o número para no teto e o grupo mostra a espera; o cancelar encerra", async () => {
    process.env.DM_DAILY_CAP = "2";
    const u = await admin();
    await montar(u);
    setGroupMembers("a@g.us", ["p1@s.whatsapp.net", "p2@s.whatsapp.net", "p3@s.whatsapp.net"]);
    const r = await disparar(u, { text: "oi", whatsappGroupIds: ["a@g.us"] });
    const id = r.body.broadcast.id;

    const p = await esperarFase(u, id, "a@g.us", "waiting");
    expect(p).toMatchObject({ sent: 2, pending: 1 });
    expect(p.motivo).toMatch(/teto de 2/);
    expect(new Date(p.nextAt).getTime() - Date.now()).toBeGreaterThan(23 * 3600e3);
    expect((await lista(u)).find(x => x.id === id).status).toBe("running");

    const c = await cancelar(u, id);
    expect(c.status).toBe(200);
    expect(c.body.broadcast.status).toBe("canceled");
    expect(parte(c.body.broadcast, "a@g.us")).toMatchObject({ canceled: 1, pending: 0, fase: "finished" });
    await runner._ocioso();
    expect(waCalls.sendText).toHaveLength(2);
  });

  it("número caído: espera sem gastar o destinatário; grupo ocupado recusa outro disparo, o \"todos\" pula ele", async () => {
    const u = await admin();
    await montar(u);
    setGroupMembers("a@g.us", ["p1@s.whatsapp.net"]);
    setGroupMembers("b@g.us", ["p2@s.whatsapp.net"]);
    waFailSend("Sessão não está conectada (status: disconnected).");
    const r = await disparar(u, { text: "oi", whatsappGroupIds: ["a@g.us"] });
    const id = r.body.broadcast.id;

    const p = await esperarFase(u, id, "a@g.us", "waiting");
    expect(p).toMatchObject({ sent: 0, failed: 0, pending: 1 });

    const dup = await disparar(u, { text: "outra", whatsappGroupIds: ["a@g.us"] });
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({ code: "dm_group_active", whatsappGroupId: "a@g.us" });

    const todos = await disparar(u, { text: "para todos" });
    expect(todos.status).toBe(201);
    expect(todos.body.broadcast.whatsappGroupIds).toEqual(["b@g.us", "d@g.us"]);

    // O número volta: os dois retomam sozinhos e mandam.
    waFailSend(null);
    expect(await esperarStatus(u, id, ["done"])).toMatchObject({ sent: 1, failed: 0 });
    expect(await esperarStatus(u, todos.body.broadcast.id, ["done"])).toMatchObject({ sent: 1, failed: 0 });
    await runner._ocioso();
    expect(waCalls.sendText.map(c => `${c.jid}:${c.text}`).sort()).toEqual(["p1@s.whatsapp.net:oi", "p2@s.whatsapp.net:para todos"]);
  });

  it("fila por número: o disparo novo no mesmo número espera; em outro número anda junto", async () => {
    process.env.DM_DAILY_CAP = "1";
    const u = await admin();
    await montar(u);
    setGroupMembers("a@g.us", ["p1@s.whatsapp.net", "p2@s.whatsapp.net"]);
    setGroupMembers("d@g.us", ["p3@s.whatsapp.net"]);
    setGroupMembers("b@g.us", ["p4@s.whatsapp.net"]);

    const um = (await disparar(u, { text: "um", whatsappGroupIds: ["a@g.us"] })).body.broadcast.id;
    await esperarFase(u, um, "a@g.us", "waiting");

    const dois = await disparar(u, { text: "dois", whatsappGroupIds: ["d@g.us"] });
    expect(dois.status).toBe(201);
    expect(await esperarFase(u, dois.body.broadcast.id, "d@g.us", "queued")).toMatchObject({ pending: 1, numberId: "num-1" });

    // O num-2 não tem nada na frente: termina enquanto o num-1 espera o teto.
    const tres = (await disparar(u, { text: "tres", whatsappGroupIds: ["b@g.us"] })).body.broadcast.id;
    await esperarStatus(u, tres, ["done"]);

    // Saiu o da frente: o da fila passa a esperar o teto do num-1 por conta própria.
    const c = await cancelar(u, um, { whatsappGroupId: "a@g.us" });
    expect(c.body.broadcast.status).toBe("canceled");
    const p = await esperarFase(u, dois.body.broadcast.id, "d@g.us", "waiting");
    expect(p.motivo).toMatch(/teto de 1/);

    await cancelar(u, dois.body.broadcast.id);
    await runner._ocioso();
    expect(waCalls.sendText.map(c => `${c.numberId}>${c.jid}`).sort()).toEqual(["num-1>p1@s.whatsapp.net", "num-2>p4@s.whatsapp.net"]);
  });

  it("cancelar no cartão para só aquele grupo; os outros do disparo continuam", async () => {
    process.env.DM_DAILY_CAP = "1";
    const u = await admin();
    await montar(u);
    setGroupMembers("a@g.us", ["p1@s.whatsapp.net", "p2@s.whatsapp.net"]);
    setGroupMembers("b@g.us", ["p3@s.whatsapp.net", "p4@s.whatsapp.net"]);
    const id = (await disparar(u, { text: "oi" })).body.broadcast.id;
    await esperarFase(u, id, "a@g.us", "waiting");
    await esperarFase(u, id, "b@g.us", "waiting");

    const c = await cancelar(u, id, { whatsappGroupId: "a@g.us" });
    expect(c.status).toBe(200);
    expect(c.body.broadcast.status).toBe("running");
    expect(parte(c.body.broadcast, "a@g.us")).toMatchObject({ sent: 1, canceled: 1, pending: 0, fase: "finished" });
    expect(parte(c.body.broadcast, "b@g.us")).toMatchObject({ sent: 1, pending: 1, fase: "waiting" });

    expect((await cancelar(u, id, { whatsappGroupId: "x@g.us" })).status).toBe(404);

    const fim = await cancelar(u, id, { whatsappGroupId: "b@g.us" });
    expect(fim.body.broadcast.status).toBe("canceled");
    await runner._ocioso();
    expect(waCalls.sendText).toHaveLength(2);
  });

  it("grupo cancelado enquanto a lista é montada sai do disparo; quem também está em outro grupo recebe por ele", async () => {
    const u = await admin();
    await montar(u);
    setGroupMembers("a@g.us", ["p1@s.whatsapp.net", "p2@s.whatsapp.net"]);
    setGroupMembers("b@g.us", ["p2@s.whatsapp.net", "p3@s.whatsapp.net"]);
    const b = await prisma().dmBroadcast.create({
      data: { userId: u.user.id, campaignId: BigInt(CAMPANHA), whatsappGroupIds: ["a@g.us", "b@g.us"], text: "oi" },
    });

    // A já entrou na lista quando o cartão dele é cancelado, no meio da busca de B.
    const original = waMock.groupMemberJids;
    waMock.groupMemberJids = async (userId, numberId, jid) => {
      if (jid === "b@g.us") {
        await runner.cancelar(await prisma().dmBroadcast.findUnique({ where: { id: b.id } }), { whatsappGroupId: "a@g.us", groupJid: "a@g.us" });
      }
      return original.call(waMock, userId, numberId, jid);
    };
    try {
      runner.kick(b.id);
      await runner._ocioso();
    } finally {
      waMock.groupMemberJids = original;
    }

    const fim = await esperarStatus(u, String(b.id), ["done"]);
    expect(fim.whatsappGroupIds).toEqual(["b@g.us"]);
    expect(fim).toMatchObject({ total: 2, sent: 2 });
    expect(waCalls.sendText.map(c => `${c.numberId}>${c.jid}`).sort()).toEqual(["num-2>p2@s.whatsapp.net", "num-2>p3@s.whatsapp.net"]);
  });
});
