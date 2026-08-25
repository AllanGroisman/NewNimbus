// Captura de links dos grupos líderes (campanhas de repasse).
// Cobre: índice de líderes (query jsonb), extração de URL, filtro por loja/afiliado,
// enriquecimento (scrapeSingleProduct mockado), inserção em pending/queue, dedup.

import { describe, it, expect, beforeEach, vi } from "vitest";
import path from "path";
import { createTestUser, storage, affiliate, billing, auth as authMod } from "../helpers/app.js";

const backendDir = path.resolve(__dirname, "..", "..", "backend");
const scraper = require(path.join(backendDir, "scraping", "scraper.js"));
const capture = require(path.join(backendDir, "repasse", "capture.js"));
const mlSocial = require(path.join(backendDir, "scraping", "ml-social.js"));
const { prisma } = require(path.join(backendDir, "db.js"));

const logsOf = (userId) =>
  prisma().repasseCaptureLog.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });

// logCapture() roda solto no capture.js (sem await, pra não segurar a captura),
// então a linha entra pouco depois do onUpsert resolver. Espera curta pra o teste
// não depender desse timing — no caminho do descarte não sobra nada pra aguardar.
async function waitForLogs(userId, n, timeoutMs = 5000) {
  const t0 = Date.now();
  for (;;) {
    const rows = await logsOf(userId);
    if (rows.length >= n || Date.now() - t0 > timeoutMs) return rows;
    await new Promise(r => setTimeout(r, 50));
  }
}

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

  // O cupom já seguia junto do produto até o envio, mas não aparecia no log de
  // captura — não dava pra saber depois se a mensagem trazia código nenhum.
  it("log de captura guarda o cupom lido da legenda", async () => {
    const { user } = await createTestUser({ plan: "pro" });
    affiliate.writeConfig(user.id, { tag: "t", cookie: "c-sessid" });
    await storage.saveState(user.id, { groups: [repasseGroup(5012, { auto: true })] });
    await capture.rebuildLeaderIndex();

    await capture.onUpsert(user.id, NUMBER_ID, [
      msgWithText("Fone JBL https://www.mercadolivre.com.br/p/MLB777 use o cupom JBL20"),
    ]);

    const logs = await waitForLogs(user.id, 1);
    expect(logs.length).toBe(1);
    expect(logs[0].outcome).toBe("queued");
    expect(logs[0].coupon).toBe("JBL20");
  });

  it("sem cupom na legenda, o log grava null", async () => {
    const { user } = await createTestUser({ plan: "pro" });
    affiliate.writeConfig(user.id, { tag: "t", cookie: "c-sessid" });
    await storage.saveState(user.id, { groups: [repasseGroup(5013, { auto: true })] });
    await capture.rebuildLeaderIndex();

    await capture.onUpsert(user.id, NUMBER_ID, [
      msgWithText("https://www.mercadolivre.com.br/p/MLB778"),
    ]);

    const logs = await waitForLogs(user.id, 1);
    expect(logs.length).toBe(1);
    expect(logs[0].coupon).toBeNull();
  });

  // Descarte é justamente onde o cupom some sem deixar rastro: não vira produto
  // nenhum, então o log é o único lugar onde ele pode aparecer.
  it("link descartado também registra o cupom da mensagem", async () => {
    const { user } = await createTestUser({ plan: "pro" });
    affiliate.writeConfig(user.id, { tag: "t", cookie: "c-sessid" });
    await storage.saveState(user.id, { groups: [repasseGroup(5014, { auto: true })] });
    await capture.rebuildLeaderIndex();

    await capture.onUpsert(user.id, NUMBER_ID, [
      msgWithText("https://www.magazineluiza.com.br/produto/123 cupom: TECH-10"),
    ]);

    const logs = await waitForLogs(user.id, 1);
    expect(logs.length).toBe(1);
    expect(logs[0].outcome).toBe("discarded");
    expect(logs[0].coupon).toBe("TECH-10");
  });

  it("o log do admin devolve o cupom junto da linha", async () => {
    const { user } = await createTestUser({ plan: "pro" });
    affiliate.writeConfig(user.id, { tag: "t", cookie: "c-sessid" });
    await storage.saveState(user.id, { groups: [repasseGroup(5015, { auto: true })] });
    await capture.rebuildLeaderIndex();
    await capture.onUpsert(user.id, NUMBER_ID, [
      msgWithText("https://www.mercadolivre.com.br/p/MLB779 aplique o código GALAXY10"),
    ]);

    await waitForLogs(user.id, 1);

    const admin = await createTestUser({ plan: "pro" });
    await authMod.setUserRole(admin.user.id, "admin");
    const r = await admin.auth("get", "/api/admin/repasse/logs");
    expect(r.status).toBe(200);
    const linha = r.body.items.find(i => i.userId === user.id);
    expect(linha.coupon).toBe("GALAXY10");
  });
});

// O motivo do descarte precisa ser CONTÁVEL, não só legível: sem `errorKind` não
// dava pra ver que 10 descartes eram o mesmo problema, e sem `stage` o painel
// mostrava um traço solto onde na verdade a etapa nem tinha rodado.
describe("repasse capture — motivo e etapa do descarte", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    global.fetch = vi.fn(async (url) => ({ url, body: { cancel: async () => {} } }));
  });

  async function capturar(groupId, texto, { comAfiliado = true } = {}) {
    const { user } = await createTestUser({ plan: "pro" });
    if (comAfiliado) affiliate.writeConfig(user.id, { tag: "t", cookie: "c-sessid" });
    await storage.saveState(user.id, { groups: [repasseGroup(groupId, { auto: true })] });
    await capture.rebuildLeaderIndex();
    await capture.onUpsert(user.id, NUMBER_ID, [msgWithText(texto)]);
    return { user, logs: await waitForLogs(user.id, 1) };
  }

  it("loja não suportada para na primeira etapa", async () => {
    const { logs } = await capturar(5020, "https://www.magazineluiza.com.br/produto/123");
    expect(logs[0].errorKind).toBe("loja-nao-suportada");
    expect(logs[0].stage).toBe("store");
  });

  it("afiliado ausente é motivo próprio, e não uma falha de leitura", async () => {
    const { logs } = await capturar(5021, "https://www.mercadolivre.com.br/p/MLB123", { comAfiliado: false });
    expect(logs[0].errorKind).toBe("afiliado-ausente");
    expect(logs[0].stage).toBe("affiliate-config");
  });

  it("CAPTCHA vem tipado do scraper, e o texto humano fica ao lado", async () => {
    vi.spyOn(scraper, "scrapeSingleProduct").mockImplementation(async () => {
      const err = new Error("Mercado Livre pediu verificação (CAPTCHA) — bloqueio passageiro, tente daqui a alguns minutos.");
      err.blocked = true; err.captcha = true; err.kind = "captcha";
      throw err;
    });
    const { logs } = await capturar(5022, "https://www.mercadolivre.com.br/p/MLB124");
    expect(logs[0].errorKind).toBe("captcha");
    expect(logs[0].stage).toBe("scrape");
    expect(logs[0].reason).toMatch(/CAPTCHA/);
    // A mensagem não pode mais mandar esperar E revisar o cookie ao mesmo tempo.
    expect(logs[0].reason).not.toMatch(/cookie/i);
  });

  it("muro de login é login-wall, não CAPTCHA — um pede ação, o outro paciência", async () => {
    vi.spyOn(scraper, "scrapeSingleProduct").mockImplementation(async () => {
      const err = new Error("Mercado Livre pediu login — verifique o cookie de afiliado nas Configurações.");
      err.blocked = true; err.kind = "login-wall";
      throw err;
    });
    const { logs } = await capturar(5023, "https://www.mercadolivre.com.br/p/MLB125");
    expect(logs[0].errorKind).toBe("login-wall");
  });

  it("timeout do navegador não vira 'motivo desconhecido'", async () => {
    vi.spyOn(scraper, "scrapeSingleProduct").mockImplementation(async () => {
      throw new Error("Navigation timeout of 30000 ms exceeded");
    });
    const { logs } = await capturar(5024, "https://www.mercadolivre.com.br/p/MLB126");
    expect(logs[0].errorKind).toBe("timeout");
    expect(logs[0].stage).toBe("scrape");
  });

  it("landing de afiliado que não abriu a PDP é caso próprio, não 'não é produto'", async () => {
    // O produto volta sem nome/preço E a URL final ainda é a landing /social/:
    // o link até era de produto, só está velho ou é de outro afiliado.
    vi.spyOn(scraper, "scrapeSingleProduct").mockImplementation(async (url) => ({
      name: null, link: url, finalUrl: "https://www.mercadolivre.com.br/social/abc123",
      price: null, img: null, store: "Mercado Livre",
    }));
    const { logs } = await capturar(5025, "https://www.mercadolivre.com.br/social/abc123");
    expect(logs[0].errorKind).toBe("landing-expirada");
    expect(logs[0].stage).toBe("validate");
  });

  it("página que não é produto continua sendo nao-e-produto", async () => {
    vi.spyOn(scraper, "scrapeSingleProduct").mockImplementation(async (url) => ({
      name: null, link: url, finalUrl: "https://www.mercadolivre.com.br/ofertas",
      price: null, img: null, store: "Mercado Livre",
    }));
    const { logs } = await capturar(5026, "https://www.mercadolivre.com.br/ofertas");
    expect(logs[0].errorKind).toBe("nao-e-produto");
  });

  it("fonte não habilitada na campanha NÃO é erro — sem errorKind, pra não sujar a taxa", async () => {
    const { user } = await createTestUser({ plan: "pro" });
    affiliate.writeConfig(user.id, { tag: "t", cookie: "c-sessid" });
    vi.spyOn(scraper, "scrapeSingleProduct").mockImplementation(async (url) => ({
      name: "Produto", link: url, price: 10, img: "https://img/x.jpg", store: "Mercado Livre",
    }));
    const g = repasseGroup(5027, { auto: true });
    g.scraping.sources = ["Amazon"]; // ML fora das lojas da campanha
    await storage.saveState(user.id, { groups: [g] });
    await capture.rebuildLeaderIndex();
    await capture.onUpsert(user.id, NUMBER_ID, [msgWithText("https://www.mercadolivre.com.br/p/MLB127")]);

    const logs = await waitForLogs(user.id, 1);
    expect(logs[0].outcome).toBe("discarded");
    expect(logs[0].errorKind).toBeNull();
    expect(logs[0].stage).toBe("source");
  });

  it("link aprovado registra a etapa da fila", async () => {
    vi.spyOn(scraper, "scrapeSingleProduct").mockImplementation(async (url) => ({
      name: "Produto", link: url, price: 10, img: "https://img/x.jpg", store: "Mercado Livre",
    }));
    const { logs } = await capturar(5028, "https://www.mercadolivre.com.br/p/MLB128");
    expect(logs[0].outcome).toBe("queued");
    expect(logs[0].stage).toBe("queue");
    expect(logs[0].errorKind).toBeNull();
  });
});

describe("admin — filtro por motivo e resumo", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    global.fetch = vi.fn(async (url) => ({ url, body: { cancel: async () => {} } }));
    vi.spyOn(scraper, "scrapeSingleProduct").mockImplementation(async () => {
      const err = new Error("Mercado Livre pediu verificação (CAPTCHA) — bloqueio passageiro, tente daqui a alguns minutos.");
      err.blocked = true; err.captcha = true; err.kind = "captcha";
      throw err;
    });
  });

  it("a lista filtra por errorKind e devolve a etapa", async () => {
    const { user } = await createTestUser({ plan: "pro" });
    affiliate.writeConfig(user.id, { tag: "t", cookie: "c-sessid" });
    await storage.saveState(user.id, { groups: [repasseGroup(5030, { auto: true })] });
    await capture.rebuildLeaderIndex();
    await capture.onUpsert(user.id, NUMBER_ID, [msgWithText("https://www.mercadolivre.com.br/p/MLB130")]);
    await waitForLogs(user.id, 1);

    const admin = await createTestUser({ plan: "pro" });
    await authMod.setUserRole(admin.user.id, "admin");

    const achou = await admin.auth("get", `/api/admin/repasse/logs?userId=${user.id}&errorKind=captcha`);
    expect(achou.status).toBe(200);
    expect(achou.body.items.length).toBe(1);
    expect(achou.body.items[0].stage).toBe("scrape");

    const vazio = await admin.auth("get", `/api/admin/repasse/logs?userId=${user.id}&errorKind=timeout`);
    expect(vazio.body.items.length).toBe(0);
  });

  it("o resumo mostra o bloqueio como sistêmico: 0% na loja e o motivo dominante", async () => {
    const { user } = await createTestUser({ plan: "pro" });
    affiliate.writeConfig(user.id, { tag: "t", cookie: "c-sessid" });
    await storage.saveState(user.id, { groups: [repasseGroup(5031, { auto: true })] });
    await capture.rebuildLeaderIndex();
    await capture.onUpsert(user.id, NUMBER_ID, [
      msgWithText("https://www.mercadolivre.com.br/p/MLB131"),
      msgWithText("https://www.mercadolivre.com.br/p/MLB132"),
    ]);
    await waitForLogs(user.id, 2);

    const admin = await createTestUser({ plan: "pro" });
    await authMod.setUserRole(admin.user.id, "admin");
    const r = await admin.auth("get", `/api/admin/repasse/summary?hours=24&userId=${user.id}`);
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(2);
    expect(r.body.byOutcome.discarded).toBe(2);
    expect(r.body.byErrorKind[0]).toMatchObject({ kind: "captcha", count: 2 });

    const ml = r.body.byStore.find(s => s.store === "Mercado Livre");
    expect(ml.successRate).toBe(0);
    expect(ml.failuresSinceLastOk).toBe(2);
    expect(ml.topErrorKind).toBe("captcha");
    // Sem sucesso nenhum, não há "desde quando" — a UI diz "neste período".
    expect(ml.lastOkAt).toBeNull();
    expect(r.body.kinds.captcha.transient).toBe(true);
  });
});

// O incidente do item 104: o ML passou a responder CAPTCHA em TODO link aberto no
// navegador, e o repasse parou por completo. A saída é ler a landing de afiliado
// por HTTP simples ANTES de abrir o Chrome — o caminho que continua respondendo.
describe("repasse capture — landing de afiliado do ML sem navegador", () => {
  const LANDING = "https://www.mercadolivre.com.br/social/gl20260410130458?forceInApp=true";
  const PERMALINK = "https://www.mercadolivre.com.br/controle-xbox/p/MLB52371739";

  beforeEach(() => {
    vi.restoreAllMocks();
    global.fetch = vi.fn(async (url) => ({ url, body: { cancel: async () => {} } }));
  });

  async function capturarComScraperReal(groupId, texto, timeoutMs = 5000) {
    const { user } = await createTestUser({ plan: "pro" });
    affiliate.writeConfig(user.id, { tag: "t", cookie: "c-sessid" });
    await storage.saveState(user.id, { groups: [repasseGroup(groupId, { auto: true })] });
    await capture.rebuildLeaderIndex();
    await capture.onUpsert(user.id, NUMBER_ID, [msgWithText(texto)]);
    return { user, logs: await waitForLogs(user.id, 1, timeoutMs) };
  }

  it("landing lida por fetch entra na fila — o navegador nem chega a abrir", async () => {
    // scrapeSingleProduct roda DE VERDADE aqui: o que está mockado é só a busca
    // HTTP. Se a ordem estivesse invertida, este teste tentaria abrir um Chrome.
    const spyFetch = vi.spyOn(mlSocial, "fetchSocialLanding").mockResolvedValue({
      ok: true, kind: "ok", reason: "lido sem navegador",
      product: {
        name: "Controle Sem Fio Xbox Series S/x", link: PERMALINK, finalUrl: PERMALINK,
        price: 442, originalPrice: null, discount: null, img: "https://http2.mlstatic.com/x-F.webp",
        store: "Mercado Livre",
      },
    });

    const { user, logs } = await capturarComScraperReal(5040, LANDING);

    expect(spyFetch).toHaveBeenCalledTimes(1);
    expect(logs[0].outcome).toBe("queued");
    expect(logs[0].errorKind).toBeNull();

    const state = await storage.loadState(user.id);
    const item = state.groups[0].queue[0];
    expect(item.name).toBe("Controle Sem Fio Xbox Series S/x");
    // O link guardado é o permalink do produto, não a landing do OUTRO afiliado —
    // é ele que a conversão de afiliado usa na hora do envio.
    expect(item.link).toBe(PERMALINK);
    expect(item.link).not.toMatch(/\/social\//);
  });

  it("link de produto comum não passa pela leitura de landing", async () => {
    // Só landing/encurtador de afiliado vale o fetch; numa PDP normal ele seria
    // um download de ~300 KB jogado fora antes do navegador.
    const spyFetch = vi.spyOn(mlSocial, "fetchSocialLanding");
    vi.spyOn(scraper, "scrapeSingleProduct").mockImplementation(async (url) => ({
      name: "Produto", link: url, finalUrl: url, price: 10, img: "https://img/x.jpg", store: "Mercado Livre",
    }));
    await capturarComScraperReal(5041, "https://www.mercadolivre.com.br/x/p/MLB999");
    expect(spyFetch).not.toHaveBeenCalled();
  });

  it("perfil/lista do afiliado é barrado antes do scrape", async () => {
    // /social/<id>/lists é a vitrine do afiliado, não um produto: abrir um Chrome
    // pra descobrir isso é desperdício puro.
    const spyScrape = vi.spyOn(scraper, "scrapeSingleProduct");
    const { logs } = await capturarComScraperReal(5042, "https://www.mercadolivre.com.br/social/gl20260410130458/lists");
    expect(spyScrape).not.toHaveBeenCalled();
    expect(logs[0].errorKind).toBe("nao-e-produto");
    expect(logs[0].stage).toBe("store");
    expect(logs[0].reason).toMatch(/perfil\/lista do afiliado/);
  });

  it("fetch sem produto não vira item: o descarte por CAPTCHA continua igual", async () => {
    vi.spyOn(mlSocial, "fetchSocialLanding").mockResolvedValue({
      ok: false, kind: "nao-e-produto", reason: "sem destaque", product: null,
    });
    vi.spyOn(scraper, "scrapeSingleProduct").mockImplementation(async () => {
      const err = new Error("Mercado Livre pediu verificação (CAPTCHA) — bloqueio passageiro, tente daqui a alguns minutos.");
      err.blocked = true; err.captcha = true; err.kind = "captcha";
      throw err;
    });
    const { logs } = await capturarComScraperReal(5043, LANDING);
    expect(logs[0].outcome).toBe("discarded");
    expect(logs[0].errorKind).toBe("captcha");
    expect(logs[0].stage).toBe("scrape");
  });

  it("soluço de rede não custa o item: tenta de novo antes de ir pro navegador", async () => {
    // Caso real de 25/08/2026: o DNS falhou por um instante e o item foi
    // descartado com CAPTCHA, porque o navegador é o plano B e está bloqueado.
    const spyFetch = vi.spyOn(mlSocial, "fetchSocialLanding")
      .mockRejectedValueOnce(new Error("Não consegui resolver o endereço do link"))
      .mockResolvedValueOnce({
        ok: true, kind: "ok", reason: "lido sem navegador",
        product: {
          name: "Controle Sem Fio Xbox Series S/x", link: PERMALINK, finalUrl: PERMALINK,
          price: 442, originalPrice: null, discount: null, img: "https://http2.mlstatic.com/x-F.webp",
          store: "Mercado Livre",
        },
      });

    const { user, logs } = await capturarComScraperReal(5044, LANDING, 15000);

    expect(spyFetch).toHaveBeenCalledTimes(2);
    expect(logs[0].outcome).toBe("queued");
    const state = await storage.loadState(user.id);
    expect(state.groups[0].queue[0].link).toBe(PERMALINK);
  }, 30000);
});
