// Entrada e saída de participante lidas da mensagem-stub do grupo (aba Grupos).
// Errar aqui é contar quem entrou pelo link como "adicionado", perder a hora do
// aviso entregue na reconexão ou contar a entrada do próprio número.
import { describe, it, expect } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "backend");
const { extrairEventos, temStubDeParticipante, normJid, STUB } = require(path.join(backend, "group-stats", "stubs.js"));

const GRUPO = "120363000000000001@g.us";
const SELF = ["5511000000000:7@s.whatsapp.net", "999000:7@lid"];
const T = 1_790_000_000; // segundos

// O formato que o Baileys 7 monta no handleNotification (messages-recv.js).
function stub(type, participantes, { actor, actorPn, t = T, remoteJid = GRUPO, fromMe = false } = {}) {
  return {
    key: { remoteJid, fromMe, participant: actor, participantAlt: actorPn, id: "ABC" },
    messageTimestamp: t,
    messageStubType: type,
    messageStubParameters: participantes.map(p => JSON.stringify(p)),
  };
}

describe("extrairEventos", () => {
  it("entrada pelo link: quem fez a ação é o próprio participante", () => {
    const m = stub(STUB.ADD, [{ id: "111@lid", phoneNumber: "5511111111111@s.whatsapp.net" }], { actor: "111@lid", actorPn: "5511111111111@s.whatsapp.net" });
    const [ev] = extrairEventos([m], { selfIds: SELF });
    expect(ev).toMatchObject({ groupJid: GRUPO, kind: "join_link" });
    expect(ev.at.toISOString()).toBe(new Date(T * 1000).toISOString());
    expect(ev.participante).toEqual({ id: "111@lid", phoneNumber: "5511111111111@s.whatsapp.net", lid: null });
  });

  it("autor por LID e participante por PN ainda casam pelo outro lado", () => {
    const m = stub(STUB.ADD, [{ id: "5511111111111@s.whatsapp.net", lid: "111@lid" }], { actor: "111:4@lid" });
    expect(extrairEventos([m])[0].kind).toBe("join_link");
  });

  it("admin adicionou: o autor é outra pessoa (fromMe incluso — é o dono adicionando)", () => {
    const m = stub(STUB.ADD, [{ id: "222@lid" }], { actor: "999000@lid", fromMe: true });
    const evs = extrairEventos([m]);
    expect(evs).toHaveLength(1);
    expect(evs[0].kind).toBe("join_added");
  });

  it("sem autor conhecido a origem fica em aberto", () => {
    expect(extrairEventos([stub(STUB.ADD, [{ id: "222@lid" }])])[0].kind).toBe("join_other");
  });

  it("saiu × removido", () => {
    const saiu = stub(STUB.LEAVE, [{ id: "333@lid" }], { actor: "333@lid" });
    const removido = stub(STUB.REMOVE, [{ id: "444@lid" }], { actor: "888@lid" });
    expect(extrairEventos([saiu, removido]).map(e => e.kind)).toEqual(["left", "removed"]);
  });

  it("stubs de entrada que o Baileys ainda não produz viram join_other", () => {
    for (const t of [STUB.INVITE, STUB.ADD_REQUEST_JOIN, STUB.ACCEPT, STUB.LINKED_GROUP_JOIN]) {
      expect(extrairEventos([stub(t, [{ id: "555@lid" }], { actor: "555@lid" })])[0].kind).toBe("join_other");
    }
  });

  it("promoção, rebaixamento e troca de número não são movimento de membro", () => {
    const outros = [29, 30, 33].map(t => stub(t, [{ id: "666@lid" }], { actor: "777@lid" }));
    expect(extrairEventos(outros)).toEqual([]);
    expect(temStubDeParticipante(outros)).toBe(false);
  });

  it("uma notificação com vários participantes vira um evento por pessoa", () => {
    const m = stub(STUB.ADD, [{ id: "1@lid" }, { id: "2@lid" }, { id: "3@lid" }], { actor: "9@lid" });
    expect(extrairEventos([m]).map(e => e.participante.id)).toEqual(["1@lid", "2@lid", "3@lid"]);
  });

  it("a entrada e a saída do próprio número ficam de fora", () => {
    const m = stub(STUB.ADD, [{ id: "999000@lid", phoneNumber: "5511000000000@s.whatsapp.net" }, { id: "1@lid" }], { actor: "8@lid" });
    expect(extrairEventos([m], { selfIds: SELF }).map(e => e.participante.id)).toEqual(["1@lid"]);
  });

  it("timestamp Long do protobuf (o que sai do fromObject)", () => {
    const m = stub(STUB.LEAVE, [{ id: "1@lid" }], { actor: "1@lid", t: { low: T, high: 0, unsigned: true, toNumber: () => T } });
    expect(extrairEventos([m])[0].at.getTime()).toBe(T * 1000);
    const semToNumber = stub(STUB.LEAVE, [{ id: "1@lid" }], { actor: "1@lid", t: { low: T, high: 0 } });
    expect(extrairEventos([semToNumber])[0].at.getTime()).toBe(T * 1000);
  });

  it("sem hora o evento é descartado (não dá pra pôr no dia certo)", () => {
    expect(extrairEventos([stub(STUB.LEAVE, [{ id: "1@lid" }], { t: 0 })])).toEqual([]);
  });

  it("parâmetro no formato antigo (só o jid) e JSON quebrado", () => {
    const m = stub(STUB.LEAVE, [], { actor: "x@lid" });
    m.messageStubParameters = ["5512222222222@s.whatsapp.net", "{quebrado", ""];
    const evs = extrairEventos([m]);
    expect(evs).toHaveLength(1);
    expect(evs[0].participante.id).toBe("5512222222222@s.whatsapp.net");
  });

  it("fora de grupo não conta", () => {
    expect(extrairEventos([stub(STUB.ADD, [{ id: "1@lid" }], { remoteJid: "5511@s.whatsapp.net" })])).toEqual([]);
  });
});

describe("temStubDeParticipante", () => {
  it("mensagem comum de grupo passa reto", () => {
    expect(temStubDeParticipante([{ key: { remoteJid: GRUPO }, message: { conversation: "oi" } }])).toBe(false);
    expect(temStubDeParticipante(undefined)).toBe(false);
  });
  it("acha a stub no meio do lote", () => {
    expect(temStubDeParticipante([{ message: {} }, { messageStubType: STUB.LEAVE }])).toBe(true);
  });
});

describe("normJid", () => {
  it("tira o aparelho e troca o c.us antigo", () => {
    expect(normJid("5511:12@s.whatsapp.net")).toBe("5511@s.whatsapp.net");
    expect(normJid("5511@c.us")).toBe("5511@s.whatsapp.net");
    expect(normJid("abc")).toBe(null);
    expect(normJid(null)).toBe(null);
  });
});
