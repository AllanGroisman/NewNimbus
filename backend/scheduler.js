const crypto = require("crypto");
const { normalizeSource, upgradeAmazonImageUrl } = require("./scraper");
const wa = require("./whatsapp");
const storage = require("./storage");
const catalog = require("./catalog");
const affiliate = require("./affiliate");

// Cadência do loop principal (em ms). Roda janelas de envio.
const TICK_MS = 30 * 1000;

// Refill do catálogo: faz quando a queue tem menos que isso
const REFILL_THRESHOLD = 5;

function todayKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function hhmm(d = new Date()) {
  return d.toTimeString().slice(0, 5);
}

function minutesSince(iso) {
  if (!iso || iso === "—") return Infinity;
  const t = new Date(iso).getTime();
  if (isNaN(t)) return Infinity;
  return (Date.now() - t) / 60000;
}

function inWindow(now, w) {
  return hhmm(now) >= w.from && hhmm(now) < w.to;
}

function activeWindow(now, schedule) {
  if (!schedule || !Array.isArray(schedule.windows)) return null;
  return schedule.windows.find(w => inWindow(now, w)) || null;
}

function cooldownMinutes(schedule) {
  if (!schedule) return 0;
  const v = Number(schedule.cooldownValue) || 0;
  const u = String(schedule.cooldownUnit || "horas").toLowerCase();
  if (u.startsWith("min")) return v;
  if (u.startsWith("hor")) return v * 60;
  return v * 60 * 24; // dias (default)
}

// Mesma chave do catalog.js — duplicada aqui pra evitar circular import
function productKey(p) {
  const link = p.link || "";
  const decoded = (() => { try { return decodeURIComponent(link); } catch { return link; } })();
  const m = decoded.match(/\/p\/MLB(\d+)/i)
        || decoded.match(/\/MLB-?(\d{6,})-/i)
        || decoded.match(/produto\.mercadolivre\.com\.br\/MLB-?(\d{6,})/i);
  if (m) return crypto.createHash("md5").update("MLB" + m[1]).digest("hex");
  if (link) {
    try {
      const u = new URL(link);
      return crypto.createHash("md5").update(u.origin + u.pathname).digest("hex");
    } catch {}
  }
  const nm = (p.name || "").toLowerCase().replace(/\s+/g, " ").trim();
  return crypto.createHash("md5").update(`${nm}|${p.store || ""}`).digest("hex");
}

function renderTemplate(template, p) {
  const fmt = v => v != null ? `R$ ${Number(v).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}` : "—";
  return String(template || "")
    .replace(/\{produto\}/g, p.name || "")
    .replace(/\{preco\}/g, fmt(p.price))
    .replace(/\{preco_antigo\}/g, fmt(p.originalPrice))
    .replace(/\{desconto\}/g, p.discount ? `${p.discount}%` : "—")
    .replace(/\{loja\}/g, p.store || "")
    .replace(/\{link\}/g, p.link || "");
}

function resolveSources(sources) {
  const ids = (Array.isArray(sources) ? sources : [])
    .map(normalizeSource)
    .filter(Boolean);
  return ids.length ? [...new Set(ids)] : ["ml"];
}

// Grupo está pausado quando depende do ML mas o afiliado não está configurado.
function groupPausedByAffiliate(group) {
  const sources = resolveSources(group.scraping?.sources);
  if (!sources.includes("ml")) return false;
  return !affiliate.status().configured;
}

// Auto-aprovação: produtos vão direto pra queue. Se false, vão pra pending pra
// o usuário aprovar antes de enviar. Default = true (mantém comportamento legado).
function isAutoApprove(group) {
  const v = group.scraping?.auto;
  return v === undefined ? true : !!v;
}

// Faz refill da fila/pending CONSULTANDO O CATÁLOGO (não scrape).
// Aplica filtros da campanha e exclui keys já no queue/pending/history (cooldown).
// Retorna { cleanedQueue, cleanedPending, newItems, target, removedFromQueue }.
// `target` = "queue" ou "pending" (pra onde os newItems vão).
function refillQueue(group) {
  const cats = Array.isArray(group.categories) && group.categories.length
    ? group.categories
    : (group.category ? [group.category] : []);
  const filters = (group.scraping && group.scraping.filters) || {};
  const sources = resolveSources(group.scraping?.sources);
  const cdMin = cooldownMinutes(group.schedule);
  const target = isAutoApprove(group) ? "queue" : "pending";

  // Recalcula keys do history pra detectar duplicatas
  const historyKeys = (group.history || []).map(h => ({ k: productKey(h), sentAt: h.sentAt }));
  const sentRecentlyKeys = new Set(
    historyKeys.filter(h => minutesSince(h.sentAt) < cdMin).map(h => h.k)
  );
  const histKeySet = new Set(historyKeys.map(h => h.k));

  // Limpa duplicatas + já-enviados de dentro da queue
  const queueSeen = new Set();
  const cleanedQueue = (group.queue || []).filter(q => {
    const k = productKey(q);
    if (histKeySet.has(k)) return false;
    if (queueSeen.has(k)) return false;
    queueSeen.add(k);
    return true;
  });
  const removedFromQueue = (group.queue || []).length - cleanedQueue.length;
  if (removedFromQueue > 0) {
    console.log(`[scheduler] "${group.name}": removidas ${removedFromQueue} duplicatas/já-enviados da fila`);
  }

  // Mesma limpeza pra pending (descarta já-enviados e duplicatas)
  const pendingSeen = new Set();
  const cleanedPending = (group.pending || []).filter(p => {
    const k = productKey(p);
    if (histKeySet.has(k)) return false;
    if (queueSeen.has(k)) return false;
    if (pendingSeen.has(k)) return false;
    pendingSeen.add(k);
    return true;
  });

  // Exclui da query: tudo que está no queue + pending + cooldown
  const excludeKeys = new Set([...queueSeen, ...pendingSeen, ...sentRecentlyKeys, ...histKeySet]);

  const candidates = catalog.query({
    categories: cats.length ? cats : null,
    sources,
    excludeKeys,
    filters,
    limit: 100,
  });

  const newItems = candidates.map(p => ({
    id: p.key,    // a UI de pending busca por `id`
    key: p.key,
    name: p.name,
    link: p.link,
    img: p.img,
    price: p.price,
    originalPrice: p.originalPrice,
    discount: p.discount,
    store: p.store,
    category: typeof p.category === "string" ? p.category : (p.category?.id || null),
    rating: p.rating ?? null,
    reviewsCount: p.reviewsCount ?? null,
    sold: p.sold ?? null,
    freeShipping: p.freeShipping ?? false,
    seller: p.seller ?? null,
    addedAt: new Date().toISOString(),
  }));

  if (newItems.length || removedFromQueue > 0) {
    console.log(`[scheduler] "${group.name}": +${newItems.length} → ${target} (cats=${cats.join(",") || "todas"}, sources=${sources.join(",")})`);
  }

  return { cleanedQueue, cleanedPending, newItems, target, removedFromQueue };
}

// Atualiza métricas após um envio
function bumpMetrics(group, ok) {
  if (!ok) return {};
  const now = new Date();
  const dayIdx = (now.getDay() + 6) % 7;
  const last = group.history && group.history[0];
  const lastDay = last ? new Date(last.sentAt).toDateString() : null;
  const today = now.toDateString();
  const sentToday = lastDay === today ? (group.sentToday || 0) + 1 : 1;
  const weekData = Array.isArray(group.weekData) && group.weekData.length === 7
    ? [...group.weekData]
    : [0, 0, 0, 0, 0, 0, 0];
  weekData[dayIdx] = (weekData[dayIdx] || 0) + 1;
  const sentWeek = weekData.reduce((a, b) => a + b, 0);
  return {
    sentToday,
    sentWeek,
    weekData,
    lastSend: now.toISOString(),
  };
}

// Faz o envio de UM item para todos os grupos vinculados
async function sendItem(userId, group, whatsappGroups, item) {
  const linkedIds = group.whatsappGroupIds || [];
  if (!linkedIds.length) {
    throw new Error("Nenhum grupo de WhatsApp vinculado.");
  }
  const linked = whatsappGroups.filter(w => linkedIds.includes(w.id));
  if (!linked.length) {
    throw new Error("Grupos vinculados não encontrados.");
  }

  let itemForSend = item;
  if (item.store === "Mercado Livre" && item.link) {
    const aff = await affiliate.gerarLinkAfiliadoML(item.link);
    if (aff) {
      itemForSend = { ...item, link: aff };
    } else if (affiliate.status().ml.configured) {
      console.warn(`[scheduler] afiliado ML falhou pra "${item.name?.slice(0, 40)}" — enviando com link original`);
    }
  } else if (item.store === "Amazon" && item.link) {
    const aff = affiliate.gerarLinkAfiliadoAmazon(item.link);
    if (aff) {
      itemForSend = { ...item, link: aff };
    } else if (affiliate.status().amazon.configured) {
      console.warn(`[scheduler] afiliado Amazon falhou pra "${item.name?.slice(0, 40)}" — enviando com link original`);
    }
  }
  // Defesa: itens já no catálogo/fila podem ter URL de thumb da Amazon — sobe pra
  // resolução nativa antes de mandar pro WhatsApp pra a prévia ficar enquadrada.
  if (itemForSend.img) {
    const upgraded = upgradeAmazonImageUrl(itemForSend.img);
    if (upgraded !== itemForSend.img) itemForSend = { ...itemForSend, img: upgraded };
  }

  const text = renderTemplate(group.messageTemplate, itemForSend);

  const byNumber = new Map();
  for (const w of linked) {
    const jid = w.jid || w.id;
    if (!jid || !w.numberId) {
      console.warn(`[scheduler] grupo "${w.name}" sem jid ou numberId — pulando`);
      continue;
    }
    if (!byNumber.has(w.numberId)) byNumber.set(w.numberId, []);
    byNumber.get(w.numberId).push({ ...w, jid });
  }

  let sentCount = 0;
  const errors = [];
  for (const [numberId, ws] of byNumber.entries()) {
    for (const w of ws) {
      try {
        if (item.img) {
          await wa.sendImage(userId, numberId, w.jid, item.img, text);
        } else {
          await wa.sendText(userId, numberId, w.jid, text);
        }
        sentCount++;
        console.log(`[scheduler] enviado "${item.name?.slice(0, 40)}..." → ${w.name} (${w.jid})`);
        await new Promise(r => setTimeout(r, 4000));
      } catch (err) {
        console.error(`[scheduler] falha enviando p/ ${w.name} (${w.jid}): ${err.message}`);
        errors.push(`${w.name}: ${err.message}`);
      }
    }
  }

  if (sentCount === 0) {
    throw new Error(errors.length ? `Nenhum envio teve sucesso. ${errors[0]}` : "Nenhum envio teve sucesso.");
  }

  const newQueue = (group.queue || []).filter(q => q.key !== item.key);
  const history = [{
    key: item.key,
    name: item.name,
    link: item.link,
    img: item.img || null,
    store: item.store || null,
    price: item.price,
    originalPrice: item.originalPrice ?? null,
    discount: item.discount,
    sentAt: new Date().toISOString(),
    groupCount: sentCount,
  }, ...(group.history || [])].slice(0, 200);

  const metrics = bumpMetrics({ ...group, history }, true);
  return { ...metrics, queue: newQueue, history, sentCount };
}

// Verifica janela/intervalo e despacha o próximo item
async function dispatchOne(userId, group, whatsappGroups, numbers) {
  const queue = group.queue || [];
  if (!queue.length) return null;

  const now = new Date();
  const win = activeWindow(now, group.schedule);
  if (!win) return null;

  const interval = Number(win.interval) || 30;
  const since = minutesSince(group.lastSend);
  if (since < interval) return null;

  if (!(group.whatsappGroupIds || []).length) return null;

  try {
    return await sendItem(userId, group, whatsappGroups, queue[0]);
  } catch (err) {
    console.error(`[scheduler] dispatchOne "${group.name}":`, err.message);
    return null;
  }
}

// API pública para "Enviar agora": dispara o próximo item ignorando janela e intervalo.
async function sendNextNow(userId, groupId) {
  const state = storage.loadState(userId);
  const group = (state.groups || []).find(g => g.id === groupId);
  if (!group) throw new Error("Campanha não encontrada");
  if (group.paused) {
    throw new Error("Campanha pausada: retome a campanha pra enviar.");
  }
  if (groupPausedByAffiliate(group)) {
    throw new Error("Campanha pausada: configure o afiliado do Mercado Livre (tag + cookie) em Configurações.");
  }

  // Tenta refill se queue está vazia — "enviar agora" é ação manual do user,
  // então força os itens pra queue mesmo se a campanha está em modo de revisão.
  let queue = group.queue || [];
  if (!queue.length) {
    const { cleanedQueue, newItems } = refillQueue(group);
    const refilled = [...cleanedQueue, ...newItems];
    if (refilled.length) {
      await storage.updateGroupOps(userId, groupId, { queue: refilled });
      queue = refilled;
      group.queue = refilled;
    }
  }

  if (!queue.length) throw new Error("Fila vazia — sem produtos no catálogo que passem nos filtros desta campanha. Peça pro admin atualizar o catálogo (página Scraping) ou afrouxe os filtros.");

  const result = await sendItem(userId, group, state.whatsappGroups || [], queue[0]);
  if (!result) throw new Error("Nenhum envio realizado");
  await storage.updateGroupOps(userId, groupId, {
    queue: result.queue,
    history: result.history,
    sentToday: result.sentToday,
    sentWeek: result.sentWeek,
    weekData: result.weekData,
    lastSend: result.lastSend,
  });
  return { sent: result.sentCount, lastSend: result.lastSend, queueSize: result.queue.length };
}

// Processa um grupo: refill + dispatch
async function processGroup(userId, group, whatsappGroups, numbers) {
  const updates = {};
  const now = new Date();

  if (group.paused) {
    return;
  }
  if (groupPausedByAffiliate(group)) {
    return;
  }

  // Refill se a campanha precisa de itens — leve porque consulta catálogo.
  // O "buffer" é queue + pending: se auto-aprova vai direto pra queue, senão pra
  // pending pro usuário revisar. Em ambos os casos, queremos manter ~5 itens
  // no buffer pra cobrir a janela.
  const queueLen = (group.queue || []).length;
  const pendingLen = (group.pending || []).length;
  const inWindow = !!activeWindow(now, group.schedule);
  if ((queueLen + pendingLen < REFILL_THRESHOLD) && inWindow) {
    const { cleanedQueue, cleanedPending, newItems, target, removedFromQueue } = refillQueue(group);
    if (newItems.length || removedFromQueue > 0 || cleanedPending.length !== (group.pending || []).length) {
      if (target === "queue") {
        updates.queue = [...cleanedQueue, ...newItems];
        if (cleanedPending.length !== (group.pending || []).length) updates.pending = cleanedPending;
      } else {
        updates.pending = [...cleanedPending, ...newItems];
        if (removedFromQueue > 0) updates.queue = cleanedQueue;
      }
    }
  }

  // Dispatch (só consome de queue — pending precisa de aprovação manual)
  const groupForDispatch = updates.queue ? { ...group, queue: updates.queue } : group;
  const res = await dispatchOne(userId, groupForDispatch, whatsappGroups, numbers);
  if (res) Object.assign(updates, res);

  if (Object.keys(updates).length) {
    await storage.updateGroupOps(userId, group.id, updates);
  }
}

let _running = false;
async function tick() {
  if (_running) return;
  _running = true;
  try {
    const userIds = storage.listAllUserIds();
    for (const userId of userIds) {
      const state = storage.loadState(userId);
      const groups = state.groups || [];
      const whatsappGroups = state.whatsappGroups || [];
      const numbers = state.numbers || [];
      for (const g of groups) {
        try {
          await processGroup(userId, g, whatsappGroups, numbers);
        } catch (err) {
          console.error(`[scheduler] erro em ${userId}/${g.id}:`, err.message);
        }
      }
    }
  } catch (err) {
    console.error("[scheduler] tick:", err.message);
  } finally {
    _running = false;
  }
}

let _interval = null;
function start() {
  if (_interval) return;
  console.log(`[scheduler] iniciando (tick ${TICK_MS / 1000}s)`);
  _interval = setInterval(tick, TICK_MS);
  setTimeout(tick, 5000);
}

function stop() {
  if (_interval) clearInterval(_interval);
  _interval = null;
}

// API pública pro botão "Buscar agora do catálogo" — força refill imediato.
// Aceita overrides opcionais (filters/sources/categories) pra usar valores
// que ainda não foram persistidos (UI mudou, mas debounce de save ainda não rodou).
async function refillNow(userId, groupId, overrides = {}) {
  const state = storage.loadState(userId);
  const group = (state.groups || []).find(g => g.id === groupId);
  if (!group) throw new Error("Campanha não encontrada");

  const merged = { ...group };
  if (overrides && (overrides.filters || overrides.sources || overrides.categories)) {
    merged.scraping = {
      ...(group.scraping || {}),
      ...(overrides.sources !== undefined ? { sources: overrides.sources } : {}),
      ...(overrides.filters !== undefined ? { filters: overrides.filters } : {}),
    };
    if (Array.isArray(overrides.categories)) merged.categories = overrides.categories;
  }

  const { cleanedQueue, cleanedPending, newItems, target, removedFromQueue } = refillQueue(merged);
  const updates = {};
  if (target === "queue") {
    updates.queue = [...cleanedQueue, ...newItems];
    if (cleanedPending.length !== (group.pending || []).length) updates.pending = cleanedPending;
  } else {
    updates.pending = [...cleanedPending, ...newItems];
    if (cleanedQueue.length !== (group.queue || []).length) updates.queue = cleanedQueue;
  }
  await storage.updateGroupOps(userId, groupId, updates);
  return {
    target,
    queueSize: (updates.queue || group.queue || []).length,
    pendingSize: (updates.pending || group.pending || []).length,
    added: newItems.length,
    removed: removedFromQueue,
  };
}

// Adiciona um produto manualmente (URL + dados editados pelo usuário) à fila ou
// pending da campanha. Verifica duplicata e cooldown — em cooldown, devolve
// `{ inCooldown: true, lastSentAt }` pra UI confirmar antes (a menos que `force`).
async function manualAdd(userId, groupId, payload = {}) {
  const { url, overrides = {}, force = false } = payload;
  const state = storage.loadState(userId);
  const group = (state.groups || []).find(g => g.id === groupId);
  if (!group) throw new Error("Campanha não encontrada");

  const cleanUrl = String(url || overrides.link || "").trim();
  const cleanName = String(overrides.name || "").trim();
  if (!cleanUrl) throw new Error("Informe o link do produto.");
  if (!cleanName) throw new Error("Informe o nome do produto.");

  const item = {
    name: cleanName,
    link: cleanUrl,
    img: overrides.img ? String(overrides.img).trim() : null,
    price: overrides.price != null && overrides.price !== "" ? Number(overrides.price) : null,
    originalPrice: overrides.originalPrice != null && overrides.originalPrice !== "" ? Number(overrides.originalPrice) : null,
    discount: overrides.discount != null && overrides.discount !== "" ? Number(overrides.discount) : null,
    store: overrides.store ? String(overrides.store).trim() : null,
    category: overrides.category || (Array.isArray(group.categories) ? group.categories[0] : null) || null,
    rating: null,
    reviewsCount: null,
    sold: null,
    freeShipping: false,
    seller: null,
    addedAt: new Date().toISOString(),
    manual: true,
  };
  // Sanitiza NaN
  for (const k of ["price", "originalPrice", "discount"]) {
    if (item[k] != null && (typeof item[k] !== "number" || isNaN(item[k]))) item[k] = null;
  }

  const key = productKey(item);
  item.id = key;
  item.key = key;

  // Duplicata na fila ou pending — sempre bloqueia (não tem por que adicionar de novo)
  const inQueue = (group.queue || []).some(q => (q.key || productKey(q)) === key);
  if (inQueue) {
    const err = new Error("Este produto já está na fila desta campanha.");
    err.code = "duplicate_queue";
    throw err;
  }
  const inPending = (group.pending || []).some(p => (p.key || productKey(p)) === key);
  if (inPending) {
    const err = new Error("Este produto já está aguardando revisão nesta campanha.");
    err.code = "duplicate_pending";
    throw err;
  }

  // Cooldown: produto enviado dentro do limite da campanha. UI confirma.
  const cdMin = cooldownMinutes(group.schedule);
  if (cdMin > 0) {
    const recent = (group.history || [])
      .map(h => ({ k: h.key || productKey(h), sentAt: h.sentAt, name: h.name }))
      .find(h => h.k === key && minutesSince(h.sentAt) < cdMin);
    if (recent && !force) {
      return {
        inCooldown: true,
        lastSentAt: recent.sentAt,
        cooldownMinutes: cdMin,
        cooldownLabel: `${group.schedule?.cooldownValue || ""} ${group.schedule?.cooldownUnit || ""}`.trim(),
      };
    }
  }

  const target = isAutoApprove(group) ? "queue" : "pending";
  const newList = [...(group[target] || []), item];
  await storage.updateGroupOps(userId, groupId, { [target]: newList });

  return {
    ok: true,
    target,
    item,
    queueSize: target === "queue" ? newList.length : (group.queue || []).length,
    pendingSize: target === "pending" ? newList.length : (group.pending || []).length,
  };
}

module.exports = { start, stop, tick, sendNextNow, refillNow, manualAdd };
