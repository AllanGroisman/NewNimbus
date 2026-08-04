const { normalizeSource, upgradeImageUrl } = require("./scraping/scraper");
const wa = require("./whatsapp");
const storage = require("./storage");
const catalog = require("./catalog");
const affiliate = require("./scraping/affiliate");
const queueMod = require("./infra/queue");
const { productKey } = require("./catalog/product-key");
const metrics = require("./infra/metrics");
const log = require("./infra/logger").child({ module: "scheduler" });
const billing = require("./billing");
const storeLocks = require("./scraping/store-locks");
const auth = require("./auth");
const userNotifier = require("./notifications/user-notifier");

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

// Número grande compacto: 1234 -> "1,2 mil", 1500000 -> "1,5 mi".
function formatCompact(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return null;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1).replace(".", ",").replace(",0", "")} mi`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1).replace(".", ",").replace(",0", "")} mil`;
  return String(v);
}

// "vendidos" pro template. Shopee usa soldCount (número); ML usa sold (string).
// Sem dado → "" (campo opcional, não polui a mensagem com "—").
function formatVendas(p) {
  if (p?.soldCount != null && Number(p.soldCount) > 0) return `${formatCompact(p.soldCount)} vendidos`;
  if (p?.sold) { const s = String(p.sold).trim(); return /vendid/i.test(s) ? s : `${s} vendidos`; }
  return "";
}

function renderTemplate(template, p) {
  const fmt = v => v != null ? `R$ ${Number(v).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}` : "—";
  return String(template || "")
    .replace(/\{produto\}/g, p.name || "")
    .replace(/\{preco\}/g, fmt(p.price))
    .replace(/\{preco_antigo\}/g, fmt(p.originalPrice))
    .replace(/\{desconto\}/g, p.discount ? `${p.discount}%` : "—")
    .replace(/\{loja\}/g, p.store || "")
    .replace(/\{vendas\}/g, formatVendas(p))
    .replace(/\{link\}/g, p.link || "");
}

function resolveSources(sources) {
  const ids = (Array.isArray(sources) ? sources : [])
    .map(normalizeSource)
    .filter(Boolean);
  return ids.length ? [...new Set(ids)] : ["ml"];
}

// Fontes que a campanha pode REALMENTE usar agora: tira as lojas trancadas pelo
// admin. A campanha segue rodando com as lojas restantes; se todas estiverem
// trancadas, devolve [] e o affiliateGate pausa com a mensagem do admin.
function activeSources(sources) {
  const locked = new Set(storeLocks.lockedStoreIds());
  return resolveSources(sources).filter(id => !locked.has(id));
}

// Extrai cats/srcs/filters do grupo em formato canônico (Sets) pro itemMatchesCampaign.
function campaignFilterCtx(group) {
  const catList = Array.isArray(group.categories) && group.categories.length
    ? group.categories
    : (group.category ? [group.category] : []);
  const cats = catList.length ? new Set(catList) : null;
  // Set vazio (todas as lojas trancadas) é intencional: nenhum item casa, então
  // a fila é limpa em vez de virar "sem filtro de loja".
  const srcs = new Set(activeSources(group.scraping?.sources));
  const filters = (group.scraping && group.scraping.filters) || {};
  return { cats, srcs, filters };
}

// True se o item ainda passa nos filtros atuais da campanha (sources, categorias,
// minDiscount, etc). Items adicionados manualmente (manual: true) sempre passam
// — usuário escolheu adicionar, então não removemos por mudança de config.
function itemMatchesCampaign(item, ctx) {
  if (!item) return false;
  if (item.manual) return true;
  const { cats, srcs, filters } = ctx;
  if (cats) {
    const pcat = typeof item.category === "string" ? item.category : (item.category?.id || null);
    if (!pcat || !cats.has(pcat)) return false;
  }
  if (srcs) {
    const sid = catalog.storeToId ? catalog.storeToId(item.store) : null;
    if (!sid || !srcs.has(sid)) return false;
  }
  const { minDiscount = 0, minPrice = 0, maxPrice, minRating = 0, keywords = "" } = filters || {};
  if (minDiscount > 0 && (!item.discount || item.discount < minDiscount)) return false;
  if (minPrice > 0 && (item.price == null || item.price < minPrice)) return false;
  if (maxPrice != null && Number.isFinite(maxPrice) && maxPrice > 0 && (item.price == null || item.price > maxPrice)) return false;
  if (minRating > 0 && (item.rating || 0) < minRating) return false;
  if (keywords && String(keywords).trim()) {
    const terms = String(keywords).toLowerCase().split(",").map(t => t.trim()).filter(Boolean);
    if (terms.length && !terms.some(t => (item.name || "").toLowerCase().includes(t))) return false;
  }
  return true;
}

// Grupo está pausado quando depende de uma loja com gating (ML ou Shopee) e o
// afiliado dela não está configurado. Amazon não pausa — cai pro link cru.
// Retorna { paused, reason } pra o caller poder mostrar mensagem específica.
function affiliateGate(userId, group) {
  const sources = activeSources(group.scraping?.sources);
  // Todas as lojas da campanha estão trancadas pelo admin — pausa com a mensagem
  // configurada no painel, pra o usuário entender que não é erro dele.
  if (!sources.length) {
    const first = resolveSources(group.scraping?.sources)[0];
    return { paused: true, reason: storeLocks.lockMessage(first) || "as lojas desta campanha estão indisponíveis" };
  }
  const s = affiliate.status(userId);
  if (sources.includes("ml") && !s.ml.configured) {
    return { paused: true, reason: "configure o afiliado do Mercado Livre (tag + cookie) em Configurações" };
  }
  if (sources.includes("shopee") && !s.shopee.configured) {
    return { paused: true, reason: "configure o afiliado da Shopee (App ID + senha) em Configurações" };
  }
  return { paused: false, reason: null };
}

// Versão boolean pra callers que só querem saber se pausa.
function groupPausedByAffiliate(userId, group) {
  return affiliateGate(userId, group).paused;
}

// Remove os grupos de WhatsApp cujo número está pausado pelo plano. O número
// segue conectado (não perde o pareamento), mas não envia nada até o cliente
// ativá-lo de volta na página WhatsApp.
function excludePlanPausedNumbers(whatsappGroups, planPaused) {
  const paused = new Set((planPaused?.numbers || []).map(String));
  if (!paused.size) return whatsappGroups || [];
  return (whatsappGroups || []).filter(w => !paused.has(String(w.numberId)));
}

// Campanha "sem WhatsApp": pausa derivada (não persistida) quando NENHUM número
// vinculado está conectado. Se pelo menos um está de pé, segue enviando (o
// sendItem já pula os grupos caídos). Retoma sozinho quando reconectar.
// `empty` (nenhum grupo vinculado) não é tratado aqui — o dispatch já não envia.
// Números pausados pelo plano contam como indisponíveis, com motivo próprio.
async function whatsappGate(userId, group, whatsappGroups, planPaused) {
  const linkedIds = group.whatsappGroupIds || [];
  const linked = (whatsappGroups || []).filter(w => linkedIds.includes(w.id));
  if (!linked.length) return { paused: false, reason: null };
  const usable = excludePlanPausedNumbers(linked, planPaused);
  if (!usable.length) {
    return { paused: true, reason: "os números de WhatsApp desta campanha estão pausados pelo seu plano" };
  }
  const sessions = await wa.listSessions(userId);
  const connectedNumbers = new Set(
    (sessions || []).filter(s => s.status === "connected").map(s => s.numberId)
  );
  const anyUp = usable.some(w => connectedNumbers.has(w.numberId));
  return anyUp
    ? { paused: false, reason: null }
    : { paused: true, reason: "nenhum WhatsApp vinculado está conectado" };
}

// Auto-aprovação: produtos vão direto pra queue. Se false, vão pra pending pra
// o usuário aprovar antes de enviar. Default = true (mantém comportamento legado).
function isAutoApprove(group) {
  const v = group.scraping?.auto;
  return v === undefined ? true : !!v;
}

// Campanha de repasse: a fila é populada pelos links capturados no grupo líder,
// não pelo scraping do catálogo. Guarda usada pra pular refill/scraping.
function isRepasse(group) {
  return group?.scraping?.kind === "repasse";
}

// Tenta gerar link de afiliado pra um item conforme a loja.
// Decisão de "passa ou pula" no refill:
//   - Loja não-monetizável (sem afiliado pra ela): mantém link original (passa)
//   - Afiliado NÃO configurado pra loja: mantém link original (passa)
//   - Afiliado CONFIGURADO e converteu: usa link de afiliado (passa)
//   - Afiliado CONFIGURADO e falhou: DESCARTA (pula) — não queremos enviar link
//     sem comissão quando o usuário configurou pra ganhar
// Retorna { ok, link, reason }. link=null significa "mantém o original".
async function convertItemAffiliate(userId, item, affStatus) {
  if (!item || !item.link || typeof item.link !== "string") {
    return { ok: true, link: null };
  }
  if (item.store === "Mercado Livre") {
    if (!affStatus.ml.configured) return { ok: true, link: null };
    const aff = await affiliate.gerarLinkAfiliadoML(userId, item.link);
    if (aff) return { ok: true, link: aff };
    return { ok: false, reason: "ML conversion failed" };
  }
  if (item.store === "Amazon") {
    if (!affStatus.amazon.configured) return { ok: true, link: null };
    const aff = affiliate.gerarLinkAfiliadoAmazon(userId, item.link);
    if (aff) return { ok: true, link: aff };
    return { ok: false, reason: "Amazon affiliate (ASIN inválido?)" };
  }
  if (item.store === "Shopee") {
    if (!affStatus.shopee.configured) return { ok: true, link: null };
    const aff = await affiliate.gerarLinkAfiliadoShopee(userId, item.link);
    if (aff) return { ok: true, link: aff };
    return { ok: false, reason: "Shopee conversion failed" };
  }
  return { ok: true, link: null };
}

// Faz refill da fila/pending CONSULTANDO O CATÁLOGO (não scrape).
// Aplica filtros da campanha e exclui keys já no queue/pending/history (cooldown).
// Converte link de afiliado item-a-item: se afiliado estiver configurado pra loja
// mas a conversão falhar, o item é descartado (não vai pra queue/pending).
// Retorna { cleanedQueue, cleanedPending, newItems, target, removedFromQueue, skippedAff }.
async function refillQueue(userId, group) {
  const cats = Array.isArray(group.categories) && group.categories.length
    ? group.categories
    : (group.category ? [group.category] : []);
  const filters = (group.scraping && group.scraping.filters) || {};
  const sources = activeSources(group.scraping?.sources);
  const cdMin = cooldownMinutes(group.schedule);
  const target = isAutoApprove(group) ? "queue" : "pending";
  const filterCtx = campaignFilterCtx(group);

  // Recalcula keys do history pra detectar duplicatas
  const historyKeys = (group.history || []).map(h => ({ k: productKey(h), sentAt: h.sentAt }));
  const sentRecentlyKeys = new Set(
    historyKeys.filter(h => minutesSince(h.sentAt) < cdMin).map(h => h.k)
  );
  const histKeySet = new Set(historyKeys.map(h => h.k));

  // Limpa duplicatas, já-enviados e stale (config mudou — item não bate mais
  // com sources/categorias/filtros atuais). Items manuais nunca são considerados
  // stale, pois usuário adicionou explicitamente.
  const queueSeen = new Set();
  const cleanedQueue = (group.queue || []).filter(q => {
    const k = productKey(q);
    if (histKeySet.has(k)) return false;
    if (queueSeen.has(k)) return false;
    if (!itemMatchesCampaign(q, filterCtx)) return false;
    queueSeen.add(k);
    return true;
  });
  const removedFromQueue = (group.queue || []).length - cleanedQueue.length;
  if (removedFromQueue > 0) {
    console.log(`[scheduler] "${group.name}": removidos ${removedFromQueue} itens da fila (duplicatas/já-enviados/stale)`);
  }

  // Mesma limpeza pra pending (descarta já-enviados, duplicatas e stale)
  const pendingSeen = new Set();
  const cleanedPending = (group.pending || []).filter(p => {
    const k = productKey(p);
    if (histKeySet.has(k)) return false;
    if (queueSeen.has(k)) return false;
    if (pendingSeen.has(k)) return false;
    if (!itemMatchesCampaign(p, filterCtx)) return false;
    pendingSeen.add(k);
    return true;
  });

  // Exclui da query: tudo que está no queue + pending + cooldown
  const excludeKeys = new Set([...queueSeen, ...pendingSeen, ...sentRecentlyKeys, ...histKeySet]);

  // sources vazio = todas as lojas da campanha trancadas. Não dá pra chamar
  // catalog.query assim: lista vazia lá significa "sem filtro de loja" e traria
  // produtos de lojas que a campanha não escolheu.
  const candidates = sources.length
    ? await catalog.query({
        categories: cats.length ? cats : null,
        sources,
        excludeKeys,
        filters,
        limit: 100,
      })
    : [];

  const rawItems = candidates.map(p => ({
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
    soldCount: p.soldCount ?? null,   // Shopee guarda o nº de vendas aqui (ML usa `sold`)
    freeShipping: p.freeShipping ?? false,
    seller: p.seller ?? null,
    addedAt: new Date().toISOString(),
  }));

  // Conversão de afiliado item-a-item. Descarta produtos cuja conversão falhou
  // (quando o afiliado da loja está configurado) pra não enviar link sem comissão.
  const affStatus = affiliate.status(userId);
  const newItems = [];
  const skippedAff = { ml: 0, amazon: 0, shopee: 0, total: 0 };
  for (const item of rawItems) {
    const r = await convertItemAffiliate(userId, item, affStatus);
    if (!r.ok) {
      skippedAff.total++;
      if (item.store === "Mercado Livre") skippedAff.ml++;
      else if (item.store === "Amazon") skippedAff.amazon++;
      else if (item.store === "Shopee") skippedAff.shopee++;
      continue;
    }
    if (r.link) {
      // Link de afiliado gerado — substitui o link e marca pra sendItem não re-converter.
      newItems.push({ ...item, link: r.link, originalLink: item.link, affiliateLink: r.link });
    } else {
      // Loja sem afiliado configurado — mantém link original.
      newItems.push(item);
    }
  }

  if (newItems.length || removedFromQueue > 0 || skippedAff.total > 0) {
    const skipStr = skippedAff.total
      ? `, ${skippedAff.total} descartados por afiliado (ml=${skippedAff.ml}, amz=${skippedAff.amazon}, sho=${skippedAff.shopee})`
      : "";
    console.log(`[scheduler] "${group.name}": +${newItems.length} → ${target} (cats=${cats.join(",") || "todas"}, sources=${sources.join(",")}${skipStr})`);
  }

  return { cleanedQueue, cleanedPending, newItems, target, removedFromQueue, skippedAff: skippedAff.total };
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
  if (item.affiliateLink) {
    // Já convertido no refill — usa direto pra evitar nova chamada de API.
    itemForSend = { ...item, link: item.affiliateLink };
  } else if (item.store === "Mercado Livre" && item.link) {
    // Fallback pra itens legados ou inseridos manualmente (sem affiliateLink).
    // Mesma política de convertItemAffiliate: se o afiliado está configurado e a
    // conversão falha, NÃO manda link sem comissão — descarta (lança erro).
    const aff = await affiliate.gerarLinkAfiliadoML(userId, item.link);
    if (aff) {
      itemForSend = { ...item, link: aff };
    } else if (affiliate.status(userId).ml.configured) {
      throw new Error(`Afiliado ML falhou pra "${item.name?.slice(0, 40)}" — item descartado (sem link com comissão).`);
    }
  } else if (item.store === "Amazon" && item.link) {
    const aff = affiliate.gerarLinkAfiliadoAmazon(userId, item.link);
    if (aff) {
      itemForSend = { ...item, link: aff };
    } else if (affiliate.status(userId).amazon.configured) {
      throw new Error(`Afiliado Amazon falhou pra "${item.name?.slice(0, 40)}" — item descartado (sem link com comissão).`);
    }
  } else if (item.store === "Shopee" && item.link) {
    const aff = await affiliate.gerarLinkAfiliadoShopee(userId, item.link);
    if (aff) {
      itemForSend = { ...item, link: aff };
    } else if (affiliate.status(userId).shopee.configured) {
      throw new Error(`Afiliado Shopee falhou pra "${item.name?.slice(0, 40)}" — item descartado (sem link com comissão).`);
    }
  }
  // Defesa: itens já no catálogo/fila podem ter URL de thumb (Amazon, ML ou
  // Shopee) — sobe pra resolução nativa antes de mandar pro WhatsApp pra a
  // prévia ficar enquadrada e nítida.
  if (itemForSend.img) {
    const upgraded = upgradeImageUrl(itemForSend.img);
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
        if (itemForSend.img) {
          await wa.sendImage(userId, numberId, w.jid, itemForSend.img, text);
        } else {
          await wa.sendText(userId, numberId, w.jid, text);
        }
        sentCount++;
        log.info({ item: item.name?.slice(0, 60), waGroup: w.name, jid: w.jid, userId, numberId }, "envio ok");
        await new Promise(r => setTimeout(r, 4000));
      } catch (err) {
        log.error({ err, waGroup: w.name, jid: w.jid, userId, numberId, item: item.name?.slice(0, 60) }, "falha envio");
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
    // Grava a MESMA foto que foi pro grupo (já em resolução alta), não a thumb
    // que estava na fila — o histórico é o que a UI mostra como "o que enviei".
    img: itemForSend.img || null,
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

// Verifica janela/intervalo e despacha o próximo item.
// Em modo redis: pop + lastSend são persistidos antes de enfileirar (evita que o
// próximo tick re-enfileire o mesmo item enquanto o job não foi processado).
// O worker depois persiste history + métricas via processSendJob().
// Em modo memory: comportamento legado — sendItem inline, retorna updates.
async function dispatchOne(userId, group, whatsappGroups, numbers) {
  const queue = group.queue || [];
  if (!queue.length) return null;

  const now = new Date();
  // Envio automático (repasse): ignora janelas e intervalo — tudo que está na
  // fila é despachado (um item por tick). Sem esse flag, respeita janela+intervalo.
  const autoSend = group.scraping?.autoSend === true;
  if (!autoSend) {
    const win = activeWindow(now, group.schedule);
    if (!win) return null;

    const interval = Number(win.interval) || 30;
    const since = minutesSince(group.lastSend);
    if (since < interval) return null;
  }

  if (!(group.whatsappGroupIds || []).length) return null;

  const item = queue[0];

  if (queueMod.isRedis()) {
    const newQueue = queue.slice(1);
    const lastSend = now.toISOString();
    await storage.updateGroupOps(userId, group.id, { queue: newQueue, lastSend });
    try {
      await queueMod.enqueueSend({ userId, groupId: group.id, item });
      try { metrics.schedulerEnqueuedTotal.inc({ target: "queue" }); } catch {}
    } catch (err) {
      log.error({ err, userId, groupId: group.id, group: group.name }, "falha enfileirando");
      // Restaura o item na frente da queue pra não perder. lastSend fica setada
      // pra dar uma janela antes de tentar de novo (evita loop apertado).
      await storage.updateGroupOps(userId, group.id, { queue: [item, ...newQueue] });
    }
    return null; // updates já foram persistidos
  }

  try {
    return await sendItem(userId, group, whatsappGroups, item);
  } catch (err) {
    log.error({ err, userId, groupId: group.id, group: group.name }, "dispatchOne falhou");
    return null;
  }
}

// Handler do worker (BullMQ em modo redis; chamado inline em memory).
// Recebe o item já popado da queue pelo producer, faz o envio e persiste
// history + métricas. NÃO sobrescreve queue nem lastSend (já foram setadas).
async function processSendJob(job) {
  const { userId, groupId, item } = job.data || {};
  if (!userId || groupId === undefined || groupId === null || !item) {
    throw new Error(`job inválido: userId/groupId/item ausentes`);
  }
  const start = process.hrtime.bigint();
  const store = (item.store || "unknown").toLowerCase().replace(/\s+/g, "");
  // Conta retries (BullMQ chama o handler com attemptsMade contendo a tentativa atual >0 quando é retry)
  if (job.attemptsMade > 0) {
    try { metrics.sendRetryTotal.inc(); } catch {}
  }
  try {
    const state = await storage.loadState(userId);
    const group = (state.groups || []).find(g => g.id === groupId);
    if (!group) throw new Error(`campanha ${groupId} não encontrada`);
    // O plano pode ter caído entre o enfileiramento e o consumo do job —
    // devolve o item pra fila em vez de enviar por uma campanha pausada.
    if (group.planPaused) {
      await storage.updateGroupOps(userId, groupId, { queue: [item, ...(group.queue || [])] });
      log.info({ userId, groupId }, "job descartado — campanha pausada pelo plano");
      return { skipped: "plan_paused" };
    }

    const result = await sendItem(
      userId, group,
      excludePlanPausedNumbers(state.whatsappGroups || [], state.planPaused),
      item,
    );
    await storage.updateGroupOps(userId, groupId, {
      history: result.history,
      sentToday: result.sentToday,
      sentWeek: result.sentWeek,
      weekData: result.weekData,
    });
    try {
      metrics.sendsTotal.inc({ status: "ok", store });
      metrics.sendDuration.observe(Number(process.hrtime.bigint() - start) / 1e9);
    } catch {}
    return { sent: result.sentCount, item: item.name?.slice(0, 60) };
  } catch (err) {
    try { metrics.sendsTotal.inc({ status: "fail", store }); } catch {}
    throw err;
  }
}

// API pública para "Enviar agora": dispara o próximo item ignorando janela e intervalo.
async function sendNextNow(userId, groupId) {
  const state = await storage.loadState(userId);
  const group = (state.groups || []).find(g => g.id === groupId);
  if (!group) throw new Error("Campanha não encontrada");
  if (group.paused) {
    throw new Error("Campanha pausada: retome a campanha pra enviar.");
  }
  if (group.planPaused) {
    throw new Error("Campanha pausada pelo seu plano: escolha ela entre as campanhas ativas ou assine um plano maior pra enviar.");
  }
  const gate = affiliateGate(userId, group);
  if (gate.paused) {
    throw new Error(`Campanha pausada: ${gate.reason}.`);
  }
  const waGate = await whatsappGate(userId, group, state.whatsappGroups || [], state.planPaused);
  if (waGate.paused) {
    throw new Error(`Campanha pausada: ${waGate.reason}.`);
  }

  // Limpa stale antes — usuário clicou "Enviar agora" esperando filtros atuais.
  const filterCtx = campaignFilterCtx(group);
  const origQueue = group.queue || [];
  const prunedQueue = origQueue.filter(q => itemMatchesCampaign(q, filterCtx));
  if (prunedQueue.length !== origQueue.length) {
    await storage.updateGroupOps(userId, groupId, { queue: prunedQueue });
    group.queue = prunedQueue;
  }

  // Tenta refill se queue está vazia — "enviar agora" é ação manual do user,
  // então força os itens pra queue mesmo se a campanha está em modo de revisão.
  let queue = group.queue || [];
  if (!queue.length && !isRepasse(group)) {
    const { cleanedQueue, newItems } = await refillQueue(userId, group);
    const refilled = [...cleanedQueue, ...newItems];
    if (refilled.length) {
      await storage.updateGroupOps(userId, groupId, { queue: refilled });
      queue = refilled;
      group.queue = refilled;
    }
  }

  if (!queue.length) {
    if (isRepasse(group)) throw new Error("Fila vazia — nenhum produto capturado do grupo líder ainda. Aprove os pendentes ou aguarde novos links no grupo líder.");
    throw new Error("Fila vazia — sem produtos no catálogo que passem nos filtros desta campanha. Peça pro admin atualizar o catálogo (página Scraping) ou afrouxe os filtros.");
  }

  const result = await sendItem(
    userId, group,
    excludePlanPausedNumbers(state.whatsappGroups || [], state.planPaused),
    queue[0],
  );
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
async function processGroup(userId, group, whatsappGroups, numbers, planPaused) {
  const updates = {};
  const now = new Date();

  if (group.paused) {
    return;
  }
  // Pausada pelo plano (cancelamento/downgrade): nada de refill nem envio.
  // O aviso de "por que parou" fica na UI, não vira notificação de campanha
  // parada — o cliente já sabe que baixou de plano.
  if (group.planPaused) {
    return;
  }
  // Parada por gate (afiliado/whatsapp) — notifica o dono com o motivo (edge-trigger).
  const affGate = affiliateGate(userId, group);
  if (affGate.paused) {
    userNotifier.onCampaignStopped(userId, group.id, group.name, affGate.reason, true).catch(() => {});
    return;
  }
  const waGate = await whatsappGate(userId, group, whatsappGroups, planPaused);
  if (waGate.paused) {
    userNotifier.onCampaignStopped(userId, group.id, group.name, waGate.reason, true).catch(() => {});
    return;
  }
  // Não está parada por gate: reseta o edge-trigger pra uma próxima parada avisar.
  userNotifier.onCampaignStopped(userId, group.id, group.name, null, false).catch(() => {});

  // Sempre limpa itens stale (config mudou — sources/categorias/filtros não
  // batem mais). Roda antes do refill+dispatch pra não enviar item que já não
  // se encaixa na campanha. Refill abaixo pode reescrever updates.queue/pending
  // com o resultado completo (stale + dup + novos), o que tá ok.
  const filterCtx = campaignFilterCtx(group);
  const origQ = group.queue || [];
  const origP = group.pending || [];
  const prunedQ = origQ.filter(q => itemMatchesCampaign(q, filterCtx));
  const prunedP = origP.filter(p => itemMatchesCampaign(p, filterCtx));
  const removedStale = (origQ.length - prunedQ.length) + (origP.length - prunedP.length);
  if (removedStale > 0) {
    console.log(`[scheduler] "${group.name}": removidos ${removedStale} itens stale (config mudou)`);
    updates.queue = prunedQ;
    updates.pending = prunedP;
    group = { ...group, queue: prunedQ, pending: prunedP };
  }

  // Refill se a campanha precisa de itens — leve porque consulta catálogo.
  // O "buffer" é queue + pending: se auto-aprova vai direto pra queue, senão pra
  // pending pro usuário revisar. Em ambos os casos, queremos manter ~5 itens
  // no buffer pra cobrir a janela.
  const queueLen = (group.queue || []).length;
  const pendingLen = (group.pending || []).length;
  const inWindow = !!activeWindow(now, group.schedule);
  // Repasse não puxa do catálogo — a fila é alimentada só pelo grupo líder.
  if (!isRepasse(group) && (queueLen + pendingLen < REFILL_THRESHOLD) && inWindow) {
    const { cleanedQueue, cleanedPending, newItems, target, removedFromQueue } = await refillQueue(userId, group);
    if (newItems.length || removedFromQueue > 0 || cleanedPending.length !== (group.pending || []).length) {
      if (target === "queue") {
        updates.queue = [...cleanedQueue, ...newItems];
        if (cleanedPending.length !== (group.pending || []).length) updates.pending = cleanedPending;
      } else {
        updates.pending = [...cleanedPending, ...newItems];
        if (removedFromQueue > 0) updates.queue = cleanedQueue;
      }
    }
    // Notifica o resultado da busca automática (novos produtos aprovados/pendentes).
    if (newItems.length) {
      userNotifier.onProductSearch(userId, group.name, {
        added: newItems.length,
        approved: target === "queue" ? newItems.length : 0,
        pending: target === "pending" ? newItems.length : 0,
      }).catch(() => {});
    }
  }

  // Fila vazia dentro de uma janela de envio (edge-trigger). Usa a queue já
  // considerando o refill acima.
  const effQueueLen = (updates.queue !== undefined ? updates.queue : (group.queue || [])).length;
  userNotifier.onQueueEmpty(userId, group.id, group.name, inWindow && effQueueLen === 0).catch(() => {});

  // Dispatch (só consome de queue — pending precisa de aprovação manual)
  const groupForDispatch = updates.queue ? { ...group, queue: updates.queue } : group;
  const res = await dispatchOne(
    userId, groupForDispatch,
    excludePlanPausedNumbers(whatsappGroups, planPaused),
    numbers,
  );
  if (res) Object.assign(updates, res);

  if (Object.keys(updates).length) {
    await storage.updateGroupOps(userId, group.id, updates);
  }
}

let _running = false;
let _lastTickAt = null;
let _lastTickError = null;
async function tick() {
  if (_running) return;
  _running = true;
  const start = process.hrtime.bigint();
  let tickStatus = "ok";
  try {
    const userIds = await storage.listAllUserIds();
    for (const userId of userIds) {
      // Plan-gating — pula usuário sem assinatura ativa (free/canceled/past_due).
      // Admin sempre passa. Sessões WA não são derrubadas; só envios pausam.
      try {
        const user = await auth.findById(userId);
        const sub = await billing.getByUserId(userId);
        if (!billing.isActive(sub, user?.role)) {
          continue;
        }
      } catch (err) {
        log.warn({ err: err.message, userId }, "billing check falhou — pulando user");
        continue;
      }

      const state = await storage.loadState(userId);
      const groups = state.groups || [];
      const whatsappGroups = state.whatsappGroups || [];
      const numbers = state.numbers || [];
      for (const g of groups) {
        try {
          await processGroup(userId, g, whatsappGroups, numbers, state.planPaused);
        } catch (err) {
          log.error({ err, userId, groupId: g.id }, "processGroup erro");
        }
      }
    }
  } catch (err) {
    _lastTickError = err.message;
    tickStatus = "error";
    log.error({ err }, "tick falhou");
  } finally {
    _lastTickAt = new Date().toISOString();
    _running = false;
    const dur = Number(process.hrtime.bigint() - start) / 1e9;
    try {
      metrics.schedulerTicksTotal.inc({ status: tickStatus });
      metrics.schedulerTickDuration.observe(dur);
    } catch {}
  }
}

function status() {
  const lastMs = _lastTickAt ? Date.now() - new Date(_lastTickAt).getTime() : null;
  return {
    running: !!_interval,
    lastTickAt: _lastTickAt,
    lastTickError: _lastTickError,
    msSinceLastTick: lastMs,
    tickIntervalMs: TICK_MS,
    // saudável se ticou nos últimos 2 intervalos
    healthy: lastMs != null && lastMs < TICK_MS * 2,
  };
}

let _interval = null;
function start() {
  if (_interval) return;
  console.log(`[scheduler] iniciando (tick ${TICK_MS / 1000}s, queue=${queueMod.backendName()})`);
  // Em redis mode, o WORKER (backend/worker.js) registra processSendJob via
  // queue.setSendHandler. O server não precisa registrar nada — só enfileira.
  // Em memory mode, dispatchOne chama sendItem inline (handler não é usado).
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
  const state = await storage.loadState(userId);
  const group = (state.groups || []).find(g => g.id === groupId);
  if (!group) throw new Error("Campanha não encontrada");
  if (isRepasse(group)) throw new Error("Campanha de repasse não busca no catálogo — a fila é alimentada pelos links do grupo líder.");

  const merged = { ...group };
  if (overrides && (overrides.filters || overrides.sources || overrides.categories)) {
    merged.scraping = {
      ...(group.scraping || {}),
      ...(overrides.sources !== undefined ? { sources: overrides.sources } : {}),
      ...(overrides.filters !== undefined ? { filters: overrides.filters } : {}),
    };
    if (Array.isArray(overrides.categories)) merged.categories = overrides.categories;
  }

  const { cleanedQueue, cleanedPending, newItems, target, removedFromQueue, skippedAff } = await refillQueue(userId, merged);
  const updates = {};
  if (target === "queue") {
    updates.queue = [...cleanedQueue, ...newItems];
    if (cleanedPending.length !== (group.pending || []).length) updates.pending = cleanedPending;
  } else {
    updates.pending = [...cleanedPending, ...newItems];
    if (cleanedQueue.length !== (group.queue || []).length) updates.queue = cleanedQueue;
  }
  await storage.updateGroupOps(userId, groupId, updates);
  // Notifica o dono sobre a busca manual (botão "Buscar agora").
  if (newItems.length) {
    userNotifier.onProductSearch(userId, group.name, {
      added: newItems.length,
      approved: target === "queue" ? newItems.length : 0,
      pending: target === "pending" ? newItems.length : 0,
    }).catch(() => {});
  }
  return {
    target,
    queueSize: (updates.queue || group.queue || []).length,
    pendingSize: (updates.pending || group.pending || []).length,
    added: newItems.length,
    removed: removedFromQueue,
    skippedAffiliate: skippedAff || 0,
  };
}

// Adiciona um produto manualmente (URL + dados editados pelo usuário) à fila ou
// pending da campanha. Verifica duplicata e cooldown — em cooldown, devolve
// `{ inCooldown: true, lastSentAt }` pra UI confirmar antes (a menos que `force`).
async function manualAdd(userId, groupId, payload = {}) {
  const { url, overrides = {}, force = false } = payload;
  const state = await storage.loadState(userId);
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
    rating: overrides.rating != null && overrides.rating !== "" ? Number(overrides.rating) : null,
    reviewsCount: overrides.reviewsCount != null && overrides.reviewsCount !== "" ? String(overrides.reviewsCount) : null,
    // Texto vindo do "buscar dados" do link ("+1.000 vendidos"); a Shopee manda a
    // contagem exata em soldCount, que o formatVendas prefere quando existe.
    sold: overrides.sold ? String(overrides.sold).trim() : null,
    soldCount: overrides.soldCount != null && overrides.soldCount !== "" ? Number(overrides.soldCount) : null,
    freeShipping: false,
    seller: null,
    manual: true,
  };

  return addItemToGroup(userId, group, item, { force });
}

// Núcleo compartilhado por manualAdd e pela captura de repasse: recebe um item já
// montado (name/link/store/...), calcula a key, checa duplicata + cooldown e insere
// na fila ou pending conforme aprovação automática. Não faz scraping nem validação
// de URL — quem chama já preparou o item.
//   - Duplicata na fila/pending: lança erro com code duplicate_queue/duplicate_pending.
//   - Cooldown e !force: retorna { inCooldown: true, ... } (sem inserir).
//   - Sucesso: retorna { ok: true, target, item, queueSize, pendingSize }.
async function addItemToGroup(userId, group, item, { force = false } = {}) {
  const groupId = group.id;
  item = { ...item };
  if (!item.addedAt) item.addedAt = new Date().toISOString();
  if (item.manual === undefined) item.manual = true;
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

module.exports = {
  start, stop, tick, sendNextNow, refillNow, manualAdd, addItemToGroup,
  isRepasse, isAutoApprove, resolveSources, activeSources, status, processSendJob,
  // Funções puras exportadas só pra teste unitário (tests/unit/scheduler-core.test.js).
  inWindow, activeWindow, cooldownMinutes, renderTemplate, itemMatchesCampaign, campaignFilterCtx,
};
