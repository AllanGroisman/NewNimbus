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
const mlSocial = require("../scraping/ml-social");
const { canonicalAmazonUrl } = require("../scraping/amazon-url");
const storage = require("../storage");
const userNotifier = require("../notifications/user-notifier");
const { leadersOf } = require("./leaders");
const { logCapture } = require("./capture-log");
const { KIND, STAGE, classifyFromText } = require("./error-kinds");
const couponWords = require("./coupon-words");
const priceWords = require("./price-words");
const originalMessage = require("./original-message");
const wordFilter = require("./word-filter");

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
// voucher, e o que mais o admin tiver cadastrado) aparece ANTES do candidato, e o
// candidato "parece" código (tem dígito OU caixa mista OU hífen), pra não confundir
// uma palavra comum da frase com um cupom.
// Devolve o código em UPPER, sem pontuação nas pontas, dentro do tamanho configurado,
// ou null. "cupom XXXX", "cupom: XXXX", "código de desconto XXXX", "use o cupom XXXX"
// (o gatilho pode vir depois de "use o"/"com o"/"aplique o" — a regex casa a partir do
// próprio gatilho, então esses prefixos não precisam ser listados).
//
// As palavras e os tamanhos vêm de repasse/coupon-words.js (app_config, editável no
// admin). `cfg` só é passado pelo testador da tela e pelos testes; em produção lê a
// config salva — que no worker é recarregada sozinha a cada 30s.
function extractCoupon(text, cfg) {
  if (!text || typeof text !== "string") return null;
  const { re, ignore, minLen, maxLen } = couponWords.compile(cfg || couponWords.readConfig());
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text))) {
    const code = (m[1] || "").replace(/[._-]+$/, "");
    if (code.length < minLen || code.length > maxLen) continue;
    // Palavra que o admin marcou como "não é código" ("use o cupom AQUI"). Sem
    // acento e em minúsculas dos dois lados: "DESCRIÇÃO" e "descricao" são a mesma.
    if (ignore.has(couponWords.semAcento(code).toLowerCase())) continue;
    // Precisa ter dígito, hífen ou pelo menos DUAS maiúsculas — senão é só uma
    // palavra comum da frase ("cupom aqui", "código abaixo"). Uma maiúscula só não
    // basta: é a palavra em Title Case ("Cupom Exclusivo", "Cupom Shopee de R$20"),
    // e ela ia parar na mensagem do cliente como código.
    if (!/\d/.test(code) && !/-/.test(code) && (code.match(/[A-Z]/g) || []).length < 2) continue;
    return code.toUpperCase();
  }
  return null;
}

// Valor em formato brasileiro (ou quase): "1.520", "1.520,90", "1520", "99,90",
// "1520.90". Não pode estar grudado em letra/número (pedaço de código "X10") nem
// ser seguido de % ("50% OFF") ou de "x" ("10x").
const PRICE_NUM_RE = /(?<![\p{L}\p{N}.,])(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)(?![\p{N}%]|[.,]\d|\s?x(?!\p{L}))/gu;
// "12x de R$ 145", "10x R$ 99" — o valor é a parcela, não o preço.
const PARCELA_RE = /\d\s*x\s*(?:de\s*)?(?:r\$\s*)?$/i;

function parseBRL(s) {
  let t = String(s);
  if (t.includes(",")) t = t.replace(/\./g, "").replace(",", ".");
  else if (/\.\d{3}(?:\.|$)/.test(t)) t = t.replace(/\./g, "");
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Palavras (só letras, sem acento, minúsculas). O "R" de "R$" não conta: senão
// ele ocuparia uma das 2 posições olhadas antes do valor.
function palavras(s) {
  return (semAcentoLower(String(s).replace(/r\$/gi, " ")).match(/\p{L}+/gu) || []);
}
function semAcentoLower(s) {
  return couponWords.semAcento(s).toLowerCase();
}

// Todos os valores da legenda que parecem PREÇO: vêm logo depois de um gatilho
// ("Por: R$ 1.739,90", "pix 1520") e não têm palavra de "não é preço" colada —
// as 2 palavras antes ("desconto de R$ 50", "frete R$ 15") ou a 1ª depois,
// pulando "de" ("R$ 20 OFF", "R$ 20 de desconto"). Parcela ("12x de R$ 145")
// é sempre descartada. Pura → testável; `cfg` só vem do testador e dos testes.
function extractPriceCandidates(text, cfg) {
  if (!text || typeof text !== "string") return [];
  const { before, ignore, triggerWords } = priceWords.compile(cfg || priceWords.readConfig());
  // Link tem número de monte (IDs da Shopee) — sai antes de procurar valor.
  const limpo = text.replace(URL_RE, " ");
  const out = [];
  let m;
  PRICE_NUM_RE.lastIndex = 0;
  while ((m = PRICE_NUM_RE.exec(limpo))) {
    const ini = m.index;
    const fim = ini + m[0].length;
    // Contexto só da MESMA linha: a legenda é uma lista de linhas, e a palavra
    // da linha de cima não fala do valor desta.
    const linhaIni = limpo.lastIndexOf("\n", ini - 1) + 1;
    const quebra = limpo.indexOf("\n", fim);
    const antes = limpo.slice(Math.max(linhaIni, ini - 60), ini);
    const depois = limpo.slice(fim, quebra < 0 ? fim + 40 : Math.min(quebra, fim + 40));
    if (!before.test(antes)) continue;
    if (PARCELA_RE.test(antes)) continue;
    // Só as palavras DEPOIS do último gatilho-palavra ("por", "pix"…): em "50% OFF
    // por R$ 99,90" o OFF é da frase de antes, o "por" já diz que vem o preço.
    let ant = palavras(antes);
    const ultimoGatilho = ant.map(w => triggerWords.has(w)).lastIndexOf(true);
    if (ultimoGatilho >= 0) ant = ant.slice(ultimoGatilho + 1);
    if (ant.slice(-2).some(w => ignore.has(w))) continue;
    const prox = palavras(depois).filter(w => w !== "de")[0];
    if (prox && ignore.has(prox)) continue;
    const v = parseBRL(m[1]);
    if (v != null) out.push(v);
  }
  return out;
}

// O preço que o grupo líder escreveu: o MENOR dos candidatos ("De R$ 1.999 Por
// R$ 1.739 / R$ 1.520 no Pix" → 1520), ou null.
function extractPrice(text, cfg) {
  const c = extractPriceCandidates(text, cfg);
  return c.length ? Math.min(...c) : null;
}

// Decide se o preço do texto substitui o da API. Só Shopee (a API dela só sabe o
// preço de vitrine; no ML/Amazon o scrape já lê o preço da página), só quando é
// MENOR que o da API e pelo menos `minPct`% dele (abaixo disso é parcela, frete,
// valor do cupom). O preço da API vira o "De". Devolve os campos novos ou null.
function textPriceFor(item, textPrice, cfg) {
  if (!item || item.store !== "Shopee") return null;
  const api = Number(item.price);
  if (!Number.isFinite(api) || api <= 0 || !(textPrice > 0)) return null;
  const { minPct } = priceWords.compile(cfg || priceWords.readConfig());
  if (textPrice >= api || textPrice < api * minPct / 100) return null;
  const originalPrice = Math.max(api, Number(item.originalPrice) || 0);
  return {
    price: textPrice,
    originalPrice,
    discount: Math.round((1 - textPrice / originalPrice) * 100),
  };
}

// Resolve redirects (amzn.to, link.amazon, merc.li, mlb.li, links /sec/ de afiliado
// alheio) pra chegar na URL canônica — necessário pra extractASIN/createLink
// funcionarem. Best-effort: em qualquer falha devolve a URL original.
//
// A URL aqui vem de mensagem de WhatsApp, ou seja, de qualquer pessoa num grupo
// monitorado — sem login. O safeFetchFollow confere em TODO salto que o host
// resolve pra IP público, e exige domínio de loja conhecida na entrada e no
// destino final; o meio do caminho pode ser encurtador de terceiro, que é o
// normal em link de afiliado (ver urlGuard.js).
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
        jobs.push(runSerial(ownerId, () => processMessage(ownerId, ownLeaders, urls, remoteJid, coupon, text)));
      }
    } catch (err) {
      console.error(`[repasse] onUpsert erro: ${err.message}`);
    }
  }
  // Retorna promise agregada — útil pra testes aguardarem. Em produção o chamador
  // usa .catch() (fire-and-forget); runSerial já engole erros internamente.
  return Promise.allSettled(jobs);
}

// O produto que o grupo líder divulgou também entra no catálogo, pra as campanhas
// normais acharem na busca — é oferta escolhida a dedo por quem vive disso. Vai só
// o que é DO PRODUTO: `manual`, `source: "repasse"` e o cupom da legenda ficam de
// fora porque o fromRow espalha o payload no item da campanha, e ali eles mudariam
// o envio (o scheduler grava no log do repasse todo item com source "repasse").
// A categoria vem de catalog.categoryFor; a validade é a do catálogo inteiro (o
// purge diário do scraping apaga o que não foi visto no dia).
async function saveToCatalog(items) {
  const catalog = require("../catalog");
  const products = [];
  for (const it of items) {
    let category = null;
    try { category = await catalog.categoryFor({ name: it.name, link: it.link }); }
    catch (err) { console.warn(`[repasse] categoria de "${it.name}" falhou: ${err.message}`); }
    products.push({
      name: it.name, link: it.link, img: it.img,
      // Item com preço do texto (Shopee) guarda o da API em api*: é ele que vai.
      price: it.apiPrice ?? it.price,
      originalPrice: it.apiPrice != null ? it.apiOriginalPrice : it.originalPrice,
      discount: it.apiPrice != null ? it.apiDiscount : it.discount,
      sold: it.sold, soldCount: it.soldCount, rating: it.rating,
      freeShipping: it.freeShipping, store: it.store, category,
    });
  }
  const r = await catalog.upsertProducts(products);
  console.log(`[repasse] catálogo: +${r.inserted} novos, ${r.updated} atualizados (categorias: ${products.map(p => p.category || "—").join(", ")})`);
}

// Aplica a lista branca/negra da campanha (repasse/word-filter.js) e devolve só
// os itens que passaram; os barrados ficam no log como "discarded" sem errorKind
// (nada falhou — a campanha é que não quer esse produto).
//
// No modo "mensagem original" a mensagem é uma coisa só: se UM produto cai na
// lista negra, a mensagem inteira sai (senão o link dele iria cru, com o
// afiliado do outro). Na lista branca basta um produto da mensagem passar.
//
// Devolve { items, verdict }: `verdict(item)` dá os campos do log
// ({ wordFilter, wordFilterReason }) de um item aprovado — vazio quando o filtro
// não rodou (campanha sem palavras).
function filterByWords(items, group, { groupId, userId, waJid }) {
  const wf = wordFilter.wordFilterOf(group);
  if (!wordFilter.isActive(wf)) return { items, verdict: () => ({}) };
  const verdicts = items.map(it => ({ it, r: wordFilter.checkName(it.name, wf) }));
  const aprovados = new Map(verdicts.filter(v => v.r.ok)
    .map(v => [v.it, { wordFilter: "approved", wordFilterReason: v.r.reason }]));

  let rejected;
  if (originalMessage.isOriginalMode(group)) {
    const negra = verdicts.find(v => !v.r.ok && v.r.list === "block");
    const algumPassou = verdicts.some(v => v.r.ok);
    if (negra) {
      rejected = verdicts.map(v => ({ it: v.it, reason: v.it === negra.it ? v.r.reason : `mensagem descartada — outro produto dela tem ${negra.r.reason}` }));
    } else if (!algumPassou) {
      rejected = verdicts.map(v => ({ it: v.it, reason: v.r.reason }));
    } else {
      rejected = [];
    }
  } else {
    rejected = verdicts.filter(v => !v.r.ok).map(v => ({ it: v.it, reason: v.r.reason }));
  }

  for (const { it, reason } of rejected) {
    console.log(`[repasse] "${it.name}" barrado pelo filtro de palavras da campanha ${groupId}: ${reason}`);
    logCapture({
      groupId, userId, waJid,
      rawUrl: it.rawUrl, resolvedUrl: it.link, store: it.store,
      affiliateConfigured: it.affiliateConfigured, scrapeOk: it.scrapeOk,
      productName: it.name, productImg: it.img, price: it.price, originalPrice: it.originalPrice,
      discount: it.discount, sold: it.sold, coupon: it.coupon,
      outcome: "discarded", reason, stage: STAGE.WORDS,
      wordFilter: "rejected", wordFilterReason: reason,
    });
  }
  const fora = new Set(rejected.map(x => x.it));
  // O item juntado do modo original é um objeto novo ({ ...usable[0] }); ele
  // aponta pro original em `_wordOf` pra herdar o veredito do primeiro produto.
  const verdict = (item) => aprovados.get(item?._wordOf || item) || {};
  return { items: items.filter(it => !fora.has(it)), verdict };
}

// `text` é a mensagem inteira do líder — só usada pelas campanhas no modo
// "mensagem original" (ver original-message.js).
async function processMessage(userId, leaders, urls, waJid, coupon = null, text = "") {
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
  // Quantos links da mensagem são da Shopee (com ou sem scrape ok): o preço do
  // texto só vale quando há UM — com vários produtos não dá pra saber de qual é.
  let shopeeLinks = 0;
  for (const rawUrl of urls) {
    try {
      const resolved = await resolveUrl(rawUrl);
      const store = scraper.detectStore(resolved);
      const statusKey = STORE_STATUS_KEY[store];
      if (store === "Shopee") shopeeLinks++;
      console.log(`[repasse] link ${rawUrl}${resolved !== rawUrl ? ` → ${resolved}` : ""} | loja=${store || "desconhecida"}`);
      if (!statusKey) {
        console.log(`[repasse] loja não suportada → ignorado`);
        discarded.push({ rawUrl, resolved, store, reason: "loja não suportada", errorKind: KIND.LOJA_NAO_SUPORTADA, stage: STAGE.STORE });
        continue;
      }
      // Perfil/lista do afiliado (/social/<id>/lists) não é produto nenhum.
      // Barrado aqui, antes do scrape, porque o caminho normal gastaria um Chrome
      // inteiro pra descobrir isso e ainda descartaria no fim.
      if (mlSocial.isAffiliateProfileUrl(resolved) || mlSocial.isAffiliateProfileUrl(rawUrl)) {
        const reason = "o link é o perfil/lista do afiliado, não um produto";
        console.log(`[repasse] ${reason} → descartado`);
        discarded.push({ rawUrl, resolved, store, reason, errorKind: KIND.NAO_E_PRODUTO, stage: STAGE.STORE });
        continue;
      }

      const affiliateConfigured = !!affStatus?.[statusKey]?.configured;
      if (!affiliateConfigured) {
        console.log(`[repasse] afiliado ${store} não configurado → ignorado`);
        discarded.push({ rawUrl, resolved, store, affiliateConfigured, reason: `afiliado ${store} não configurado`, errorKind: KIND.AFILIADO_AUSENTE, stage: STAGE.AFFILIATE_CONFIG });
        continue;
      }

      // Regra geral: raspa a URL ORIGINAL (não a resolvida). O Puppeteer segue o
      // redirect ele mesmo, com stealth + cookie de afiliado — igual ao "Adicionar
      // link" manual. O link ARMAZENADO (usado na reafiliação no envio) prefere o
      // finalUrl que o scrape devolveu — que é o permalink do produto —, caindo pro
      // `resolved` (a landing de OUTRO afiliado) só quando o scrape falha.
      // Obs.: para a landing /social/ do ML o scrapeSingleProduct já tenta ler por
      // HTTP simples antes do navegador; ali o fetch passa e o Chrome é que apanha.
      //
      // Amazon é a exceção: quando o resolved já entregou o ASIN, vale mais raspar
      // o canônico. A URL que sai do encurtador vem com /ref= de campanha e a tag de
      // OUTRO afiliado grudados (o /ref= às vezes força uma oferta específica), e o
      // caminho até ela passa por interstitial de encurtador — o navegador não
      // precisa refazer esse trajeto se o destino já é conhecido.
      const scrapeUrl = (store === "Amazon" && canonicalAmazonUrl(resolved)) || rawUrl;
      let scraped = null, scrapeErr = null;
      try {
        scraped = await scraper.scrapeSingleProduct(scrapeUrl, { userId });
      } catch (err) {
        scrapeErr = err;
        console.warn(`[repasse] scrape falhou pra ${scrapeUrl}: ${err.message}`);
      }

      // Alimenta o aviso de bloqueio do admin com o desfecho deste scrape. Fica ANTES
      // dos descartes porque precisa ver os dois lados: a parede E o sucesso que prova
      // que ela caiu. Um scrape que ABRIU a página e não era produto conta como sucesso
      // aqui — o link é que não servia, não havia parede nenhuma.
      //
      // Um aviso por link seria spam; quem segura o gatilho (N falhas seguidas + X min
      // sem sucesso) é o block-alert. O require é preguiçoso e dentro de try/catch pelo
      // mesmo motivo do scraping/affiliate.js: quebrar o ciclo notifications → whatsapp
      // → scheduler no boot.
      try {
        require("../notifications/block-alert").repasseScrapeResult({
          store, ok: !!scraped, kind: scrapeErr?.kind, reason: scrapeErr?.message, userId,
        });
      } catch { /* aviso nunca pode derrubar o repasse */ }

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
        // O motivo fechado vem tipado do detectBlockPage; o classifyFromText só
        // cobre erro antigo/inesperado que chegue sem `kind`.
        const errorKind = scrapeErr.kind || classifyFromText(reason);
        console.log(`[repasse] ${reason} → descartado`);
        discarded.push({ rawUrl, resolved, store, affiliateConfigured, reason, errorKind, stage: STAGE.SCRAPE });
        continue;
      }

      // Scrape falhou por outro motivo (timeout, rede, erro do navegador): registra a
      // mensagem real do erro em vez de mascarar como "não é produto".
      if (!scraped) {
        const reason = `falha no scrape: ${scrapeErr?.message || "motivo desconhecido"}`;
        // Erro de fora (Puppeteer, rede, urlGuard) não traz `kind` — é o caso
        // legítimo de olhar o texto, pra separar timeout de desconhecido. Já o
        // createLink recusando o link vem tipado da origem, e o texto dele não
        // deve ser reinterpretado.
        const errorKind = scrapeErr?.kind || classifyFromText(scrapeErr?.message);
        console.log(`[repasse] ${store}: ${reason} → descartado`);
        discarded.push({ rawUrl, resolved, store, affiliateConfigured, reason, errorKind, stage: STAGE.SCRAPE });
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
        // Landing de afiliado (/social/) que não abriu a PDP é um caso PRÓPRIO, e não
        // "não é produto": ali o link é de produto, só está velho ou é de outro
        // afiliado. Misturar os dois esconderia o que precisa de ação.
        const onLanding = /\/social\//i.test(scraped.finalUrl || "");
        // Idem pro produto que a loja não está vendendo agora: a PDP abriu e trouxe
        // nome e foto, só o preço não existe na página (Amazon com o item apenas em
        // "Outras opções de compra", ou buybox escondido). Chamar isso de "não é
        // página de produto" mandava o usuário conferir um link que estava certo.
        const semOferta = scraped.priceSource === "pdp-sem-oferta";
        const reason = onLanding
          ? `landing de afiliado não abriu a página do produto (sem ${missing.join("/")})`
          : semOferta
          ? `${store} está sem oferta para este produto agora — a página abriu, mas não há preço no bloco de compra`
          : `dados insuficientes (sem ${missing.join("/")}) — provavelmente não é uma página de produto`;
        console.log(`[repasse] ${store}: ${reason} → descartado`);
        discarded.push({
          rawUrl, resolved, store, affiliateConfigured, reason,
          errorKind: onLanding ? KIND.LANDING_EXPIRADA : semOferta ? KIND.SEM_OFERTA : KIND.NAO_E_PRODUTO,
          stage: STAGE.VALIDATE,
        });
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
        // A Shopee manda a contagem exata em soldCount (o `sold` fica vazio) — sem
        // ele o {vendas} do modelo sumia em todo repasse da Shopee.
        soldCount: scraped?.soldCount ?? null,
        store,
        rating: scraped?.rating ?? null,
        reviewsCount: null,
        freeShipping: scraped?.freeShipping === true,
        seller: null,
        coupon: coupon || null,
        manual: true,
        source: "repasse",
      });
    } catch (err) {
      console.error(`[repasse] erro processando ${rawUrl}: ${err.message}`);
      discarded.push({ rawUrl, reason: `erro: ${err.message}`, errorKind: classifyFromText(err.message), stage: STAGE.STORE });
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
        coupon,
        outcome: "discarded", reason: d.reason,
        errorKind: d.errorKind, stage: d.stage,
      });
    }
  }

  if (!items.length) return;

  // Shopee: a API só sabe o preço de vitrine; o grupo líder costuma escrever o
  // preço com Pix + cupom ("R$ 1.520 no Pix"). Se ele for menor (e plausível),
  // vai no envio como "Por" e o da API vira o "De". O catálogo segue com o da
  // API (apiPrice…): o preço do texto é desta oferta, não de quem busca lá.
  if (shopeeLinks === 1) {
    let textPrice = null;
    try { textPrice = extractPrice(text); }
    catch (err) { console.warn(`[repasse] leitura do preço no texto falhou: ${err.message}`); }
    if (textPrice != null) {
      for (const it of items) {
        const novo = textPriceFor(it, textPrice);
        if (!novo) {
          if (it.store === "Shopee") console.log(`[repasse] Shopee: preço do texto R$ ${textPrice} ignorado (API R$ ${it.price})`);
          continue;
        }
        console.log(`[repasse] Shopee: preço do texto R$ ${novo.price} no lugar de R$ ${it.price}`);
        it.apiPrice = it.price;
        it.apiOriginalPrice = it.originalPrice;
        it.apiDiscount = it.discount;
        Object.assign(it, novo);
      }
    }
  }

  // Uma vez por mensagem (não por campanha), e solto: o catálogo é bônus, não
  // pode atrasar nem derrubar a captura.
  saveToCatalog(items).catch(err =>
    console.error(`[repasse] falha ao gravar no catálogo: ${err.message}`));

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

    // resolveSources (e não activeSources): a trava de loja do admin serve pra
    // impedir a BUSCA no catálogo daquela loja. No repasse o link já vem pronto
    // do grupo líder, então só vale a escolha de lojas da própria campanha.
    const allowedSources = scheduler.resolveSources(group.scraping?.sources);

    // Lista branca/negra de palavras da campanha, sobre o nome do produto. Vem
    // antes da montagem do modo original: lá a mensagem vira um item só.
    const { items: campaignItems, verdict: wordVerdict } = filterByWords(items, group, { groupId, userId, waJid });
    if (!campaignItems.length) continue;

    // Modo "mensagem original": a mensagem inteira vira UM item, com os links de
    // produto que deram certo trocados no envio. Link que não serviu (página de
    // cupom, não-produto, loja fora da campanha) NÃO derruba a mensagem: fica cru
    // no texto, como veio do líder. Os de loja fora da campanha seguem no batch
    // só pra cair no log de "fonte não habilitada" do loop abaixo.
    let batch = campaignItems;
    if (originalMessage.isOriginalMode(group)) {
      const blocked = campaignItems.filter(b => {
        const sid = scraper.normalizeSource(b.store);
        return !sid || !allowedSources.includes(sid);
      });
      const usable = campaignItems.filter(b => !blocked.includes(b));
      batch = blocked;
      if (usable.length) {
        const extra = usable.length - 1;
        batch = [{
          ...usable[0],
          _wordOf: usable[0],
          name: extra > 0 ? `${usable[0].name} (+${extra} produto${extra > 1 ? "s" : ""})` : usable[0].name,
          originalText: text,
          originalLinks: usable.map(b => ({ raw: b.rawUrl, link: b.link, store: b.store })),
        }, ...blocked];
      }
    }

    let approved = 0, pending = 0;
    for (const base of batch) {
      const storeSourceId = scraper.normalizeSource(base.store);
      const sourceAllowed = !!storeSourceId && allowedSources.includes(storeSourceId);
      if (!sourceAllowed) {
        console.log(`[repasse] "${base.name}" (${base.store}) fonte não habilitada na campanha ${groupId} → pulado`);
        logCapture({
          groupId, userId, waJid,
          rawUrl: base.rawUrl, resolvedUrl: base.link, store: base.store,
          sourceAllowed: false, affiliateConfigured: base.affiliateConfigured, scrapeOk: base.scrapeOk,
          productName: base.name, productImg: base.img, price: base.price, originalPrice: base.originalPrice,
          discount: base.discount, sold: base.sold, coupon: base.coupon,
          ...wordVerdict(base),
          // Sem errorKind de propósito: nada falhou. A campanha é que não aceita
          // essa loja — contar isso como erro sujaria a taxa de sucesso do resumo.
          outcome: "discarded", reason: "fonte não habilitada", stage: STAGE.SOURCE,
        });
        continue;
      }
      try {
        // `_wordOf` é só referência interna do filtro de palavras — não vai pra fila.
        const { _wordOf, ...semRef } = base;
        const item = { ...semRef, category: (Array.isArray(group.categories) ? group.categories[0] : null) || null };
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
            productName: base.name, productImg: base.img, price: base.price, originalPrice: base.originalPrice,
            discount: base.discount, sold: base.sold, coupon: base.coupon,
          ...wordVerdict(base),
            outcome: r.target === "queue" ? "queued" : "pending", stage: STAGE.QUEUE,
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
            productName: base.name, productImg: base.img, price: base.price, originalPrice: base.originalPrice,
            discount: base.discount, sold: base.sold, coupon: base.coupon,
          ...wordVerdict(base),
            outcome: "cooldown", stage: STAGE.QUEUE,
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
          discount: base.discount, sold: base.sold, coupon: base.coupon,
          ...wordVerdict(base),
          outcome: isDup ? "duplicate" : "error", reason: isDup ? err.code : err.message,
          stage: STAGE.QUEUE,
          // Duplicata não é erro (o produto só já estava lá); só o `error` classifica.
          errorKind: isDup ? null : classifyFromText(err.message),
        });
      }
    }

    const added = approved + pending;
    if (added > 0) {
      console.log(`[repasse] campanha ${groupId}: +${added} (${approved} fila / ${pending} revisão)`);
      userNotifier.onProductSearch(userId, group, { added, approved, pending }).catch(() => {});
    }
  }
}

module.exports = {
  onUpsert,
  // exportados p/ testes
  extractUrls,
  extractCoupon,
  extractPrice,
  extractPriceCandidates,
  textPriceFor,
  textFromMessage,
  unwrapMessage,
  rebuildLeaderIndex,
  alreadySeen,
  runSerial,
};
