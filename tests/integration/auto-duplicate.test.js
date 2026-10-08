// Duplicação automática de grupo destino cheio (task 25,
// backend/whatsapp/auto-duplicate.js). O WhatsApp é um dublê: o que se prova
// aqui é o que acontece no BANCO — o grupo novo, o vínculo nas campanhas, a marca
// no grupo cheio e o carimbo de versão que faz a aba aberta recarregar.
import { describe, it, expect, beforeEach } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { createTestUser, storage } from "../helpers/app.js";
import { makeGroup } from "../helpers/fixtures.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const backendDir = path.resolve(__dirname, "..", "..", "backend");
const autoDup = require(path.join(backendDir, "whatsapp", "auto-duplicate.js"));
const { prisma } = require(path.join(backendDir, "db"));

function fakeWa({ members = 1000, status = "connected", fail = null, desc = undefined, descFail = null } = {}) {
  const calls = [];
  const descCalls = [];
  return {
    calls,
    descCalls,
    getSession: async () => ({ status, info: { phone: "5511999990000" } }),
    getGroupMetadata: async () => ({ desc, participants: Array.from({ length: members }, (_, i) => ({ id: `${i}@s` })) }),
    setGroupDescription: async (userId, numberId, jid, description) => {
      descCalls.push({ numberId, jid, description });
      if (descFail) throw new Error(descFail);
    },
    // "cheio@g.us" → .../CHEIO; "novo@g.us" → .../NOVO.
    getInviteLink: async (userId, numberId, jid) => `https://chat.whatsapp.com/${jid.split("@")[0].toUpperCase()}`,
    createGroup: async (userId, numberId, name, parts) => {
      calls.push({ userId, numberId, name, parts });
      if (fail) throw new Error(fail);
      return { jid: "novo@g.us", name, inviteLink: "https://chat.whatsapp.com/NOVO", participants: ["5511999990000"] };
    },
  };
}

let user, auth;
const rowDe = async (id) => prisma().whatsappGroup.findUnique({ where: { id } });

beforeEach(async () => {
  ({ user, auth } = await createTestUser({ plan: "pro" }));
  const put = await auth("put", "/api/state").send({
    groups: [
      makeGroup({ id: 1, name: "Campanha A", whatsappGroupIds: ["cheio@g.us"] }),
      makeGroup({ id: 2, name: "Campanha B", whatsappGroupIds: ["cheio@g.us", "outro@g.us"] }),
      makeGroup({ id: 3, name: "Campanha C", whatsappGroupIds: ["outro@g.us"] }),
    ],
    numbers: [{ id: "num-1", phone: "5511999990000" }],
    whatsappGroups: [
      { id: "cheio@g.us", numberId: "num-1", name: "Ofertas", members: 990, autoDuplicate: true, description: "promo" },
      { id: "outro@g.us", numberId: "num-1", name: "Ofertas #2", members: 10 },
    ],
    settings: {},
  });
  expect(put.status).toBe(200);
});

describe("nextCloneName", () => {
  it("segue a série a partir do maior #N", () => {
    expect(autoDup.nextCloneName("Ofertas", ["Ofertas"])).toBe("Ofertas #2");
    expect(autoDup.nextCloneName("Ofertas", ["Ofertas", "Ofertas #2", "Ofertas #5"])).toBe("Ofertas #6");
    expect(autoDup.nextCloneName("Ofertas #2", ["Ofertas", "Ofertas #2"])).toBe("Ofertas #3");
    expect(autoDup.nextCloneName("Promo (BR)", ["Promo (BR)"])).toBe("Promo (BR) #2");
  });

  // Task 6: o grupo já nasce "#1" — a série não pode repetir o nome do cheio.
  it("série sem o nome puro soma 1 ao maior #N", () => {
    expect(autoDup.nextCloneName("Ofertas #1", ["Ofertas #1"])).toBe("Ofertas #2");
    expect(autoDup.nextCloneName("Ofertas #2", ["Ofertas #2"])).toBe("Ofertas #3");
    expect(autoDup.nextCloneName("Ofertas #1", [])).toBe("Ofertas #2");
  });
});

describe("checkGroup", () => {
  it("abaixo do limite só conta os membros", async () => {
    const wa = fakeWa({ members: 500 });
    const r = await autoDup.checkGroup(await rowDe("cheio@g.us"), { wa });
    expect(r).toEqual({ members: 500, full: false });
    expect(wa.calls).toEqual([]);
  });

  it("cheio: cria o próximo da série, vincula às campanhas e carimba a versão do estado", async () => {
    const antes = (await prisma().userState.findUnique({ where: { userId: user.id } })).updatedAt;
    const wa = fakeWa({ members: 1003 });
    const r = await autoDup.checkGroup(await rowDe("cheio@g.us"), { wa });
    expect(r).toMatchObject({ full: true, duplicated: "novo@g.us", campaigns: 2 });
    expect(wa.calls[0]).toMatchObject({ numberId: "num-1", name: "Ofertas #3", parts: ["5511999990000"] });

    const state = await storage.loadState(user.id);
    const novo = state.whatsappGroups.find(w => w.id === "novo@g.us");
    expect(novo).toMatchObject({ name: "Ofertas #3", numberId: "num-1", autoDuplicate: true, duplicatedFrom: "cheio@g.us", inviteLink: "https://chat.whatsapp.com/NOVO", description: "promo" });
    expect(state.whatsappGroups.find(w => w.id === "cheio@g.us")).toMatchObject({ duplicatedTo: "novo@g.us", members: 1003 });
    const ids = Object.fromEntries(state.groups.map(g => [g.name, g.whatsappGroupIds]));
    expect(ids["Campanha A"]).toEqual(["cheio@g.us", "novo@g.us"]);
    expect(ids["Campanha B"]).toEqual(["cheio@g.us", "outro@g.us", "novo@g.us"]);
    expect(ids["Campanha C"]).toEqual(["outro@g.us"]);

    const depois = (await prisma().userState.findUnique({ where: { userId: user.id } })).updatedAt;
    expect(depois.getTime()).toBeGreaterThan(antes.getTime());
    // A aba aberta com a versão antiga não consegue gravar por cima.
    const stale = await auth("put", "/api/state").send({ ...state, whatsappGroups: [], baseUpdatedAt: antes.toISOString() });
    expect(stale.status).toBe(409);

    // Uma vez só: com `duplicatedTo` marcado, o grupo cheio não duplica de novo.
    const again = await autoDup.checkGroup(await rowDe("cheio@g.us"), { wa });
    expect(again).toEqual({ skipped: "off" });
    expect(wa.calls.length).toBe(1);
  });

  // Task 3: a descrição é a do WhatsApp, e o grupo novo nasce com ela.
  it("o grupo novo herda a descrição do cheio no WhatsApp", async () => {
    const wa = fakeWa({ members: 1003, desc: "Regras do grupo" });
    const r = await autoDup.checkGroup(await rowDe("cheio@g.us"), { wa });
    expect(r).toMatchObject({ duplicated: "novo@g.us" });
    expect(wa.descCalls).toEqual([{ numberId: "num-1", jid: "novo@g.us", description: "Regras do grupo" }]);
    const novo = (await storage.loadState(user.id)).whatsappGroups.find(w => w.id === "novo@g.us");
    expect(novo.description).toBe("Regras do grupo");
  });

  // Task 11: o grupo novo não pode divulgar o link do grupo lotado.
  it("o link de convite do cheio na descrição vira o do grupo novo", async () => {
    const wa = fakeWa({ members: 1003, desc: "Entre: https://chat.whatsapp.com/CHEIO\nVizinho: https://chat.whatsapp.com/OUTRO" });
    await autoDup.checkGroup(await rowDe("cheio@g.us"), { wa });
    const esperado = "Entre: https://chat.whatsapp.com/NOVO\nVizinho: https://chat.whatsapp.com/OUTRO";
    expect(wa.descCalls).toEqual([{ numberId: "num-1", jid: "novo@g.us", description: esperado }]);
    const novo = (await storage.loadState(user.id)).whatsappGroups.find(w => w.id === "novo@g.us");
    expect(novo.description).toBe(esperado);
  });

  it("falhar ao copiar a descrição não desfaz a duplicação", async () => {
    const wa = fakeWa({ members: 1003, desc: "Regras do grupo", descFail: "not-authorized" });
    const r = await autoDup.checkGroup(await rowDe("cheio@g.us"), { wa });
    expect(r).toMatchObject({ full: true, duplicated: "novo@g.us", campaigns: 2 });
    expect(wa.descCalls).toHaveLength(1);
  });

  it("número desconectado não faz nada", async () => {
    const wa = fakeWa({ members: 1020, status: "disconnected" });
    expect(await autoDup.checkGroup(await rowDe("cheio@g.us"), { wa })).toEqual({ skipped: "offline" });
  });

  it("falha ao criar marca a tentativa e espera antes de tentar de novo", async () => {
    const wa = fakeWa({ members: 1020, fail: "rate-overlimit" });
    const r = await autoDup.checkGroup(await rowDe("cheio@g.us"), { wa });
    expect(r).toMatchObject({ full: true, error: "rate-overlimit" });
    const row = await rowDe("cheio@g.us");
    expect(row.metadata).toMatchObject({ autoDuplicateError: "rate-overlimit" });
    expect(await autoDup.checkGroup(row, { wa })).toEqual({ skipped: "retry-later" });
    expect(wa.calls.length).toBe(1);
  });

  it("grupo sem a opção ligada é ignorado", async () => {
    const wa = fakeWa({ members: 1020 });
    expect(await autoDup.checkGroup(await rowDe("outro@g.us"), { wa })).toEqual({ skipped: "off" });
  });
});
