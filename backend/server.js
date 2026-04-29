const express = require("express");
const cors = require("cors");
const { scrapeOfertas, CATEGORIES } = require("./scraper");
const wa = require("./whatsapp");
const auth = require("./auth");
const storage = require("./storage");

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

app.put("/api/state", auth.requireAuth, (req, res) => {
  try {
    const saved = storage.saveState(req.user.id, req.body || {});
    res.json({ ok: true, updatedAt: saved.updatedAt });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────────────────
// Scraping (existente)
// ────────────────────────────────────────────────────────────────────────

const cacheByCategory = {};
const CACHE_TTL = 5 * 60 * 1000;

function getCache(category) {
  const key = category || "_all";
  return cacheByCategory[key] || { data: null, timestamp: 0 };
}

function setCache(category, data) {
  const key = category || "_all";
  cacheByCategory[key] = { data, timestamp: Date.now() };
}

app.get("/api/ofertas", async (req, res) => {
  try {
    const category = req.query.category || null;
    const minDiscount = parseInt(req.query.minDiscount) || 0;
    const maxPrice = parseFloat(req.query.maxPrice) || Infinity;
    const limit = parseInt(req.query.limit) || 50;
    const forceRefresh = req.query.refresh === "true";

    const cache = getCache(category);
    const now = Date.now();
    const cacheValid = cache.data && (now - cache.timestamp < CACHE_TTL) && !forceRefresh;

    let allProducts;
    if (cacheValid) {
      allProducts = cache.data;
      console.log(`[cache] ${category || "geral"}: ${allProducts.length} produtos do cache`);
    } else {
      console.log(`[scraper] Buscando ${category || "todas as"} ofertas...`);
      const start = Date.now();
      allProducts = await scrapeOfertas({ category, minDiscount: 0, maxPrice: Infinity, limit: 200 });
      setCache(category, allProducts);
      console.log(`[scraper] ${allProducts.length} produtos (${category || "geral"}) em ${Date.now() - start}ms`);
    }

    let filtered = allProducts;
    if (minDiscount > 0) filtered = filtered.filter(p => p.discount && p.discount >= minDiscount);
    if (maxPrice < Infinity) filtered = filtered.filter(p => p.price <= maxPrice);
    filtered = filtered.slice(0, limit);

    res.json({ total: filtered.length, cached: cacheValid, category, products: filtered });
  } catch (err) {
    console.error("[scraper] Erro:", err.message);
    res.status(500).json({ error: "Falha ao buscar ofertas", details: err.message });
  }
});

app.get("/api/categories", (req, res) => {
  const cats = Object.entries(CATEGORIES).map(([id, info]) => ({ id, label: info.label, code: info.code }));
  res.json(cats);
});

app.get("/api/status", (req, res) => {
  const caches = Object.entries(cacheByCategory).map(([key, c]) => ({
    category: key,
    products: c.data ? c.data.length : 0,
    age: c.data ? Math.round((Date.now() - c.timestamp) / 1000) + "s" : null,
  }));
  res.json({
    status: "ok",
    categories: Object.keys(CATEGORIES),
    caches,
    cachedProducts: caches.reduce((a, c) => a + c.products, 0),
    whatsappSessions: wa.listSessions(),
  });
});

// ────────────────────────────────────────────────────────────────────────
// WhatsApp (Baileys)
// ────────────────────────────────────────────────────────────────────────

// Lista todas as sessões em memória
app.get("/api/whatsapp/sessions", (req, res) => {
  res.json(wa.listSessions());
});

// Inicia (ou retoma) uma sessão. O id é definido pelo cliente — pode ser
// o numberId local do front ou um uuid. Persistimos os credenciais em disco
// para sobreviver reinícios do servidor.
app.post("/api/whatsapp/sessions/:id", async (req, res) => {
  try {
    await wa.startSession(req.params.id);
    const s = wa.getSession(req.params.id);
    res.json({ ok: true, id: req.params.id, status: s?.status });
  } catch (err) {
    console.error("[whatsapp] startSession:", err);
    res.status(500).json({ error: err.message });
  }
});

// Status atual + QR (se aguardando) + info do número conectado.
// O front faz polling neste endpoint enquanto o status é "awaiting_qr".
app.get("/api/whatsapp/sessions/:id", (req, res) => {
  const s = wa.getSession(req.params.id);
  if (!s) return res.status(404).json({ error: "Sessão não encontrada" });
  res.json({
    id: s.numberId,
    status: s.status,
    qr: s.qrDataUrl || null,
    info: s.info || null,
    lastError: s.lastError || null,
  });
});

// Desconecta e remove credenciais
app.delete("/api/whatsapp/sessions/:id", async (req, res) => {
  try {
    await wa.deleteSession(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Lista grupos do WhatsApp em que o número participa
app.get("/api/whatsapp/sessions/:id/groups", async (req, res) => {
  try {
    const groups = await wa.listGroups(req.params.id);
    res.json(groups);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cria um novo grupo. Body: { name, participants: ["+5511..."] }
// O WhatsApp exige pelo menos um participante (não pode ser apenas o próprio número).
app.post("/api/whatsapp/sessions/:id/groups", async (req, res) => {
  try {
    const { name, participants = [] } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: "name obrigatório" });
    if (!Array.isArray(participants) || participants.length === 0) {
      return res.status(400).json({ error: "informe ao menos um participante (telefone)" });
    }
    const group = await wa.createGroup(req.params.id, String(name).trim(), participants);
    res.json(group);
  } catch (err) {
    console.error("[whatsapp] createGroup:", err);
    res.status(500).json({ error: err.message });
  }
});

// Link de convite atual do grupo
app.get("/api/whatsapp/sessions/:id/groups/:jid/invite", async (req, res) => {
  try {
    const inviteLink = await wa.getInviteLink(req.params.id, req.params.jid);
    res.json({ inviteLink });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Revoga o convite atual e devolve o novo
app.post("/api/whatsapp/sessions/:id/groups/:jid/invite/revoke", async (req, res) => {
  try {
    const inviteLink = await wa.revokeInvite(req.params.id, req.params.jid);
    res.json({ inviteLink });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Sai do grupo (não exclui — sai e deixa de receber mensagens)
app.delete("/api/whatsapp/sessions/:id/groups/:jid", async (req, res) => {
  try {
    await wa.leaveGroup(req.params.id, req.params.jid);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Envia mensagem de texto. Body: { jid, text, imageUrl? }
app.post("/api/whatsapp/sessions/:id/send", async (req, res) => {
  try {
    const { jid, text, imageUrl } = req.body || {};
    if (!jid) return res.status(400).json({ error: "jid obrigatório" });
    if (!text && !imageUrl) return res.status(400).json({ error: "text ou imageUrl obrigatório" });
    if (imageUrl) {
      await wa.sendImage(req.params.id, jid, imageUrl, text);
    } else {
      await wa.sendText(req.params.id, jid, text);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("[whatsapp] send:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Envia a mesma mensagem para vários grupos. Body: { jids: [...], text, imageUrl?, intervalMs? }
// Disparado em sequência com delay entre cada envio para reduzir risco de bloqueio.
app.post("/api/whatsapp/sessions/:id/broadcast", async (req, res) => {
  try {
    const { jids = [], text, imageUrl, intervalMs = 4000 } = req.body || {};
    if (!Array.isArray(jids) || jids.length === 0) return res.status(400).json({ error: "jids obrigatório (array)" });
    if (!text && !imageUrl) return res.status(400).json({ error: "text ou imageUrl obrigatório" });

    const results = [];
    for (let i = 0; i < jids.length; i++) {
      const jid = jids[i];
      try {
        if (imageUrl) {
          await wa.sendImage(req.params.id, jid, imageUrl, text);
        } else {
          await wa.sendText(req.params.id, jid, text);
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
  console.log(`  POST /api/whatsapp/sessions/:id   (inicia sessão)`);
  console.log(`  GET  /api/whatsapp/sessions/:id   (status + QR)`);
  console.log(`  POST /api/whatsapp/sessions/:id/groups`);
  console.log(`  POST /api/whatsapp/sessions/:id/broadcast`);

  // Restaura sessões persistidas
  wa.restoreSessions();
});
