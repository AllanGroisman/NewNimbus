const express = require("express");
const cors = require("cors");
const { CATEGORIES, STORES, scrapeSingleProduct } = require("./scraper");
const wa = require("./whatsapp");
const auth = require("./auth");
const storage = require("./storage");
const scheduler = require("./scheduler");
const affiliate = require("./affiliate");
const catalog = require("./catalog");
const adminScraper = require("./admin-scraper");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: "2mb" }));

// ────────────────────────────────────────────────────────────────────────
// Auth
// ────────────────────────────────────────────────────────────────────────

app.post("/api/auth/register", async (req, res) => {
  try {
    const { name, email, password, phone } = req.body || {};
    const user = await auth.register({ name, email, password, phone });
    const { token } = await auth.login({ email, password });
    res.json({ user, token });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const result = await auth.login({ email, password });
    res.json(result);
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

app.get("/api/auth/me", auth.requireAuth, (req, res) => {
  res.json({ user: req.user });
});

app.patch("/api/auth/me", auth.requireAuth, async (req, res) => {
  try {
    const user = await auth.updateProfile(req.user.id, req.body || {});
    res.json({ user });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/auth/password", auth.requireAuth, async (req, res) => {
  try {
    await auth.changePassword(req.user.id, req.body || {});
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────────────────
// Persistência de estado da app por usuário
// ────────────────────────────────────────────────────────────────────────

app.get("/api/state", auth.requireAuth, (req, res) => {
  res.json(storage.loadState(req.user.id));
});

app.put("/api/state", auth.requireAuth, async (req, res) => {
  try {
    const saved = await storage.saveState(req.user.id, req.body || {});
    res.json({ ok: true, updatedAt: saved.updatedAt });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/state/ops", auth.requireAuth, (req, res) => {
  res.json(storage.loadOps(req.user.id));
});

// ────────────────────────────────────────────────────────────────────────
// Afiliados ML
// ────────────────────────────────────────────────────────────────────────

app.get("/api/affiliate", auth.requireAuth, (req, res) => {
  res.json(affiliate.status());
});

app.put("/api/affiliate", auth.requireAuth, (req, res) => {
  try {
    const { tag, cookie } = req.body || {};
    affiliate.writeConfig({ tag, cookie });
    res.json(affiliate.status());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/affiliate", auth.requireAuth, (req, res) => {
  try {
    affiliate.clearConfig();
    res.json(affiliate.status());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/affiliate/test", auth.requireAuth, async (req, res) => {
  try {
    const url = req.body?.url;
    if (!url || typeof url !== "string" || !url.trim()) {
      return res.status(400).json({ error: "Forneça uma URL de produto do Mercado Livre pra testar." });
    }
    const short = await affiliate.gerarLinkAfiliadoML(url.trim());
    if (!short) {
      const s = affiliate.status();
      const reason = s.lastFailureReason || "Falha ao gerar link";
      return res.status(400).json({ error: reason, cookieHealthy: !!s.healthy });
    }
    res.json({ ok: true, shortUrl: short });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Afiliado Amazon ───────────────────────────────────────────────────

app.put("/api/affiliate/amazon", auth.requireAuth, (req, res) => {
  try {
    const { tag } = req.body || {};
    affiliate.writeAmazonConfig({ tag });
    res.json(affiliate.status());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/affiliate/amazon", auth.requireAuth, (req, res) => {
  try {
    affiliate.clearAmazonConfig();
    res.json(affiliate.status());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/affiliate/amazon/test", auth.requireAuth, (req, res) => {
  try {
    const url = req.body?.url;
    if (!url || typeof url !== "string" || !url.trim()) {
      return res.status(400).json({ error: "Forneça uma URL de produto da Amazon pra testar." });
    }
    const short = affiliate.gerarLinkAfiliadoAmazon(url.trim());
    if (!short) {
      const s = affiliate.status();
      const reason = s.amazon.lastFailureReason
        || (!s.amazon.configured ? "Configure a tag de afiliado da Amazon primeiro." : "Falha ao gerar link");
      return res.status(400).json({ error: reason });
    }
    res.json({ ok: true, shortUrl: short });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Dispara envio do próximo item da fila imediatamente
app.post("/api/state/groups/:gid/send-now", auth.requireAuth, async (req, res) => {
  try {
    const groupId = isNaN(Number(req.params.gid)) ? req.params.gid : Number(req.params.gid);
    const r = await scheduler.sendNextNow(req.user.id, groupId);
    res.json({ ok: true, ...r });
  } catch (err) {
    console.error("[send-now]", err.message);
    res.status(400).json({ error: err.message });
  }
});

// Aprovar item pendente: move de pending pra queue (final).
app.post("/api/state/groups/:gid/pending/:pid/approve", auth.requireAuth, async (req, res) => {
  try {
    const groupId = isNaN(Number(req.params.gid)) ? req.params.gid : Number(req.params.gid);
    const pid = req.params.pid;
    const state = storage.loadState(req.user.id);
    const group = (state.groups || []).find(g => g.id === groupId);
    if (!group) return res.status(404).json({ error: "Campanha não encontrada" });
    const idx = (group.pending || []).findIndex(p => String(p.id ?? p.key) === String(pid));
    if (idx < 0) return res.status(404).json({ error: "Item pendente não encontrado" });
    const item = group.pending[idx];
    const newPending = group.pending.filter((_, i) => i !== idx);
    const newQueue = [...(group.queue || []), item];
    await storage.updateGroupOps(req.user.id, groupId, { pending: newPending, queue: newQueue });
    res.json({ ok: true, queueSize: newQueue.length, pendingSize: newPending.length });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Rejeitar item pendente: remove de pending.
app.delete("/api/state/groups/:gid/pending/:pid", auth.requireAuth, async (req, res) => {
  try {
    const groupId = isNaN(Number(req.params.gid)) ? req.params.gid : Number(req.params.gid);
    const pid = req.params.pid;
    const state = storage.loadState(req.user.id);
    const group = (state.groups || []).find(g => g.id === groupId);
    if (!group) return res.status(404).json({ error: "Campanha não encontrada" });
    const newPending = (group.pending || []).filter(p => String(p.id ?? p.key) !== String(pid));
    if (newPending.length === (group.pending || []).length) {
      return res.status(404).json({ error: "Item pendente não encontrado" });
    }
    await storage.updateGroupOps(req.user.id, groupId, { pending: newPending });
    res.json({ ok: true, pendingSize: newPending.length });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Limpa o histórico de envios da campanha (reseta cooldown — produtos podem voltar)
app.delete("/api/state/groups/:gid/history", auth.requireAuth, async (req, res) => {
  try {
    const groupId = isNaN(Number(req.params.gid)) ? req.params.gid : Number(req.params.gid);
    const updated = await storage.updateGroupOps(req.user.id, groupId, {
      history: [],
      sentToday: 0,
      sentWeek: 0,
      weekData: [0, 0, 0, 0, 0, 0, 0],
      lastSend: "—",
    });
    if (!updated) return res.status(404).json({ error: "Campanha não encontrada" });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Busca metadados de uma URL única (Puppeteer) — usado pelo "Adicionar link".
// Não bloqueia em erro: devolve campos null pra UI deixar editar manualmente.
app.post("/api/scraper/fetch-url", auth.requireAuth, async (req, res) => {
  try {
    const url = req.body?.url;
    if (!url || typeof url !== "string" || !url.trim()) {
      return res.status(400).json({ error: "URL obrigatória" });
    }
    const data = await scrapeSingleProduct(url.trim());
    res.json(data);
  } catch (err) {
    console.error("[fetch-url]", err.message);
    res.status(400).json({ error: err.message });
  }
});

// Adiciona um produto manualmente à fila/pending da campanha.
// Body: { url, overrides: { name, price, originalPrice, discount, img, store, category }, force? }
// Resposta:
//  - { ok: true, target, item, ... } quando adicionado
//  - { inCooldown: true, lastSentAt, cooldownMinutes, cooldownLabel } pedindo confirmação (UI manda force=true depois)
//  - 400 com error em duplicata na fila/pending ou validação
app.post("/api/state/groups/:gid/manual-add", auth.requireAuth, async (req, res) => {
  try {
    const groupId = isNaN(Number(req.params.gid)) ? req.params.gid : Number(req.params.gid);
    const r = await scheduler.manualAdd(req.user.id, groupId, req.body || {});
    res.json(r);
  } catch (err) {
    const status = err.code === "duplicate_queue" || err.code === "duplicate_pending" ? 409 : 400;
    res.status(status).json({ error: err.message, code: err.code || null });
  }
});

// Força refill da fila a partir do catálogo (aplica filtros da campanha).
// Aceita body opcional { filters, sources, categories } com overrides ainda não persistidos.
app.post("/api/state/groups/:gid/refill", auth.requireAuth, async (req, res) => {
  try {
    const groupId = isNaN(Number(req.params.gid)) ? req.params.gid : Number(req.params.gid);
    const r = await scheduler.refillNow(req.user.id, groupId, req.body || {});
    res.json({ ok: true, ...r });
  } catch (err) {
    console.error("[refill]", err.message);
    res.status(400).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────────────────
// Ofertas — agora lê do CATÁLOGO global (preenchido pelo admin-scraper)
// ────────────────────────────────────────────────────────────────────────

app.get("/api/ofertas", auth.requireAuth, (req, res) => {
  try {
    const category = req.query.category || null;
    const minDiscount = parseInt(req.query.minDiscount) || 0;
    const minPrice = parseFloat(req.query.minPrice) || 0;
    const maxPrice = parseFloat(req.query.maxPrice) || Infinity;
    const limit = parseInt(req.query.limit) || 50;
    const sources = req.query.sources
      ? String(req.query.sources).split(",").map(s => s.trim()).filter(Boolean)
      : null;

    const products = catalog.query({
      categories: category ? [category] : null,
      sources,
      filters: { minDiscount, minPrice, maxPrice },
      limit,
      sortBy: "discount_desc",
    });

    res.json({
      total: products.length,
      category,
      sources,
      products,
      catalogStats: catalog.getStats(),
    });
  } catch (err) {
    console.error("[ofertas] Erro:", err.message);
    res.status(500).json({ error: "Falha ao buscar ofertas", details: err.message });
  }
});

app.get("/api/categories", (req, res) => {
  const cats = Object.entries(CATEGORIES).map(([id, info]) => ({ id, label: info.label }));
  res.json(cats);
});

app.get("/api/status", (req, res) => {
  const s = catalog.getStats();
  res.json({
    status: "ok",
    categories: Object.keys(CATEGORIES),
    catalog: s,
    adminScraper: adminScraper.status(),
  });
});

// ────────────────────────────────────────────────────────────────────────
// Admin — gerenciamento de usuários
// ────────────────────────────────────────────────────────────────────────

app.get("/api/admin/users", auth.requireAuth, auth.requireAdmin, (req, res) => {
  res.json({ users: auth.listUsers() });
});

app.delete("/api/admin/users/:id", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    if (req.params.id === req.user.id) {
      return res.status(400).json({ error: "Você não pode excluir a si mesmo" });
    }
    auth.deleteUser(req.params.id);
    storage.clearState(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch("/api/admin/users/:id/password", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const { newPassword } = req.body || {};
    await auth.adminSetPassword(req.params.id, newPassword);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch("/api/admin/users/:id/role", auth.requireAuth, auth.requireAdmin, (req, res) => {
  try {
    const { role } = req.body || {};
    if (req.params.id === req.user.id && role !== "admin") {
      return res.status(400).json({ error: "Você não pode rebaixar a si mesmo" });
    }
    const user = auth.setUserRole(req.params.id, role);
    res.json({ user });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────────────────
// Admin — scraper global e catálogo
// ────────────────────────────────────────────────────────────────────────

app.get("/api/admin/scraper/config", auth.requireAuth, auth.requireAdmin, (req, res) => {
  res.json({
    config: adminScraper.readConfig(),
    available: {
      categories: Object.entries(CATEGORIES).map(([id, info]) => ({ id, label: info.label })),
      sources: Object.entries(STORES).map(([id, info]) => ({ id, label: info.label })),
    },
  });
});

app.put("/api/admin/scraper/config", auth.requireAuth, auth.requireAdmin, (req, res) => {
  try {
    const cfg = adminScraper.writeConfig(req.body || {});
    res.json({ config: cfg });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/admin/scraper/run", auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    if (adminScraper.status().running) {
      return res.status(409).json({ error: "Scraping já em execução" });
    }
    // Não bloqueia a resposta — roda em background
    adminScraper.runOnce().catch(err => console.error("[admin-scraper.run]", err.message));
    res.json({ ok: true, message: "Scraping iniciado em background" });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/admin/scraper/status", auth.requireAuth, auth.requireAdmin, (req, res) => {
  res.json(adminScraper.status());
});

// Lista paginada do catálogo, com filtros opcionais — visualização do admin
app.get("/api/admin/catalog", auth.requireAuth, auth.requireAdmin, (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(10, parseInt(req.query.pageSize) || 50));
    const category = req.query.category || null;
    const source = req.query.source || null;
    const search = (req.query.q || "").toString().trim().toLowerCase();
    const sortBy = req.query.sortBy || "lastSeen_desc";

    let items = catalog.query({
      categories: category ? [category] : null,
      sources: source ? [source] : null,
      limit: 0,
      sortBy,
    });
    if (search) items = items.filter(p => (p.name || "").toLowerCase().includes(search));

    const total = items.length;
    const start = (page - 1) * pageSize;
    const slice = items.slice(start, start + pageSize);
    res.json({
      page,
      pageSize,
      total,
      items: slice,
      stats: catalog.getStats(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────────────────
// WhatsApp (Baileys)
// ────────────────────────────────────────────────────────────────────────

app.get("/api/whatsapp/sessions", auth.requireAuth, (req, res) => {
  res.json(wa.listSessions(req.user.id));
});

app.post("/api/whatsapp/sessions/:id", auth.requireAuth, async (req, res) => {
  try {
    await wa.startSession(req.user.id, req.params.id);
    const s = wa.getSession(req.user.id, req.params.id);
    res.json({ ok: true, id: req.params.id, status: s?.status });
  } catch (err) {
    console.error("[whatsapp] startSession:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/whatsapp/sessions/:id", auth.requireAuth, (req, res) => {
  const s = wa.getSession(req.user.id, req.params.id);
  if (!s) return res.status(404).json({ error: "Sessão não encontrada" });
  res.json({
    id: s.numberId,
    status: s.status,
    qr: s.qrDataUrl || null,
    info: s.info || null,
    lastError: s.lastError || null,
  });
});

app.delete("/api/whatsapp/sessions/:id", auth.requireAuth, async (req, res) => {
  try {
    await wa.deleteSession(req.user.id, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/whatsapp/sessions/:id/groups", auth.requireAuth, async (req, res) => {
  try {
    const groups = await wa.listGroups(req.user.id, req.params.id);
    res.json(groups);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/whatsapp/sessions/:id/groups", auth.requireAuth, async (req, res) => {
  try {
    const { name, participants = [] } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: "name obrigatório" });
    if (!Array.isArray(participants) || participants.length === 0) {
      return res.status(400).json({ error: "informe ao menos um participante (telefone)" });
    }
    const group = await wa.createGroup(req.user.id, req.params.id, String(name).trim(), participants);
    res.json(group);
  } catch (err) {
    console.error("[whatsapp] createGroup:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/whatsapp/sessions/:id/groups/:jid/invite", auth.requireAuth, async (req, res) => {
  try {
    const inviteLink = await wa.getInviteLink(req.user.id, req.params.id, req.params.jid);
    res.json({ inviteLink });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/whatsapp/sessions/:id/groups/:jid/invite/revoke", auth.requireAuth, async (req, res) => {
  try {
    const inviteLink = await wa.revokeInvite(req.user.id, req.params.id, req.params.jid);
    res.json({ inviteLink });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/whatsapp/sessions/:id/groups/:jid", auth.requireAuth, async (req, res) => {
  try {
    await wa.leaveGroup(req.user.id, req.params.id, req.params.jid);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/whatsapp/sessions/:id/send", auth.requireAuth, async (req, res) => {
  try {
    const { jid, text, imageUrl } = req.body || {};
    if (!jid) return res.status(400).json({ error: "jid obrigatório" });
    if (!text && !imageUrl) return res.status(400).json({ error: "text ou imageUrl obrigatório" });
    if (imageUrl) {
      await wa.sendImage(req.user.id, req.params.id, jid, imageUrl, text);
    } else {
      await wa.sendText(req.user.id, req.params.id, jid, text);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("[whatsapp] send:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/whatsapp/sessions/:id/broadcast", auth.requireAuth, async (req, res) => {
  try {
    const { jids = [], text, imageUrl, intervalMs = 4000 } = req.body || {};
    if (!Array.isArray(jids) || jids.length === 0) return res.status(400).json({ error: "jids obrigatório (array)" });
    if (!text && !imageUrl) return res.status(400).json({ error: "text ou imageUrl obrigatório" });

    const results = [];
    for (let i = 0; i < jids.length; i++) {
      const jid = jids[i];
      try {
        if (imageUrl) {
          await wa.sendImage(req.user.id, req.params.id, jid, imageUrl, text);
        } else {
          await wa.sendText(req.user.id, req.params.id, jid, text);
        }
        results.push({ jid, ok: true });
      } catch (err) {
        results.push({ jid, ok: false, error: err.message });
      }
      if (i < jids.length - 1 && intervalMs > 0) {
        await new Promise(r => setTimeout(r, intervalMs));
      }
    }
    res.json({ ok: true, results });
  } catch (err) {
    console.error("[whatsapp] broadcast:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Nimbus Backend rodando em http://localhost:${PORT}`);
  console.log(`  GET  /api/ofertas?category=gamer&minDiscount=20&limit=10`);
  console.log(`  GET  /api/status`);
  console.log(`  GET  /api/admin/scraper/config (admin)`);
  console.log(`  POST /api/admin/scraper/run    (admin)`);
  console.log(`  GET  /api/admin/users          (admin)`);

  wa.restoreSessions();
  scheduler.start();
  adminScraper.start();
});
