// Estatísticas da aba Grupos (backend/group-stats/): a captura de entrada/saída
// vinda do worker, o registro dos envios, o registro diário do tamanho e as duas
// respostas da API. O WhatsApp é dublê; o que se prova é o que fica no banco e
// o que a tela recebe.
import { describe, it, expect, beforeEach, vi } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { createTestUser, scheduler, storage, affiliate, waConnect, prisma } from "../helpers/app.js";
import { makeGroup } from "../helpers/fixtures.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const backendDir = path.resolve(__dirname, "..", "..", "backend");
const capture = require(path.join(backendDir, "group-stats", "capture.js"));
const envios = require(path.join(backendDir, "group-stats", "envios.js"));
const snapshot = require(path.join(backendDir, "group-stats", "snapshot.js"));
const stats = require(path.join(backendDir, "group-stats", "stats.js"));

const G1 = "111@g.us";
const G2 = "222@g.us";
const SOLTO = "333@g.us"; // cadastrado, mas sem campanha
const NOW = new Date("2026-10-06T15:00:00Z"); // 12:00 em Brasília

// Mensagem-stub como o Baileys entrega (ver unit/group-stats-stubs.test.js).
function stub(jid, type, participante, { actor, at }) {
  return {
    key: { remoteJid: jid, fromMe: false, participant: actor, id: `S${Math.random()}` },
    messageTimestamp: Math.floor(new Date(at).getTime() / 1000),
    messageStubType: type,
    messageStubParameters: [JSON.stringify(participante)],
  };
}
const entrouPeloLink = (jid, pn, at) => stub(jid, 27, { id: pn }, { actor: pn, at });
const adicionado = (jid, pn, at) => stub(jid, 27, { id: pn }, { actor: "5599999999999@s.whatsapp.net", at });
const saiu = (jid, pn, at) => stub(jid, 32, { id: pn }, { actor: pn, at });
const removido = (jid, pn, at) => stub(jid, 28, { id: pn }, { actor: "5599999999999@s.whatsapp.net", at });
const pn = (n) => `55110000000${String(n).padStart(2, "0")}@s.whatsapp.net`;

let user, auth;

beforeEach(async () => {
  ({ user, auth } = await createTestUser({ plan: "pro" }));
  const put = await auth("put", "/api/state").send({
    groups: [
      makeGroup({ id: 1, name: "Campanha A", whatsappGroupIds: ["wa-1"] }),
      makeGroup({ id: 2, name: "Campanha B", whatsappGroupIds: ["wa-1", G2], sources: ["amazon"] }),
    ],
    numbers: [{ id: "num-1", phone: "5511999990000" }],
    whatsappGroups: [
      // id ≠ jid (o formato antigo) e id = jid (o comum hoje)
      { id: "wa-1", jid: G1, numberId: "num-1", name: "Ofertas 1", members: 500 },
      { id: G2, numberId: "num-1", name: "Ofertas 2", members: 40, autoDuplicate: true },
      { id: SOLTO, numberId: "num-1", name: "Sem campanha", members: 7 },
    ],
    settings: {},
  });
  expect(put.status).toBe(200);
});

const eventosDo = (jid) => prisma().groupMemberEvent.findMany({ where: { userId: user.id, groupJid: jid }, orderBy: { at: "asc" } });

describe("captura (worker)", () => {
  it("grava entrada e saída do grupo cadastrado, com a hora do servidor", async () => {
    const n = await capture.onUpsert(user.id, "num-1", [
      entrouPeloLink(G1, pn(1), "2026-10-05T13:00:00Z"),
      adicionado(G1, pn(2), "2026-10-05T13:05:00Z"),
      saiu(G1, pn(1), "2026-10-05T14:00:00Z"),
      removido(G1, pn(2), "2026-10-05T14:30:00Z"),
    ], { selfIds: ["5511999990000@s.whatsapp.net"] });
    expect(n).toBe(4);
    const rows = await eventosDo(G1);
    expect(rows.map(r => [r.participant, r.kind])).toEqual([
      [pn(1), "join_link"], [pn(2), "join_added"], [pn(1), "left"], [pn(2), "removed"],
    ]);
    expect(rows[0].at.toISOString()).toBe("2026-10-05T13:00:00.000Z");
    expect(rows[0].numberId).toBe("num-1");
  });

  it("o mesmo aviso visto por duas sessões do mesmo telefone vira uma linha só", async () => {
    const msg = [saiu(G1, pn(3), "2026-10-05T10:00:00Z")];
    expect(await capture.onUpsert(user.id, "num-1", msg)).toBe(1);
    // A sessão do WhatsNimbus no mesmo telefone: o dono vem do índice, não da sessão.
    expect(await capture.onUpsert("__whatsnimbus__", "num-1", msg)).toBe(0);
    expect(await eventosDo(G1)).toHaveLength(1);
  });

  it("grupo não cadastrado, ou de outro número, não grava", async () => {
    await capture.onUpsert(user.id, "num-1", [saiu("999@g.us", pn(4), "2026-10-05T10:00:00Z")]);
    await capture.onUpsert(user.id, "outro-numero", [saiu(G1, pn(4), "2026-10-05T10:00:00Z")]);
    expect(await prisma().groupMemberEvent.count()).toBe(0);
  });

  it("LID sem número usa o mapeamento LID→PN, pra entrada e saída caírem na mesma pessoa", async () => {
    const pnForLid = async (lid) => (lid === "777@lid" ? pn(7) : null);
    await capture.onUpsert(user.id, "num-1", [
      stub(G1, 27, { id: pn(7), lid: "777@lid" }, { actor: pn(7), at: "2026-10-05T10:00:00Z" }),
      stub(G1, 32, { id: "777@lid" }, { actor: "777@lid", at: "2026-10-05T11:00:00Z" }),
    ], { pnForLid });
    expect((await eventosDo(G1)).map(r => r.participant)).toEqual([pn(7), pn(7)]);
  });
});

describe("envios", () => {
  it("o envio de campanha grava uma linha por grupo que recebeu", async () => {
    const spy = vi.spyOn(affiliate, "gerarLinkAfiliadoML").mockImplementation(async (_u, url) => url);
    affiliate.writeConfig(user.id, { tag: "test-tag", cookie: "test-cookie-sessid" });
    waConnect(user.id, "num-1");
    await storage.updateGroupOps(user.id, 2, {
      queue: [{
        id: "i1", key: "i1", name: "Fone Bluetooth", link: "https://www.amazon.com.br/dp/B0CSEND1234",
        img: "https://example.com/img.jpg", price: 100, originalPrice: 200, discount: 50, store: "Amazon", category: "gamer",
      }],
    });
    await scheduler.sendNextNow(user.id, 2);
    await vi.waitFor(async () => {
      const rows = await prisma().groupSendEvent.findMany({ where: { userId: user.id }, orderBy: { groupJid: "asc" } });
      expect(rows.map(r => [r.groupJid, Number(r.campaignId), r.productName])).toEqual([
        [G1, 2, "Fone Bluetooth"], [G2, 2, "Fone Bluetooth"],
      ]);
    });
    spy.mockRestore();
  });

  it("nome do produto é cortado e nada é gravado sem grupo", async () => {
    expect(await envios.registrar(user.id, 1, [], "x")).toBe(0);
    await envios.registrar(user.id, 1, [{ jid: G1, numberId: "num-1" }], "a".repeat(300));
    const [row] = await prisma().groupSendEvent.findMany({ where: { userId: user.id } });
    expect(row.productName).toHaveLength(120);
  });
});

describe("registro diário (snapshot)", () => {
  function fakeWa({ status = "connected" } = {}) {
    const calls = [];
    return {
      calls,
      getSession: async () => ({ status }),
      groupSizes: async (userId, numberId, jids) => {
        calls.push({ userId, numberId, jids: [...jids].sort() });
        return jids.map(jid => ({ jid, members: jid === G1 ? 510 : 41 }));
      },
    };
  }

  it("grava o tamanho de cada grupo de destino no dia de Brasília", async () => {
    const wa = fakeWa();
    expect(await snapshot.tick({ wa, ativa: async () => true, now: NOW })).toBe(2);
    // Só os destinos: o grupo sem campanha não é consultado.
    expect(wa.calls).toEqual([{ userId: user.id, numberId: "num-1", jids: [G1, G2].sort() }]);
    const rows = await prisma().groupMemberSnapshot.findMany({ where: { userId: user.id }, orderBy: { groupJid: "asc" } });
    expect(rows.map(r => [r.groupJid, r.day.toISOString().slice(0, 10), r.members])).toEqual([
      [G1, "2026-10-06", 510], [G2, "2026-10-06", 41],
    ]);
    // A segunda passada do dia sobrescreve, não duplica.
    await snapshot.tick({ wa, ativa: async () => true, now: NOW });
    expect(await prisma().groupMemberSnapshot.count({ where: { userId: user.id } })).toBe(2);
  });

  it("pula número desconectado e conta sem assinatura ativa", async () => {
    const offline = fakeWa({ status: "connecting" });
    await snapshot.tick({ wa: offline, ativa: async () => true, now: NOW });
    const inativa = fakeWa();
    await snapshot.tick({ wa: inativa, ativa: async () => false, now: NOW });
    expect(offline.calls).toEqual([]);
    expect(inativa.calls).toEqual([]);
    expect(await prisma().groupMemberSnapshot.count()).toBe(0);
  });

  it("a limpeza apaga só o que passou da retenção", async () => {
    await prisma().groupMemberEvent.createMany({ data: [
      { userId: user.id, groupJid: G1, participant: pn(1), kind: "left", at: new Date(NOW.getTime() - 400 * 864e5) },
      { userId: user.id, groupJid: G1, participant: pn(2), kind: "left", at: new Date(NOW.getTime() - 10 * 864e5) },
    ] });
    const r = await snapshot.purgarAntigos(NOW);
    expect(r.eventos).toBe(1);
    expect(await prisma().groupMemberEvent.count()).toBe(1);
  });
});

describe("API", () => {
  async function semear() {
    await prisma().groupMemberSnapshot.createMany({ data: [
      { userId: user.id, groupJid: G1, day: new Date("2026-10-04T00:00:00Z"), members: 498 },
      { userId: user.id, groupJid: G1, day: new Date("2026-10-06T00:00:00Z"), members: 503 },
    ] });
    await capture.onUpsert(user.id, "num-1", [
      entrouPeloLink(G1, pn(1), "2026-10-05T12:00:00Z"),
      entrouPeloLink(G1, pn(2), "2026-10-05T12:10:00Z"),
      adicionado(G1, pn(3), "2026-10-05T12:20:00Z"),
      saiu(G1, pn(1), "2026-10-05T13:20:00Z"),          // ficou 1h20; 20 min após o envio das 13:00
      // 02:30 UTC de 06/10 ainda é 05/10 em Brasília (23:30)
      saiu(G1, pn(2), "2026-10-06T02:30:00Z"),
      removido(G1, pn(3), "2026-10-06T13:00:00Z"),
      entrouPeloLink(G2, pn(9), "2026-10-06T13:00:00Z"),
    ]);
    await envios.registrar(user.id, 1, [{ jid: G1, numberId: "num-1", at: new Date("2026-10-05T13:00:00Z") }], "Air fryer");
  }

  it("visão geral: só os destinos, totais por grupo e por dia, filtro de campanha", async () => {
    await semear();
    const r = await stats.overview(user.id, { from: "2026-10-03", to: "2026-10-06" }, { now: NOW });
    expect(r.campanhas).toEqual([{ id: "1", name: "Campanha A" }, { id: "2", name: "Campanha B" }]);
    expect(r.coletandoDesde).toBe("2026-10-04");
    expect(r.grupos.map(g => g.jid).sort()).toEqual([G1, G2]);
    const g1 = r.grupos.find(g => g.jid === G1);
    expect(g1).toMatchObject({
      nome: "Ofertas 1", membros: 503, membrosEm: "2026-10-06", entradas: 3, saidas: 3, saldo: 0, envios: 1,
      campanhas: [{ id: "1", name: "Campanha A" }, { id: "2", name: "Campanha B" }],
    });
    // Sem registro diário, cai no número salvo no cadastro do grupo.
    expect(r.grupos.find(g => g.jid === G2)).toMatchObject({ membros: 40, membrosEm: null, entradas: 1, cap: 1000 });
    expect(r.porDia).toEqual([
      { date: "2026-10-03", semDados: true },
      { date: "2026-10-04", entradas: 0, saidas: 0, saldo: 0, envios: 0 },
      { date: "2026-10-05", entradas: 3, saidas: 2, saldo: 1, envios: 1 },
      { date: "2026-10-06", entradas: 1, saidas: 1, saldo: 0, envios: 0 },
    ]);
    expect(r.totais).toEqual({ grupos: 2, membros: 543, entradas: 4, saidas: 3, saldo: 1, envios: 1 });

    const soA = await stats.overview(user.id, { from: "2026-10-03", to: "2026-10-06", campanha: "1" }, { now: NOW });
    expect(soA.grupos.map(g => g.jid)).toEqual([G1]);
    expect(soA.campanhas).toHaveLength(2); // o select continua com todas
  });

  it("detalhe: origem, permanência, saídas após envio e horários", async () => {
    await semear();
    const r = await stats.detalhe(user.id, G1, { from: "2026-10-05", to: "2026-10-06" }, { now: NOW });
    expect(r.grupo).toMatchObject({ jid: G1, membros: 503 });
    expect(r.origem).toEqual({ entradas: { link: 2, adicionado: 1, outro: 0 }, saidas: { saiu: 2, removido: 1 } });
    expect(r.porDia.map(d => [d.date, d.entradasLink, d.saiu, d.removidos, d.envios, d.membros])).toEqual([
      ["2026-10-05", 2, 2, 0, 1, null],
      ["2026-10-06", 0, 0, 1, 0, 503],
    ]);
    expect(r.permanencia).toMatchObject({ saidas: 2, comEntrada: 2, semEntrada: 0, entraram: 3, aindaNoGrupo: 0, ate24h: 2 });
    expect(r.aposEnvio).toMatchObject({ envios: 1, saidas: 2, saidasAposEnvio: 1, pct: 50 });
    expect(r.aposEnvio.piores).toEqual([{ at: "2026-10-05T13:00:00.000Z", produto: "Air fryer", saidas: 1 }]);
    // 13:20 UTC = 10h de segunda-feira (05/10/2026) em Brasília.
    expect(r.horarios.saidas[0][10]).toBe(1);
    expect(r.horarios.entradas[0][9]).toBe(3);
  });

  it("rotas: período validado, 404 pra grupo que não é destino", async () => {
    const ok = await auth("get", "/api/grupos/estatisticas?from=2026-10-01&to=2026-10-02");
    expect(ok.status).toBe(200);
    expect(ok.body.grupos).toHaveLength(2);

    expect((await auth("get", "/api/grupos/estatisticas?from=ontem&to=hoje")).status).toBe(400);
    expect((await auth("get", "/api/grupos/estatisticas?from=2025-01-01&to=2026-10-01")).status).toBe(400);

    const det = await auth("get", `/api/grupos/estatisticas/${encodeURIComponent(G1)}?from=2026-10-01&to=2026-10-02`);
    expect(det.status).toBe(200);
    expect(det.body.grupo.jid).toBe(G1);
    expect((await auth("get", `/api/grupos/estatisticas/${encodeURIComponent(SOLTO)}?from=2026-10-01&to=2026-10-02`)).status).toBe(404);

    // Grupo de outro usuário também é 404.
    const outro = await createTestUser({ plan: "pro" });
    expect((await outro.auth("get", `/api/grupos/estatisticas/${encodeURIComponent(G1)}?from=2026-10-01&to=2026-10-02`)).status).toBe(404);
  });
});
