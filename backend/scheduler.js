const crypto = require("crypto");
const { scrapeOfertas, applyFilters, normalizeSource } = require("./scraper");
const wa = require("./whatsapp");
const storage = require("./storage");

// Cadência do loop principal (em ms). Roda funcionalidades baseadas em
// horário: scraping nos horários configurados, envio dentro das janelas.
const TICK_MS = 30 * 1000;

// Cache de scraping COMPARTILHADO (todos os usuários) por categoria
// para não martelarmos o ML toda hora. TTL: 10 minutos.
const SCRAPE_TTL_MS = 10 * 60 * 1000;
const scrapeCache = new Map(); // category -> { data, ts }

// Trava por categoria pra não disparar duas scrapes paralelas pra mesma cat
const scrapeInflight = new Map(); // category -> Promise

// Marcas pra não disparar scrape duas vezes no mesmo minuto/categoria
const scrapeFiredMin = new Map(); // `${userId}::${groupId}::${HH:MM}` -> dateKey

function todayKey(d = new Date()) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function hhmm(d = new Date()) {
  return d.toTimeString().slice(0, 5); // HH:MM (local)
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

// Chave estável de produto. NÃO usa o link cru porque o Mercado Livre injeta
// tracking_id/deal_print_id/wid/position/sid diferentes a cada scrape — isso
// fazia o MESMO produto ganhar hashes diferentes, furando o cooldown.
// Estratégia: extrair o ID canônico do produto que aparece no caminho da URL.
function productKey(p) {
  const link = p.link || "";
  // Decodifica %2F etc pra capturar /p/MLB... que vem urlencoded em links de tracking
  const decoded = (() => { try { return decodeURIComponent(link); } catch { return link; } })();
  // Padrões canônicos de produto no path do ML — NÃO bater com `wid=MLB...` (query)
  const m = decoded.match(/\/p\/MLB(\d+)/i)
        || decoded.match(/\/MLB-?(\d{6,})-/i)
        || decoded.match(/produto\.mercadolivre\.com\.br\/MLB-?(\d{6,})/i);
  if (m) {
    return crypto.createHash("md5").update("MLB" + m[1]).digest("hex");
  }
  // Fallback 1: origin+pathname (sem query/fragment) já é estável o suficiente
  if (link) {
    try {
      const u = new URL(link);
      return crypto.createHash("md5").update(u.origin + u.pathname).digest("hex");
    } catch {}
  }
  // Fallback final: nome normalizado + loja
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

// Normaliza sources (aceita "Mercado Livre"/"ml"/"Amazon"/"amazon", filtra inválidos).
// Default = ML quando vazio.
function resolveSources(sources) {
  const ids = (Array.isArray(sources) ? sources : [])
    .map(normalizeSource)
    .filter(Boolean);
  return ids.length ? [...new Set(ids)] : ["ml"];
}

async function scrapeCategoryShared(category, sources) {
  const ids = resolveSources(sources);
  const key = `${category || "_all"}::${ids.sort().join(",")}`;
  const cached = scrapeCache.get(key);
  if (cached && Date.now() - cached.ts < SCRAPE_TTL_MS) return cached.data;

  if (scrapeInflight.has(key)) return scrapeInflight.get(key);

  const p = (async () => {
    try {
      console.log(`[scheduler] scrape ${key}...`);
      const data = await scrapeOfertas({ category: category || null, sources: ids, limit: 200 });
      scrapeCache.set(key, { data, ts: Date.now() });
      return data;
    } catch (err) {
      console.error(`[scheduler] erro scrape ${key}:`, err.message);
      return [];
    } finally {
      scrapeInflight.delete(key);
    }
  })();
  scrapeInflight.set(key, p);
  return p;
}

// Faz scraping pra campanha, aplica filtros, deduplica vs queue/cooldown e
// devolve a queue limpa + novos itens.
//
// Importante: usa productKey(item) recalculado em vez do `item.key` armazenado
// — keys antigos (de antes do fix de tracking_id) ficam compatíveis na hora.
async function refillQueue(group) {
  const cats = Array.isArray(group.categories) && group.categories.length
    ? group.categories
    : (group.category ? [group.category] : [null]);
  const filters = (group.scraping && group.scraping.filters) || {};
  const sources = (group.scraping && group.scraping.sources) || ["Mercado Livre"];
  const cdMin = cooldownMinutes(group.schedule);

  // Recalcula keys de history pra detectar duplicatas mesmo com tracking_id velho
  const historyKeys = (group.history || []).map(h => ({ k: productKey(h), sentAt: h.sentAt }));
  const sentRecentlyKeys = new Set(
    historyKeys.filter(h => minutesSince(h.sentAt) < cdMin).map(h => h.k)
  );

  // Limpa duplicatas dentro da queue + remove items que estão no history (qualquer tempo)
  // — produtos já enviados não voltam. Após cooldown, eles podem voltar via novo scrape.
  const histKeySet = new Set(historyKeys.map(h => h.k));
  const queueSeen = new Set();
  const cleanedQueue = (group.queue || []).filter(q => {
    const k = productKey(q);
    if (histKeySet.has(k)) return false;     // já enviado → fora
    if (queueSeen.has(k)) return false;      // duplicata interna → fora
    queueSeen.add(k);
    return true;
  });
  const removedFromQueue = (group.queue || []).length - cleanedQueue.length;
  if (removedFromQueue > 0) {
    console.log(`[scheduler] "${group.name}": removidas ${removedFromQueue} duplicatas/já-enviados da fila`);
  }

  const newItems = [];
  const inQueueOrNew = new Set([...queueSeen]);
  for (const cat of cats) {
    const all = await scrapeCategoryShared(cat, sources);
    const filtered = applyFilters(all, filters);
    let added = 0, skippedQueue = 0, skippedCd = 0;
    for (const p of filtered) {
      const k = productKey(p);
      if (inQueueOrNew.has(k)) { skippedQueue++; continue; }
      if (sentRecentlyKeys.has(k)) { skippedCd++; continue; }
      inQueueOrNew.add(k);
      added++;
      newItems.push({
        key: k,
        name: p.name,
        link: p.link,
        img: p.img,
        price: p.price,
        originalPrice: p.originalPrice,
        discount: p.discount,
        store: p.store,
        category: cat,
        addedAt: new Date().toISOString(),
      });
    }
    console.log(`[scheduler] "${group.name}" / ${cat || "geral"}: scrape=${all.length}, pós-filtros=${filtered.length}, +${added} novos (já na fila: ${skippedQueue}, em cooldown ${cdMin / 60 / 24}d: ${skippedCd})`);
  }
  return { cleanedQueue, newItems, removedFromQueue };
}

// Atualiza métricas após um envio
function bumpMetrics(group, ok) {
  if (!ok) return {};
  const now = new Date();
  const dayIdx = (now.getDay() + 6) % 7; // segunda=0
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

// Faz o envio de UM item para todos os grupos vinculados — sem checar janela/intervalo.
// Devolve o patch a aplicar no estado (queue/history/lastSend/...) ou null se nada saiu.
async function sendItem(userId, group, whatsappGroups, item) {
  const linkedIds = group.whatsappGroupIds || [];
  if (!linkedIds.length) {
    throw new Error("Nenhum grupo de WhatsApp vinculado.");
  }
  const linked = whatsappGroups.filter(w => linkedIds.includes(w.id));
  if (!linked.length) {
    throw new Error("Grupos vinculados não encontrados.");
  }

  const text = renderTemplate(group.messageTemplate, item);

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

  // Remove o item da queue (procura pela key) e adiciona ao history
  const newQueue = (group.queue || []).filter(q => q.key !== item.key);
  const history = [{
    key: item.key,
    name: item.name,
    link: item.link,
    price: item.price,
    discount: item.discount,
    sentAt: new Date().toISOString(),
    groupCount: sentCount,
  }, ...(group.history || [])].slice(0, 200);

  const metrics = bumpMetrics({ ...group, history }, true);
  return { ...metrics, queue: newQueue, history, sentCount };
}

// Verifica janela/intervalo e despacha o próximo item — usado pelo loop automático
async function dispatchOne(userId, group, whatsappGroups, numbers) {
  const queue = group.queue || [];
  if (!queue.length) return null;

  const now = new Date();
  const win = activeWindow(now, group.schedule);
  if (!win) {
    console.log(`[scheduler] "${group.name}": fora de janela (agora ${hhmm(now)}, janelas: ${(group.schedule?.windows || []).map(w => w.from + "-" + w.to).join(", ")})`);
    return null;
  }

  const interval = Number(win.interval) || 30;
  const since = minutesSince(group.lastSend);
  if (since < interval) {
    console.log(`[scheduler] "${group.name}": último envio há ${since.toFixed(1)}min, intervalo ${interval}min — aguardando`);
    return null;
  }

  if (!(group.whatsappGroupIds || []).length) {
    console.log(`[scheduler] "${group.name}": ${queue.length} item(s) na fila mas nenhum grupo de WhatsApp vinculado`);
    return null;
  }

  try {
    return await sendItem(userId, group, whatsappGroups, queue[0]);
  } catch (err) {
    console.error(`[scheduler] dispatchOne "${group.name}":`, err.message);
    return null;
  }
}

// API pública para o botão "Enviar agora": dispara o próximo item ignorando janela e intervalo,
// mas atualiza lastSend → o próximo automático conta a partir desse envio.
async function sendNextNow(userId, groupId) {
  const state = storage.loadState(userId);
  const group = (state.groups || []).find(g => g.id === groupId);
  if (!group) throw new Error("Campanha não encontrada");
  const queue = group.queue || [];
  if (!queue.length) throw new Error("Fila vazia");

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

// Processa um grupo: refill + dispatch. Persiste ops via storage.
async function processGroup(userId, group, whatsappGroups, numbers) {
  const updates = {};
  const now = new Date();

  // Scrape se houver horário configurado batendo agora
  const auto = group.scraping?.auto;
  const times = group.scraping?.times || [];
  const dKey = todayKey(now);
  const cur = hhmm(now);

  let shouldRefill = false;
  if (auto && times.includes(cur)) {
    const fireKey = `${userId}::${group.id}::${cur}`;
    if (scrapeFiredMin.get(fireKey) !== dKey) {
      scrapeFiredMin.set(fireKey, dKey);
      shouldRefill = true;
    }
  }
  // Se a fila está vazia E estamos numa janela de envio, faz refill oportunista
  if (!shouldRefill && (group.queue || []).length === 0 && activeWindow(now, group.schedule)) {
    shouldRefill = true;
  }

  if (shouldRefill) {
    const { cleanedQueue, newItems, removedFromQueue } = await refillQueue(group);
    if (newItems.length || removedFromQueue > 0) {
      updates.queue = [...cleanedQueue, ...newItems];
      if (newItems.length) {
        console.log(`[scheduler] +${newItems.length} itens na fila de "${group.name}" (user ${userId})`);
      }
    }
  }

  // Dispatch
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
  // primeiro tick logo no boot, com delay pra deixar Baileys subir
  setTimeout(tick, 5000);
}

function stop() {
  if (_interval) clearInterval(_interval);
  _interval = null;
}

module.exports = { start, stop, tick, sendNextNow };
