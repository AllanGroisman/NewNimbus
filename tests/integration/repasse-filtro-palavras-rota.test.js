// Rota da aba Histórico → Filtro de palavras da campanha de repasse.
import { describe, it, expect, beforeEach } from "vitest";
import path from "path";
import { createTestUser, storage, prisma } from "../helpers/app.js";

const backendDir = path.resolve(__dirname, "..", "..", "backend");
const appConfig = require(path.join(backendDir, "config"));
const featureFlags = require(path.join(backendDir, "feature-flags.js"));

function repasseGroup(id) {
  return {
    id, name: "Repasse", paused: false, categories: [], whatsappGroupIds: [],
    messageTemplate: "{produto}",
    scraping: { kind: "repasse", auto: true, sources: ["Mercado Livre"], filters: {}, repasse: { leaders: [], blockWords: ["infantil"] } },
    schedule: { windows: [], cooldownValue: 24, cooldownUnit: "horas" },
    queue: [], pending: [], history: [],
    sentToday: 0, sentWeek: 0, weekData: [0, 0, 0, 0, 0, 0, 0], lastSend: "—", avgDiscount: 0,
  };
}

async function linha(userId, groupId, fields) {
  await prisma().repasseCaptureLog.create({
    data: { groupId: BigInt(groupId), userId, waJid: "x@g.us", rawUrl: "https://ml/p/1", outcome: "queued", ...fields },
  });
}

describe("GET /api/state/groups/:gid/repasse/filtro-palavras", () => {
  beforeEach(() => { appConfig.set(featureFlags.FEATURE_FLAGS_KEY, {}); });

  it("lista só as linhas em que o filtro rodou, mais nova primeiro, e filtra por veredito", async () => {
    const { user, auth } = await createTestUser({ plan: "pro" });
    await storage.saveState(user.id, { groups: [repasseGroup(6001)] });
    await linha(user.id, 6001, { productName: "Fone", wordFilter: "approved", wordFilterReason: "nenhuma palavra da lista negra" });
    await linha(user.id, 6001, { productName: "Boneca", outcome: "discarded", wordFilter: "rejected", wordFilterReason: 'palavra da lista negra: "infantil"' });
    await linha(user.id, 6001, { productName: "Sem filtro" });

    const r = await auth("get", "/api/state/groups/6001/repasse/filtro-palavras");
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(2);
    expect(r.body.rows.map(x => x.productName)).toEqual(["Boneca", "Fone"]);
    expect(r.body.rows[0].wordFilterReason).toBe('palavra da lista negra: "infantil"');

    const rej = await auth("get", "/api/state/groups/6001/repasse/filtro-palavras?filtro=rejected");
    expect(rej.body.rows.map(x => x.productName)).toEqual(["Boneca"]);
  });

  it("campanha de outro usuário → 404", async () => {
    const dono = await createTestUser({ plan: "pro" });
    await storage.saveState(dono.user.id, { groups: [repasseGroup(6002)] });
    const outro = await createTestUser({ plan: "pro" });
    const r = await outro.auth("get", "/api/state/groups/6002/repasse/filtro-palavras");
    expect(r.status).toBe(404);
  });

  it("função desligada no admin → vazio", async () => {
    const { user, auth } = await createTestUser({ plan: "pro" });
    await storage.saveState(user.id, { groups: [repasseGroup(6003)] });
    await linha(user.id, 6003, { wordFilter: "approved", wordFilterReason: "x" });
    featureFlags.writeFlags({ repasseWordFilter: false });
    const r = await auth("get", "/api/state/groups/6003/repasse/filtro-palavras");
    expect(r.body).toMatchObject({ desligado: true, rows: [] });
  });
});
