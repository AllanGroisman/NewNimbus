// Captura de links dos grupos LÍDERES de campanhas de repasse.
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
const urlGuard = require("../scraping/urlGuard");
const affiliate = require("../scraping/affiliate");
const storage = require("../storage");
const userNotifier = require("../notifications/user-notifier");
const { leadersOf } = require("./leaders");

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
    // Uma campanha pode ter vários líderes — cada um vira uma chave apontando
    // pra mesma campanha.
    for (const l of leadersOf(sc)) {
      const key = `${l.numberId}::${l.jid}`;
      const entry = { userId: r.userId, groupId: Number(r.id) };
      if (map.has(key)) map.get(key).push(entry);
      else map.set(key, [entry]);
    }
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

// Extrai o CÓDIGO de cupom da legenda que veio do grupo líder ("use o cupom JBL20",
// "cupom: TECH-10"). Muitos grupos mandam o produto já com o cupom a aplicar; até aqui
// o texto era só usado pra achar URLs e descartado — o cupom se perdia. Pura → testável.
//
// Conservadora de propósito: só devolve algo quando um dos gatilhos (cupom/código/
// voucher) aparece ANTES do candidato, e o candidato "parece" código (tem dígito OU
// caixa mista OU hífen), pra não confundir uma palavra comum da frase com um cupom.
// Devolve o código em UPPER, sem pontuação nas pontas, 4..20 chars, ou null.
// "cupom XXXX", "cupom: XXXX", "código de desconto XXXX", "use o cupom XXXX" (o
// gatilho pode vir depois de "use o"/"com o"/"aplique o" — a regex casa a partir do
// próprio "cupom"/"código"/"voucher", então esses prefixos não precisam ser listados).
const COUPON_RE = /(?:cupom|c[óo]digo|voucher)\s*(?:de\s+desconto\s*)?[:\-]?\s*([A-Za-z0-9][A-Za-z0-9._-]{2,19})/gi;

function extractCoupon(text) {
  if (!text || typeof text !== "string") return null;
  COUPON_RE.lastIndex = 0;
  let m;
  while ((m = COUPON_RE.exec(text))) {
    const code = (m[1] || "").replace(/[._-]+$/, "");
    if (code.length < 4 || code.length > 20) continue;
    // Precisa ter dígito, hífen ou pelo menos uma maiúscula — senão é só uma palavra
    // comum da frase ("cupom aqui", "código abaixo"), não um código de fato.
    if (!/\d/.test(code) && !/-/.test(code) && !/[A-Z]/.test(code)) continue;
    return code.toUpperCase();
  }
  return null;
}

// Resolve redirects (amzn.to, merc.li, mlb.li, links /sec/ de afiliado alheio)
// pra chegar na URL canônica — necessário pra extractASIN/createLink funcionarem.
// Best-effort: em qualquer falha devolve a URL original.
// A URL aqui vem de mensagem de WhatsApp, ou seja, de qualquer pessoa num grupo
// monitorado — sem login. safeFetchFollow valida a cada salto do redirect que o
// destino é domínio de loja conhecida e resolve pra IP público (ver urlGuard.js).
async function resolveUrl(url) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 8000);
  try {
    const { res, finalUrl } = await urlGuard.safeFetchFollow(url, {
      headers: { "User-Agent": UA },
      signal: controller.signal,
    });
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
      // Cupom escrito na legenda (ex.: "use o cupom JBL20"). Extraído aqui, antes de o
      // texto ser descartado, pra seguir junto do produto e sair no {cupom} do envio.
      const coupon = extractCoupon(text);

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
        jobs.push(runSerial(ownerId, () => processMessage(ownerId, ownLeaders, urls, remoteJid, coupon)));
      }
    } catch (err) {
      console.error(`[repasse] onUpsert erro: ${err.message}`);
    }
  }
  // Retorna promise agregada — útil pra testes aguardarem. Em produção o chamador
  // usa .catch() (fire-and-forget); runSerial já engole erros internamente.
  return Promise.allSettled(jobs);
}

async function processMessage(userId, leaders, urls, waJid, coupon = null) {
  const scheduler = require("../scheduler");

  // Gating de plano. A captura é acionada pelo listener do Baileys, fora de
  // qualquer rota HTTP — sem esta checagem, uma conta cancelada seguia rodando
  // o scraper em todo link que aparecesse nos grupos líderes, indefinidamente.
  // (O envio já era barrado pelo scheduler; o que vazava era o custo.)
  // Lazy-require: auth/billing puxam prisma, e este módulo só carrega no worker.
  try {
    const auth = require("../auth");
    const billing = require("../billing");
    const user = await auth.findById(userId);
    const sub = await billing.getByUserId(userId);
    if (!billing.isActive(sub, user?.role)) {
      console.log(`[repasse] captura ignorada — assinatura inativa (user ${userId})`);
      return;
    }
  } catch (err) {
    console.error(`[repasse] checagem de assinatura falhou (user ${userId}): ${err.message}`);
    return;
  }

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

      // Bloqueio anti-bot (login wall / CAPTCHA / interstitial) em qualquer loja: nem
      // o Puppeteer passou, e o `resolved` (fetch cru) é sabidamente a mesma página de
      // bloqueio — não há link confiável pra guardar, então descarta. Registra a razão
      // EXATA que o detectBlockPage montou (ex.: "Mercado Livre pediu verificação
      // (CAPTCHA) — tente daqui a alguns minutos ou revise o cookie de afiliado"),
      // não um "captcha do ML" genérico nem o enganoso "dados insuficientes".
      if (!scraped && scrapeErr?.blocked) {
        // detectBlockPage põe a razão detalhada em err.message (new Error(block.reason)).
        const reason = scrapeErr.message
          || (scrapeErr.captcha ? `${store}: verificação anti-bot (CAPTCHA)` : `${store}: bloqueio anti-bot (login)`);
        console.log(`[repasse] ${reason} → descartado`);
        discarded.push({ rawUrl, resolved, store, affiliateConfigured, reason });
        continue;
      }

      // Scrape falhou por outro motivo (timeout, rede, erro do navegador): registra a
      // mensagem real do erro em vez de mascarar como "não é produto".
      if (!scraped) {
        const reason = `falha no scrape: ${scrapeErr?.message || "motivo desconhecido"}`;
        console.log(`[repasse] ${store}: ${reason} → descartado`);
        discarded.push({ rawUrl, resolved, store, affiliateConfigured, reason });
        continue;
      }

      console.log(`[repasse] scrape ok: ${scraped.name || store}`);

      // Scrape voltou, mas sem nome, foto e preço confiáveis não dá pra saber se o link
      // é mesmo um produto (página de busca, categoria, link caído). Diz QUAL campo
      // faltou. Preço antigo (originalPrice) NÃO é exigido: produto sem desconto ativo
      // (ex.: preço cheio na Shopee) é válido e não deve ser descartado por isso.
      if (!scraped.name || !scraped.img || scraped.price == null) {
        const missing = [];
        if (!scraped.name) missing.push("nome");
        if (!scraped.img) missing.push("foto");
        if (scraped.price == null) missing.push("preço");
        const reason = `dados insuficientes (sem ${missing.join("/")}) — provavelmente não é uma página de produto`;
        console.log(`[repasse] ${store}: ${reason} → descartado`);
        discarded.push({ rawUrl, resolved, store, affiliateConfigured, reason });
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
        coupon: coupon || null,
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
    // Campanha pausada pelo plano (downgrade/cancelamento) não recebe item —
    // ela não envia mesmo, e enfileirar aqui só engordaria a fila em silêncio.
    if (group.planPaused) {
      console.log(`[repasse] campanha ${groupId} pausada pelo plano → captura ignorada`);
      continue;
    }

    // activeSources (e não resolveSources): loja trancada pelo admin não repassa.
    const allowedSources = scheduler.activeSources(group.scraping?.sources);

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
  extractCoupon,
  textFromMessage,
  unwrapMessage,
  rebuildLeaderIndex,
  alreadySeen,
  runSerial,
};
