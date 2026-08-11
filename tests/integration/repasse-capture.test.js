// Captura de links dos grupos líderes (campanhas de repasse).
// Cobre: índice de líderes (query jsonb), extração de URL, filtro por loja/afiliado,
// enriquecimento (scrapeSingleProduct mockado), inserção em pending/queue, dedup.

import { describe, it, expect, beforeEach, vi } from "vitest";
import path from "path";
import { createTestUser, storage, affiliate, billing } from "../helpers/app.js";

const backendDir = path.resolve(__dirname, "..", "..", "backend");
const scraper = require(path.join(backendDir, "scraping", "scraper.js"));
const capture = require(path.join(backendDir, "repasse", "capture.js"));

const LEADER_JID = "120363999999@g.us";
const LEADER_2_JID = "120363888888@g.us";
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
    const { user } = await createTestUser({ plan: "pro" });
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
    const { user } = await createTestUser({ plan: "pro" });
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
    const { user } = await createTestUser({ plan: "pro" });
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
    const { user } = await createTestUser({ plan: "pro" });
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
    const { user } = await createTestUser({ plan: "pro" });
    affiliate.writeConfig(user.id, { tag: "t", cookie: "c-sessid" });
    await storage.saveState(user.id, { groups: [repasseGroup(5005, { auto: true })] });
    await capture.rebuildLeaderIndex();

    await capture.onUpsert(user.id, NUMBER_ID, [msgWithText("https://www.mercadolivre.com.br/p/MLB777")]);
    await capture.onUpsert(user.id, NUMBER_ID, [msgWithText("https://www.mercadolivre.com.br/p/MLB777")]);

    const g = (await storage.loadState(user.id)).groups.find(x => x.id === 5005);
    expect(g.queue.length).toBe(1);
  });

  it("campanha com 2 líderes: cada grupo alimenta a mesma fila; link repetido não duplica", async () => {
    const { user } = await createTestUser({ plan: "pro" });
    affiliate.writeConfig(user.id, { tag: "t", cookie: "c-sessid" });
    const g = repasseGroup(5007, { auto: true });
    g.scraping.repasse = { leaders: [
      { numberId: NUMBER_ID, jid: LEADER_JID, name: "Líder 1" },
      { numberId: NUMBER_ID, jid: LEADER_2_JID, name: "Líder 2" },
    ] };
    await storage.saveState(user.id, { groups: [g] });
    await capture.rebuildLeaderIndex();

    await capture.onUpsert(user.id, NUMBER_ID, [msgWithText("https://www.mercadolivre.com.br/p/MLB111")]);
    await capture.onUpsert(user.id, NUMBER_ID, [msgWithText("https://www.mercadolivre.com.br/p/MLB222", { jid: LEADER_2_JID })]);
    // Mesmo link nos dois líderes → duplicata silenciosa.
    await capture.onUpsert(user.id, NUMBER_ID, [msgWithText("https://www.mercadolivre.com.br/p/MLB111", { jid: LEADER_2_JID })]);

    const saved = (await storage.loadState(user.id)).groups.find(x => x.id === 5007);
    expect(saved.queue.length).toBe(2);
  });

  it("líder no formato antigo (um só) continua capturando após o save", async () => {
    const { user } = await createTestUser({ plan: "pro" });
    affiliate.writeConfig(user.id, { tag: "t", cookie: "c-sessid" });
    // repasseGroup() usa o formato legado {leaderNumberId, leaderJid} de propósito.
    await storage.saveState(user.id, { groups: [repasseGroup(5008, { auto: true })] });
    const stored = (await storage.loadState(user.id)).groups.find(x => x.id === 5008);
    expect(stored.scraping.repasse.leaders).toEqual([
      { numberId: NUMBER_ID, jid: LEADER_JID, name: "Grupo Líder" },
    ]);
    await capture.rebuildLeaderIndex();

    await capture.onUpsert(user.id, NUMBER_ID, [msgWithText("https://www.mercadolivre.com.br/p/MLB888")]);
    const g = (await storage.loadState(user.id)).groups.find(x => x.id === 5008);
    expect(g.queue.length).toBe(1);
  });

  it("ignora mensagem de grupo que não é líder", async () => {
    const { user } = await createTestUser({ plan: "pro" });
    affiliate.writeConfig(user.id, { tag: "t", cookie: "c-sessid" });
    await storage.saveState(user.id, { groups: [repasseGroup(5006, { auto: true })] });
    await capture.rebuildLeaderIndex();

    await capture.onUpsert(user.id, NUMBER_ID, [
      msgWithText("https://www.mercadolivre.com.br/p/MLB123", { jid: "000000@g.us" }),
    ]);

    const g = (await storage.loadState(user.id)).groups.find(x => x.id === 5006);
    expect(g.queue.length + g.pending.length).toBe(0);
  });

  // A captura roda no listener do Baileys, fora de rota HTTP — não passava por
  // gating nenhum. Conta cancelada seguia rodando o scraper indefinidamente.
  it("assinatura inativa não captura nem chama o scraper", async () => {
    const { user } = await createTestUser({ plan: "pro" });
    affiliate.writeConfig(user.id, { tag: "t", cookie: "c-sessid" });
    await storage.saveState(user.id, { groups: [repasseGroup(5009, { auto: true })] });
    await capture.rebuildLeaderIndex();
    await billing.update(user.id, { planId: "pro", status: "canceled" });

    await capture.onUpsert(user.id, NUMBER_ID, [msgWithText("https://www.mercadolivre.com.br/p/MLB999")]);

    const g = (await storage.loadState(user.id)).groups.find(x => x.id === 5009);
    expect(g.queue.length + g.pending.length).toBe(0);
    expect(scraper.scrapeSingleProduct).not.toHaveBeenCalled();
  });

  // Campanha pausada pelo plano não envia — enfileirar nela só engordaria a
  // fila em silêncio.
  it("campanha pausada pelo plano não recebe captura", async () => {
    const { user } = await createTestUser({ plan: "pro" });
    affiliate.writeConfig(user.id, { tag: "t", cookie: "c-sessid" });
    await storage.saveState(user.id, { groups: [repasseGroup(5010, { auto: true })] });
    await storage.savePlanPaused(user.id, { groups: [5010], numbers: [] });
    await capture.rebuildLeaderIndex();

    await capture.onUpsert(user.id, NUMBER_ID, [msgWithText("https://www.mercadolivre.com.br/p/MLB777")]);

    const g = (await storage.loadState(user.id)).groups.find(x => x.id === 5010);
    expect(g.queue.length + g.pending.length).toBe(0);
  });

  // A trava de loja do admin impede a BUSCA no catálogo daquela loja. No repasse
  // o link já chega pronto do grupo líder, então ela não vale ali.
  it("loja trancada pelo admin não impede o repasse", async () => {
    const storeLocks = require(path.join(backendDir, "scraping", "store-locks.js"));
    const appConfig = require(path.join(backendDir, "config"));
    const { user } = await createTestUser({ plan: "pro" });
    affiliate.writeConfig(user.id, { tag: "t", cookie: "c-sessid" });
    await storage.saveState(user.id, { groups: [repasseGroup(5011, { auto: true })] });
    await capture.rebuildLeaderIndex();
    storeLocks.writeStoreLock("ml", { locked: true, message: "Em manutenção" });

    try {
      await capture.onUpsert(user.id, NUMBER_ID, [msgWithText("https://www.mercadolivre.com.br/p/MLB555")]);

      const g = (await storage.loadState(user.id)).groups.find(x => x.id === 5011);
      expect(g.queue.length).toBe(1);
      expect(g.queue[0].store).toBe("Mercado Livre");
    } finally {
      appConfig.set(storeLocks.STORE_LOCKS_KEY, {});
    }
  });
});
