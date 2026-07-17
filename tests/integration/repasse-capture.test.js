// Captura de links do grupo líder (campanhas de repasse).
// Cobre: índice de líderes (query jsonb), extração de URL, filtro por loja/afiliado,
// enriquecimento (scrapeSingleProduct mockado), inserção em pending/queue, dedup.

import { describe, it, expect, beforeEach, vi } from "vitest";
import path from "path";
import { createTestUser, storage, affiliate } from "../helpers/app.js";

const backendDir = path.resolve(__dirname, "..", "..", "backend");
const scraper = require(path.join(backendDir, "scraping", "scraper.js"));
const capture = require(path.join(backendDir, "repasse", "capture.js"));

const LEADER_JID = "120363999999@g.us";
const NUMBER_ID = "num-1";

function msgWithText(text, { jid = LEADER_JID, fromMe = false } = {}) {
  return { key: { remoteJid: jid, fromMe }, message: { conversation: text } };
}

function repasseGroup(id, { auto = false } = {}) {
  return {
    id,
    name: "Repasse Teste",
    paused: false,
    categories: [],
    whatsappGroupIds: [],
    messageTemplate: "{produto} {preco} {link}",
    scraping: {
      kind: "repasse",
      auto,
      sources: ["Mercado Livre", "Amazon", "Shopee"],
      filters: {},
      repasse: { leaderNumberId: NUMBER_ID, leaderJid: LEADER_JID, leaderName: "Grupo Líder" },
    },
    schedule: { windows: [{ from: "00:00", to: "23:59", interval: 0 }], cooldownValue: 24, cooldownUnit: "horas" },
    queue: [], pending: [], history: [],
    sentToday: 0, sentWeek: 0, weekData: [0, 0, 0, 0, 0, 0, 0], lastSend: "—", avgDiscount: 0,
  };
}

describe("repasse capture — grupo líder", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Resolve de shortlink: devolve a própria URL (sem rede).
    global.fetch = vi.fn(async (url) => ({ url, body: { cancel: async () => {} } }));
    // Enriquecimento: produto fake determinístico.
    vi.spyOn(scraper, "scrapeSingleProduct").mockImplementation(async (url) => ({
      name: "Produto Capturado", link: url, price: 99.9, originalPrice: 149.9,
      discount: 33, img: "https://img/x.jpg", store: scraper.detectStore(url),
    }));
  });

  it("captura link de ML do líder e envia pra pending (auto=false)", async () => {
    const { user } = await createTestUser();
    affiliate.writeConfig(user.id, { tag: "t", cookie: "c-sessid" }); // ML afiliado ok
    await storage.saveState(user.id, { groups: [repasseGroup(5001, { auto: false })] });
    await capture.rebuildLeaderIndex();

    await capture.onUpsert(user.id, NUMBER_ID, [
      msgWithText("Olha essa oferta https://www.mercadolivre.com.br/p/MLB123 imperdível!"),
    ]);

    const state = await storage.loadState(user.id);
    const g = state.groups.find(x => x.id === 5001);
    expect(g.pending.length).toBe(1);
    expect(g.queue.length).toBe(0);
    expect(g.pending[0].store).toBe("Mercado Livre");
    expect(g.pending[0].source).toBe("repasse");
    expect(g.pending[0].name).toBe("Produto Capturado");
  });

  it("auto=true → link vai direto pra fila", async () => {
    const { user } = await createTestUser();
    affiliate.writeConfig(user.id, { tag: "t", cookie: "c-sessid" });
    await storage.saveState(user.id, { groups: [repasseGroup(5002, { auto: true })] });
    await capture.rebuildLeaderIndex();

    await capture.onUpsert(user.id, NUMBER_ID, [
      msgWithText("https://www.mercadolivre.com.br/p/MLB999"),
    ]);

    const g = (await storage.loadState(user.id)).groups.find(x => x.id === 5002);
    expect(g.queue.length).toBe(1);
    expect(g.pending.length).toBe(0);
  });

  it("ignora link de loja sem afiliado configurado", async () => {
    const { user } = await createTestUser();
    // NÃO configura afiliado ML.
    await storage.saveState(user.id, { groups: [repasseGroup(5003, { auto: true })] });
    await capture.rebuildLeaderIndex();

    await capture.onUpsert(user.id, NUMBER_ID, [
      msgWithText("https://www.mercadolivre.com.br/p/MLB123"),
    ]);

    const g = (await storage.loadState(user.id)).groups.find(x => x.id === 5003);
    expect(g.queue.length).toBe(0);
    expect(g.pending.length).toBe(0);
  });

  it("ignora link de loja não suportada (Magalu)", async () => {
    const { user } = await createTestUser();
    affiliate.writeConfig(user.id, { tag: "t", cookie: "c-sessid" });
    await storage.saveState(user.id, { groups: [repasseGroup(5004, { auto: true })] });
    await capture.rebuildLeaderIndex();

    await capture.onUpsert(user.id, NUMBER_ID, [
      msgWithText("https://www.magazineluiza.com.br/produto/123"),
    ]);

    const g = (await storage.loadState(user.id)).groups.find(x => x.id === 5004);
    expect(g.queue.length + g.pending.length).toBe(0);
  });

  it("dedup — mesmo produto postado 2x gera 1 item", async () => {
    const { user } = await createTestUser();
    affiliate.writeConfig(user.id, { tag: "t", cookie: "c-sessid" });
    await storage.saveState(user.id, { groups: [repasseGroup(5005, { auto: true })] });
    await capture.rebuildLeaderIndex();

    await capture.onUpsert(user.id, NUMBER_ID, [msgWithText("https://www.mercadolivre.com.br/p/MLB777")]);
    await capture.onUpsert(user.id, NUMBER_ID, [msgWithText("https://www.mercadolivre.com.br/p/MLB777")]);

    const g = (await storage.loadState(user.id)).groups.find(x => x.id === 5005);
    expect(g.queue.length).toBe(1);
  });

  it("ignora mensagem de grupo que não é líder", async () => {
    const { user } = await createTestUser();
    affiliate.writeConfig(user.id, { tag: "t", cookie: "c-sessid" });
    await storage.saveState(user.id, { groups: [repasseGroup(5006, { auto: true })] });
    await capture.rebuildLeaderIndex();

    await capture.onUpsert(user.id, NUMBER_ID, [
      msgWithText("https://www.mercadolivre.com.br/p/MLB123", { jid: "000000@g.us" }),
    ]);

    const g = (await storage.loadState(user.id)).groups.find(x => x.id === 5006);
    expect(g.queue.length + g.pending.length).toBe(0);
  });
});
