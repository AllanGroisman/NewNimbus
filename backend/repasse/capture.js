// Captura de links do grupo LÍDER de campanhas de repasse.
//
// Roda dentro do worker (é acionado pelo listener messages.upsert em
// whatsapp/local.js). Para cada mensagem de um grupo que seja líder de alguma
// campanha de repasse, extrai os links de produto (ML/Shopee/Amazon), enriquece
// via scrapeSingleProduct e insere na fila/pending da campanha — o envio depois
// re-afilia com a TAG do próprio usuário (scheduler.sendItem).
//
// Decisões (ver plano): só ML/Shopee/Amazon COM afiliado configurado; o resto é
// ignorado. Aprovação segue scraping.auto (isAutoApprove) da campanha.

// Requerido como objeto (não desestruturado) pra permitir spy/mocks nos testes.
const scraper = require("../scraping/scraper");
const affiliate = require("../scraping/affiliate");
const storage = require("../storage");
const userNotifier = require("../notifications/user-notifier");

// Best-effort: registra uma tentativa de captura (link, campanha) pro painel
// admin. Nunca deve quebrar o pipeline — qualquer falha é engolida.
async function logCapture(fields) {
  try {
    const { prisma } = require("../db");
    await prisma().repasseCaptureLog.create({
      data: {
        groupId: BigInt(fields.groupId),
        userId: String(fields.userId),
        waJid: fields.waJid || "",
        rawUrl: fields.rawUrl,
        resolvedUrl: fields.resolvedUrl || null,
        store: fields.store || null,
        sourceAllowed: fields.sourceAllowed ?? null,
        affiliateConfigured: fields.affiliateConfigured ?? null,
        scrapeOk: fields.scrapeOk ?? null,
        productName: fields.productName || null,
        productImg: fields.productImg || null,
        price: fields.price ?? null,
        originalPrice: fields.originalPrice ?? null,
        discount: fields.discount ?? null,
        // A coluna é Int; o produto carrega o TEXTO das vendas ("+1.000 vendidos")
        // pra mensagem preservar o "+". Converte só aqui, pro log.
        sold: fields.sold != null ? affiliate.parseSoldText(fields.sold) : null,
        outcome: fields.outcome,
        reason: fields.reason || null,
      },
    });
  } catch (err) {
    console.error(`[repasse] falha ao gravar log de captura: ${err.message}`);
  }
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// Lojas que sabemos monetizar e a chave correspondente em affiliate.status().
const STORE_STATUS_KEY = {
  "Mercado Livre": "ml",
  "Amazon": "amazon",
  "Shopee": "shopee",
};

// ────────────────────────────────────────────────────────────────────────
// Índice de campanhas líder — evita loadState a cada mensagem.
// Map key `${numberId}::${jid}` -> [{ userId, groupId }]
//
// A chave NÃO inclui o userId da sessão de propósito: o mesmo telefone pode
// ter mais de uma sessão Baileys (ex.: a do usuário + a do WhatsNimbus, quando
// o admin conecta o WhatsNimbus com o próprio número). Qualquer sessão que
// decodifique a mensagem alimenta a campanha — o dono vem do entry (userId da
// campanha), não da sessão que recebeu. Telefone é globalmente único, então
// (numberId, jid) já identifica a campanha sem ambiguidade.
// ────────────────────────────────────────────────────────────────────────

let _leaderIndex = new Map();
let _leaderIndexAt = 0;
const LEADER_INDEX_TTL_MS = 30 * 1000;

async function rebuildLeaderIndex() {
  const { prisma } = require("../db");
  const rows = await prisma().group.findMany({ select: { id: true, userId: true, scraping: true } });
  const map = new Map();
  for (const r of rows) {
    const sc = r.scraping || {};
    if (sc.kind !== "repasse") continue;
    const rp = sc.repasse || {};
    if (!rp.leaderNumberId || !rp.leaderJid) continue;
    const key = `${rp.leaderNumberId}::${rp.leaderJid}`;
    const entry = { userId: r.userId, groupId: Number(r.id) };
    if (map.has(key)) map.get(key).push(entry);
    else map.set(key, [entry]);
  }
  _leaderIndex = map;
  _leaderIndexAt = Date.now();
  console.log(`[repasse] índice de líderes reconstruído: ${map.size} grupo(s) líder → ${[...map.keys()].join(", ") || "nenhum"}`);
}

async function leadersFor(numberId, jid) {
  if (Date.now() - _leaderIndexAt > LEADER_INDEX_TTL_MS) {
    try { await rebuildLeaderIndex(); }
    catch (err) { console.error(`[repasse] falha ao reconstruir índice de líderes: ${err.message}`); }
  }
  return _leaderIndex.get(`${numberId}::${jid}`) || [];
}

// ────────────────────────────────────────────────────────────────────────
// Extração de texto/URLs
// ────────────────────────────────────────────────────────────────────────

// Desembrulha wrappers do Baileys (ephemeral / viewOnce) até o conteúdo real.
function unwrapMessage(message) {
  let m = message;
  for (let i = 0; i < 4 && m; i++) {
    if (m.ephemeralMessage) { m = m.ephemeralMessage.message; continue; }
    if (m.viewOnceMessage) { m = m.viewOnceMessage.message; continue; }
    if (m.viewOnceMessageV2) { m = m.viewOnceMessageV2.message; continue; }
    if (m.documentWithCaptionMessage) { m = m.documentWithCaptionMessage.message; continue; }
    break;
  }
  return m || null;
}

function textFromMessage(message) {
  const m = unwrapMessage(message);
  if (!m) return "";
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    ""
  );
}

const URL_RE = /https?:\/\/[^\s<>"')]+/gi;

function extractUrls(text) {
  if (!text || typeof text !== "string") return [];
  const found = text.match(URL_RE) || [];
  // Tira pontuação final grudada e deduplica preservando ordem.
  const seen = new Set();
  const out = [];
  for (let u of found) {
    u = u.replace(/[.,;)]+$/, "");
    if (!seen.has(u)) { seen.add(u); out.push(u); }
  }
  return out;
}

// Resolve redirects (amzn.to, merc.li, mlb.li, links /sec/ de afiliado alheio)
// pra chegar na URL canônica — necessário pra extractASIN/createLink funcionarem.
// Best-effort: em qualquer falha devolve a URL original.
async function resolveUrl(url) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: { "User-Agent": UA },
      signal: controller.signal,
    });
    const finalUrl = res.url || url;
    try { await res.body?.cancel?.(); } catch { /* ignore */ }
    return finalUrl;
  } catch {
    return url;
  } finally {
    clearTimeout(t);
  }
}

// ────────────────────────────────────────────────────────────────────────
// Serialização por usuário — Puppeteer é pesado, não abrir N navegadores.
// ────────────────────────────────────────────────────────────────────────

const _userChains = new Map();

function runSerial(userId, fn) {
  const prev = _userChains.get(userId) || Promise.resolve();
  const next = prev.then(fn, fn).catch(err =>
    console.error(`[repasse] erro no processamento de ${userId}: ${err.message}`));
  // Limpa a chain quando esvazia (evita reter closures).
  _userChains.set(userId, next);
  next.finally(() => { if (_userChains.get(userId) === next) _userChains.delete(userId); });
  return next;
}

// ────────────────────────────────────────────────────────────────────────
// Entrada principal
// ────────────────────────────────────────────────────────────────────────

// Dedup entre sessões: o mesmo telefone pode ter 2+ sessões Baileys (usuário +
// WhatsNimbus) e ambas entregam a mesma mensagem. Set com ordem de inserção
// funciona como LRU barato.
const _seenMsgIds = new Set();
const SEEN_MSG_MAX = 500;
function alreadySeen(msgId) {
  if (!msgId) return false; // sem id (ex.: testes) → não deduplica
  if (_seenMsgIds.has(msgId)) return true;
  _seenMsgIds.add(msgId);
  if (_seenMsgIds.size > SEEN_MSG_MAX) _seenMsgIds.delete(_seenMsgIds.values().next().value);
  return false;
}

// Chamado pelo listener messages.upsert. userId/numberId identificam a sessão
// Baileys que recebeu; messages é ev.messages. O match com a campanha usa só
// (numberId, jid) — o dono vem do índice, não da sessão (ver nota no índice).
async function onUpsert(userId, numberId, messages) {
  userId = String(userId);
  numberId = String(numberId);
  const jobs = [];
  for (const msg of messages || []) {
    try {
      const remoteJid = msg?.key?.remoteJid;
      if (!remoteJid || !remoteJid.endsWith("@g.us")) continue; // só grupos
      if (msg?.key?.fromMe) continue;                            // ignora nossas próprias msgs
      const text = textFromMessage(msg.message);
      if (!text) continue;
      const urls = extractUrls(text);
      if (!urls.length) continue;

      const leaders = await leadersFor(numberId, remoteJid);
      console.log(`[repasse] msg em ${remoteJid} (sessão ${userId}::${numberId}): ${leaders.length} campanha(s) líder | links: ${urls.join(" ")}`);
      if (!leaders.length) continue;
      if (alreadySeen(msg?.key?.id)) {
        console.log(`[repasse] msg ${msg.key.id} já processada por outra sessão → ignorada`);
        continue;
      }

      // Agrupa por dono da campanha: afiliado/estado/serialização são do dono,
      // não da sessão que recebeu a mensagem.
      const byOwner = new Map();
      for (const l of leaders) {
        if (!byOwner.has(l.userId)) byOwner.set(l.userId, []);
        byOwner.get(l.userId).push(l);
      }
      for (const [ownerId, ownLeaders] of byOwner) {
        jobs.push(runSerial(ownerId, () => processMessage(ownerId, ownLeaders, urls, remoteJid)));
      }
    } catch (err) {
      console.error(`[repasse] onUpsert erro: ${err.message}`);
    }
  }
  // Retorna promise agregada — útil pra testes aguardarem. Em produção o chamador
  // usa .catch() (fire-and-forget); runSerial já engole erros internamente.
  return Promise.allSettled(jobs);
}

async function processMessage(userId, leaders, urls, waJid) {
  const scheduler = require("../scheduler");
  const affStatus = affiliate.status(userId);

  // Resolve + valida + enriquece cada URL uma vez; reaproveita entre campanhas.
  // Guarda também as tentativas descartadas (loja não suportada / afiliado não
  // configurado) pra registrar no log de captura em cada campanha líder.
  const items = [];
  const discarded = [];
  for (const rawUrl of urls) {
    try {
      const resolved = await resolveUrl(rawUrl);
      const store = scraper.detectStore(resolved);
      const statusKey = STORE_STATUS_KEY[store];
      console.log(`[repasse] link ${rawUrl}${resolved !== rawUrl ? ` → ${resolved}` : ""} | loja=${store || "desconhecida"}`);
      if (!statusKey) {
        console.log(`[repasse] loja não suportada → ignorado`);
        discarded.push({ rawUrl, resolved, store, reason: "loja não suportada" });
        continue;
      }
      const affiliateConfigured = !!affStatus?.[statusKey]?.configured;
      if (!affiliateConfigured) {
        console.log(`[repasse] afiliado ${store} não configurado → ignorado`);
        discarded.push({ rawUrl, resolved, store, affiliateConfigured, reason: `afiliado ${store} não configurado` });
        continue;
      }

      // Raspa a URL ORIGINAL (não a resolvida): o Puppeteer segue o redirect ele
      // mesmo, com stealth + cookie de afiliado — igual ao "Adicionar link" manual.
      // A resolução via fetch cru (resolveUrl) costuma cair no muro de login/captcha
      // do ML e devolver a página errada — por isso o link ARMAZENADO (usado na
      // reafiliação no envio) prefere o finalUrl que o próprio Puppeteer navegou
      // (scraped.finalUrl), caindo pro `resolved` só quando o scrape falha.
      let scraped = null, scrapeErr = null;
      try {
        scraped = await scraper.scrapeSingleProduct(rawUrl, { userId });
      } catch (err) {
        scrapeErr = err;
        console.warn(`[repasse] scrape falhou pra ${rawUrl}: ${err.message}`);
      }

      // Bloqueio/captcha do ML: nem o Puppeteer conseguiu passar, e o `resolved`
      // (fetch cru) é sabidamente a mesma página de bloqueio — não existe link
      // confiável pra guardar, então descarta em vez de propagar um item quebrado.
      if (!scraped && scrapeErr?.blocked && store === "Mercado Livre") {
        console.log(`[repasse] bloqueio/captcha do ML → descartado`);
        discarded.push({ rawUrl, resolved, store, affiliateConfigured, reason: scrapeErr.captcha ? "captcha do ML" : "bloqueio do ML (login)" });
        continue;
      }

      console.log(`[repasse] scrape ${scraped ? "ok" : "falhou"}: ${scraped?.name || store}`);

      // Sem nome, foto e preço confiáveis, não dá pra saber se o link é de fato
      // um produto (ex.: página de busca, categoria, link caído). Descarta em
      // vez de inserir um item incompleto/inválido na campanha. Preço antigo
      // (originalPrice) NÃO é exigido: produtos sem desconto ativo (ex. preço
      // cheio na Shopee) são válidos e não devem ser descartados por isso.
      if (!scraped?.name || !scraped?.img || scraped?.price == null) {
        console.log(`[repasse] dados insuficientes (nome/foto/preço) → provavelmente não é produto, descartado`);
        discarded.push({ rawUrl, resolved, store, affiliateConfigured, reason: "dados insuficientes (não é produto)" });
        continue;
      }

      const name = scraped.name.trim();
      items.push({
        rawUrl,
        affiliateConfigured,
        scrapeOk: !!scraped,
        name,
        link: scraped?.finalUrl || resolved,
        img: scraped?.img || null,
        price: scraped?.price ?? null,
        originalPrice: scraped?.originalPrice ?? null,
        discount: scraped?.discount ?? null,
        sold: scraped?.sold ?? null,
        store,
        rating: null,
        reviewsCount: null,
        freeShipping: false,
        seller: null,
        manual: true,
        source: "repasse",
      });
    } catch (err) {
      console.error(`[repasse] erro processando ${rawUrl}: ${err.message}`);
      discarded.push({ rawUrl, reason: `erro: ${err.message}` });
    }
  }

  // Descartes globais (loja não suportada / afiliado ausente) valem pra
  // qualquer campanha líder desse grupo — registra uma linha por campanha.
  for (const { groupId } of leaders) {
    for (const d of discarded) {
      logCapture({
        groupId, userId, waJid,
        rawUrl: d.rawUrl, resolvedUrl: d.resolved, store: d.store,
        affiliateConfigured: d.affiliateConfigured ?? null,
        outcome: "discarded", reason: d.reason,
      });
    }
  }

  if (!items.length) return;

  // Insere em cada campanha líder desse grupo (normalmente só uma).
  for (const { groupId } of leaders) {
    const state = await storage.loadState(userId);
    let group = (state.groups || []).find(g => g.id === groupId);
    if (!group) continue;

    const allowedSources = scheduler.resolveSources(group.scraping?.sources);

    let approved = 0, pending = 0;
    for (const base of items) {
      const storeSourceId = scraper.normalizeSource(base.store);
      const sourceAllowed = !!storeSourceId && allowedSources.includes(storeSourceId);
      if (!sourceAllowed) {
        console.log(`[repasse] "${base.name}" (${base.store}) fonte não habilitada na campanha ${groupId} → pulado`);
        logCapture({
          groupId, userId, waJid,
          rawUrl: base.rawUrl, resolvedUrl: base.link, store: base.store,
          sourceAllowed: false, affiliateConfigured: base.affiliateConfigured, scrapeOk: base.scrapeOk,
          productName: base.name, productImg: base.img, price: base.price, originalPrice: base.originalPrice,
          discount: base.discount, sold: base.sold, outcome: "discarded", reason: "fonte não habilitada",
        });
        continue;
      }
      try {
        const item = { ...base, category: (Array.isArray(group.categories) ? group.categories[0] : null) || null };
        // force:false → produto em cooldown volta { inCooldown } e é pulado (sem UI
        // pra confirmar; não reenviar dentro do intervalo é o comportamento certo).
        const r = await scheduler.addItemToGroup(userId, group, item, { force: false });
        if (r?.ok) {
          console.log(`[repasse] "${base.name}" → ${r.target === "queue" ? "fila" : "revisão"} da campanha ${groupId}`);
          if (r.target === "queue") approved++; else pending++;
          logCapture({
            groupId, userId, waJid,
            rawUrl: base.rawUrl, resolvedUrl: base.link, store: base.store,
            sourceAllowed: true, affiliateConfigured: base.affiliateConfigured, scrapeOk: base.scrapeOk,
            productName: base.name, outcome: r.target === "queue" ? "queued" : "pending",
          });
          // Recarrega o grupo pra refletir a inserção anterior (dedup correto).
          const fresh = await storage.loadState(userId);
          group = (fresh.groups || []).find(g => g.id === groupId) || group;
        } else if (r?.inCooldown) {
          console.log(`[repasse] "${base.name}" em cooldown na campanha ${groupId} → pulado`);
          logCapture({
            groupId, userId, waJid,
            rawUrl: base.rawUrl, resolvedUrl: base.link, store: base.store,
            sourceAllowed: true, affiliateConfigured: base.affiliateConfigured, scrapeOk: base.scrapeOk,
            productName: base.name, outcome: "cooldown",
          });
        }
      } catch (err) {
        // Duplicata é esperada (mesmo produto repostado) — silencia.
        const isDup = err.code === "duplicate_queue" || err.code === "duplicate_pending";
        if (!isDup) {
          console.error(`[repasse] insert falhou em ${groupId}: ${err.message}`);
        } else {
          console.log(`[repasse] "${base.name}" já existe na campanha ${groupId} (${err.code}) → pulado`);
        }
        logCapture({
          groupId, userId, waJid,
          rawUrl: base.rawUrl, resolvedUrl: base.link, store: base.store,
          sourceAllowed: true, affiliateConfigured: base.affiliateConfigured, scrapeOk: base.scrapeOk,
          productName: base.name, productImg: base.img, price: base.price, originalPrice: base.originalPrice,
          discount: base.discount, sold: base.sold, outcome: isDup ? "duplicate" : "error", reason: isDup ? err.code : err.message,
        });
      }
    }

    const added = approved + pending;
    if (added > 0) {
      console.log(`[repasse] campanha ${groupId}: +${added} (${approved} fila / ${pending} revisão)`);
      userNotifier.onProductSearch(userId, group.name, { added, approved, pending }).catch(() => {});
    }
  }
}

module.exports = {
  onUpsert,
  // exportados p/ testes
  extractUrls,
  textFromMessage,
  unwrapMessage,
  rebuildLeaderIndex,
};
