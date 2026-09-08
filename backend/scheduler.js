const { normalizeSource, upgradeImageUrl } = require("./scraping/scraper");
const wa = require("./whatsapp");
const storage = require("./storage");
const catalog = require("./catalog");
const coupons = require("./coupons");
const affiliate = require("./scraping/affiliate");
const queueMod = require("./infra/queue");
const { productKey } = require("./catalog/product-key");
const metrics = require("./infra/metrics");
const log = require("./infra/logger").child({ module: "scheduler" });
const billing = require("./billing");
const storeLocks = require("./scraping/store-locks");
const auth = require("./auth");
const userNotifier = require("./notifications/user-notifier");
const captureLog = require("./repasse/capture-log");
const { KIND, STAGE } = require("./repasse/error-kinds");

// Respiro entre um envio e o próximo pro WhatsApp não tratar a sequência como
// disparo em massa. Em teste o WhatsApp é mockado, então a pausa não protege
// nada e só faz a suíte esperar — eram 4 s por envio.
const SEND_GAP_MS = process.env.NODE_ENV === "test" ? 0 : 4000;

// Cadência do loop principal (em ms). Roda janelas de envio.
const TICK_MS = 30 * 1000;

// Refill do catálogo: faz quando a queue tem menos que isso (default do modo
// "quando a fila estiver acabando" — a campanha pode escolher outro número).
const REFILL_THRESHOLD = 5;
const MAX_REFILL_THRESHOLD = 50;
const MAX_REFILL_TIMES = 12;
// Modo "horários fixos": um horário só dispara se passou há no máximo isso.
// Sem essa janela, subir o processo às 23h refaria todos os horários do dia.
const REFILL_TIME_GRACE_MIN = 15;

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

// Campanha sem NENHUMA janela de envio fica parada — é assim que o usuário
// pausa (a campanha nova nasce sem janela). O envio instantâneo ignora as
// janelas de propósito, então com ele ligado a campanha continua rodando.
function windowGate(group) {
  const windows = group?.schedule?.windows;
  if (Array.isArray(windows) && windows.length) return { ok: true, reason: null };
  if (group?.scraping?.autoSend === true) return { ok: true, reason: null };
  return { ok: false, reason: "nenhuma janela de envio configurada" };
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
  const cupom = (p.coupon || "").toString().trim();
  let t = String(template || "");
  // Sem cupom: apaga a linha inteira que contém {cupom} (nada de "🎟️ Cupom:" vazio).
  // Com cupom: substitui normalmente logo abaixo.
  if (!cupom) t = t.replace(/^[^\n]*\{cupom\}[^\n]*\n?/gm, "");
  // Sem promoção (originalPrice e discount nulos): apaga as linhas inteiras de
  // {preco_antigo} e {desconto} — mesmo comportamento do {cupom} acima.
  const hasPromo = p.originalPrice != null || p.discount != null;
  if (!hasPromo) {
    t = t.replace(/^[^\n]*\{preco_antigo\}[^\n]*\n?/gm, "");
    t = t.replace(/^[^\n]*\{desconto\}[^\n]*\n?/gm, "");
  }
  // O que o cupom TIRA — a regra ("15% OFF") e o quanto ela vale neste preço.
  // Somem por linha inteira como o {cupom}, e não viram "—" como o {preco}: uma
  // linha "🏷️ Desconto do cupom: —" é pior que linha nenhuma. Quem calcula é o
  // sendItem; sem cupom válido os dois chegam nulos.
  if (!p.couponLabel) t = t.replace(/^[^\n]*\{desconto_cupom\}[^\n]*\n?/gm, "");
  if (p.couponSaving == null) t = t.replace(/^[^\n]*\{economia_cupom\}[^\n]*\n?/gm, "");
  return t
    .replace(/\{produto\}/g, p.name || "")
    .replace(/\{preco\}/g, fmt(p.price))
    // {preco_com_cupom} NÃO apaga linha nenhuma: quando o cupom não vale (ou nem
    // existe), ele vira exatamente o {preco}. Quem calcula é o sendItem, que lê o
    // cupom no banco na hora do envio; aqui só chega o número pronto (ou null).
    .replace(/\{preco_com_cupom\}/g, fmt(p.priceWithCoupon != null ? p.priceWithCoupon : p.price))
    .replace(/\{preco_antigo\}/g, fmt(p.originalPrice))
    .replace(/\{desconto\}/g, p.discount ? `${p.discount}%` : "—")
    .replace(/\{loja\}/g, p.store || "")
    .replace(/\{vendas\}/g, formatVendas(p))
    .replace(/\{cupom\}/g, cupom)
    .replace(/\{desconto_cupom\}/g, p.couponLabel || "")
    .replace(/\{economia_cupom\}/g, fmt(p.couponSaving))
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

// Lojas que ESTA campanha pode usar. A trava do admin existe pra impedir que o
// sistema BUSQUE naquela loja — no repasse o link já vem pronto do grupo líder,
// então ela não se aplica: repasse respeita só a escolha de lojas do usuário.
function sourcesForCampaign(group) {
  const sources = group?.scraping?.sources;
  return isRepasse(group) ? resolveSources(sources) : activeSources(sources);
}

// Ordem e tamanho do lote da busca de produtos, escolhidos pelo usuário na aba
// "Busca de Produtos" e guardados no jsonb `scraping` da campanha.
const SORT_MODES = new Set(["discount_desc", "price_asc", "price_desc", "rating_desc", "lastSeen_desc"]);
const DEFAULT_BATCH = 20;
const MAX_BATCH = 50;

function sortMode(scraping) {
  const s = scraping && scraping.sortBy;
  return SORT_MODES.has(s) ? s : "discount_desc";
}

function batchSize(scraping) {
  const n = Number(scraping && scraping.batchSize);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_BATCH;
  return Math.min(MAX_BATCH, Math.max(1, Math.round(n)));
}

// Quando o preenchimento automático dispara:
//   "threshold" (default) — quando a fila está acabando, dentro da janela de envio;
//   "schedule"            — nos horários escolhidos pelo usuário, com janela ou não.
function refillMode(scraping) {
  return scraping && scraping.refillMode === "schedule" ? "schedule" : "threshold";
}

// Quantos itens no buffer (fila + pendentes) disparam o preenchimento.
function refillThreshold(scraping) {
  const n = Number(scraping && scraping.refillThreshold);
  if (!Number.isFinite(n) || n <= 0) return REFILL_THRESHOLD;
  return Math.min(MAX_REFILL_THRESHOLD, Math.max(1, Math.round(n)));
}

// Horários "HH:MM" do modo agendado, sem repetidos e em ordem.
function refillTimes(scraping) {
  const raw = Array.isArray(scraping && scraping.refillTimes) ? scraping.refillTimes : [];
  const seen = new Set();
  for (const t of raw) {
    const s = String(t || "").trim();
    if (/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) seen.add(s);
  }
  return [...seen].sort().slice(0, MAX_REFILL_TIMES);
}

// Último preenchimento automático por campanha. Fica em memória de propósito:
// é só um "já rodei este horário", e a janela de graça acima faz o restart do
// processo perder no máximo um disparo em vez de repetir o dia inteiro.
const _lastAutoRefill = new Map();

function minutesOf(hm) {
  const [h, m] = String(hm).split(":");
  return Number(h) * 60 + Number(m);
}

// Decide se o preenchimento automático roda agora.
// Retorna { go, slot } — `slot` é o horário que disparou (modo agendado).
function autoRefillDue(group, now, inWindowNow) {
  const scraping = group.scraping || {};
  if (refillMode(scraping) !== "schedule") {
    const buffer = (group.queue || []).length + (group.pending || []).length;
    return { go: inWindowNow && buffer < refillThreshold(scraping), slot: null };
  }
  const times = refillTimes(scraping);
  if (!times.length) return { go: false, slot: null };
  const nowMin = minutesOf(hhmm(now));
  // O horário mais recente que já passou hoje e ainda está dentro da graça.
  let slot = null;
  for (const t of times) {
    const tMin = minutesOf(t);
    if (tMin <= nowMin && nowMin - tMin <= REFILL_TIME_GRACE_MIN) slot = t;
  }
  if (!slot) return { go: false, slot: null };
  // Dia local (todayKey é UTC e viraria o dia às 21h no horário de Brasília).
  const day = now.toDateString();
  const done = _lastAutoRefill.get(group.id);
  if (done === `${day} ${slot}`) return { go: false, slot };
  return { go: true, slot };
}

// Registra que o horário já rodou hoje (nada a fazer no modo por fila).
function markAutoRefill(groupId, now, slot) {
  if (slot) _lastAutoRefill.set(groupId, `${now.toDateString()} ${slot}`);
}

// Grupo está pausado quando depende de uma loja com gating (ML ou Shopee) e o
// afiliado dela não está configurado. Amazon não pausa — cai pro link cru.
// Retorna { paused, reason } pra o caller poder mostrar mensagem específica.
function affiliateGate(userId, group) {
  const sources = sourcesForCampaign(group);
  // Todas as lojas da campanha estão trancadas pelo admin — pausa com a mensagem
  // configurada no painel, pra o usuário entender que não é erro dele. No repasse
  // isso nunca acontece: sourcesForCampaign ignora as travas ali.
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

// Grupos de WhatsApp que este usuário pode usar pra enviar. Duas exclusões:
//
//   1. Número pausado pelo plano — segue conectado (não perde o pareamento),
//      mas não envia nada até o cliente ativá-lo de volta na página WhatsApp.
//   2. Número que não está em `state.numbers` — whitelist, não blacklist. A
//      pausa por plano só consegue marcar números que existem no estado
//      (enforce.js descarta id desconhecido), então um número apagado do
//      estado com a sessão ainda de pé viraria um número "impausável" e
//      furaria o limite do plano. Sem cadastro no estado, não envia.
function usableWhatsappGroups(whatsappGroups, planPaused, numbers) {
  const paused = new Set((planPaused?.numbers || []).map(String));
  const known = new Set((numbers || []).map(n => String(n.id)));
  return (whatsappGroups || []).filter(w => {
    const id = String(w.numberId);
    return known.has(id) && !paused.has(id);
  });
}

// Campanha "sem WhatsApp": pausa derivada (não persistida) quando NENHUM número
// vinculado está conectado. Se pelo menos um está de pé, segue enviando (o
// sendItem já pula os grupos caídos). Retoma sozinho quando reconectar.
// `empty` (nenhum grupo vinculado) não é tratado aqui — o dispatch já não envia.
// Números pausados pelo plano contam como indisponíveis, com motivo próprio.
async function whatsappGate(userId, group, whatsappGroups, planPaused, numbers) {
  const linkedIds = group.whatsappGroupIds || [];
  const linked = (whatsappGroups || []).filter(w => linkedIds.includes(w.id));
  if (!linked.length) return { paused: false, reason: null };
  const usable = usableWhatsappGroups(linked, planPaused, numbers);
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
// o usuário aprovar antes de enviar.
// Campanha de catálogo não tem mais essa etapa: o preenchimento automático faz
// exatamente o que o botão "Preencher fila agora" faz, e o resultado vai pra
// fila. A revisão continua só no repasse, onde o link vem de outro grupo e o
// usuário não escolheu o produto. Pendentes antigos seguem na tela até serem
// aprovados ou rejeitados.
function isAutoApprove(group) {
  if (!isRepasse(group)) return true;
  const v = group.scraping?.auto;
  return v === undefined ? true : !!v;
}

// Preenchimento automático da fila: quando desligado, a campanha só recebe
// produtos quando o usuário clica em "Preencher fila agora" (ou adiciona um a
// um pela prévia do catálogo). Ligado é o padrão — campanha antiga não muda.
function isAutoRefill(group) {
  return group.scraping?.autoRefill !== false;
}

// Embaralhar a fila depois de cada preenchimento automático (Fisher–Yates).
// Sem isso a fila sai na ordem da busca (maior desconto primeiro, por exemplo)
// e o grupo recebe ofertas parecidas em sequência.
function shuffleArray(arr) {
  const out = [...(arr || [])];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Opção do preenchimento automático — desligada por padrão.
function shuffleAfterRefill(group) {
  return group?.scraping?.shuffleAfterRefill === true;
}

// Campanha de repasse: a fila é populada pelos links capturados nos grupos líderes,
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

  // Recalcula keys do history pra detectar duplicatas
  const historyKeys = (group.history || []).map(h => ({ k: productKey(h), sentAt: h.sentAt }));
  const sentRecentlyKeys = new Set(
    historyKeys.filter(h => minutesSince(h.sentAt) < cdMin).map(h => h.k)
  );
  const histKeySet = new Set(historyKeys.map(h => h.k));

  // Só duas limpezas, e nenhuma delas é "mudou de ideia no filtro": item repetido
  // na própria lista e item que já foi enviado (está no histórico) — os dois são
  // item inválido, não item fora de filtro.
  //
  // Filtro aqui é regra de ENTRADA: o que já está na fila só sai por envio ou
  // porque o usuário tirou. Antes a fila era podada a cada tick contra os filtros
  // atuais, e mexer num campo da aba Busca de Produtos (que salva sozinha) fazia
  // metade da fila sumir em silêncio.
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
    console.log(`[scheduler] "${group.name}": removidos ${removedFromQueue} itens da fila (duplicatas/já-enviados)`);
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

  // `batchSize` é o TETO da fila, não um lote solto: o preenchimento completa até
  // ele e para. Antes somava o lote inteiro ao que já estava lá, e a fila passava
  // do número que a tela promete ("Máximo de produtos na fila").
  //
  // O buffer soma fila + pendentes porque é o mesmo buffer que `autoRefillDue`
  // usa pra disparar: com aprovação automática desligada os itens caem em
  // `pending`, e contar só a fila deixaria o teto valendo pra metade do caminho.
  const teto = batchSize(group.scraping);
  const buffer = cleanedQueue.length + cleanedPending.length;
  const vagas = Math.max(0, teto - buffer);

  // Fila cheia: nem consulta o catálogo. Esta função roda a cada tick de cada
  // campanha, e a query com `notIn` da lista inteira de keys não é barata.
  if (vagas === 0) {
    return {
      cleanedQueue, cleanedPending, newItems: [], target, removedFromQueue,
      skippedAff: 0, skippedSent: 0, teto, vagas: 0, full: true,
    };
  }

  // sources vazio = todas as lojas da campanha trancadas. Não dá pra chamar
  // catalog.query assim: lista vazia lá significa "sem filtro de loja" e traria
  // produtos de lojas que a campanha não escolheu.
  const candidates = sources.length
    ? await catalog.query({
        categories: cats.length ? cats : null,
        sources,
        excludeKeys,
        filters,
        limit: vagas,
        sortBy: sortMode(group.scraping),
      })
    : [];

  // Os cupons dos candidatos, em uma consulta só. Cupom vencido não vem (a query
  // filtra por expiresAt), então nada aqui promete desconto que já acabou.
  //
  // Roda sempre, em campanha nenhuma isso é opcional: é daqui que sai a PALAVRA
  // do cupom que a mensagem manda o cliente digitar ({cupom} do template). Já foi
  // condicionado ao `couponBoost`, que era o seletor de "só com cupom / preferir
  // com cupom" da aba — o seletor saiu da tela, e com ele o filtro e a reordenação
  // (que a prévia da aba nunca aplicou, então a lista prometia uma coisa e o
  // preenchimento fazia outra). O enriquecimento fica.
  const cupons = await coupons.couponsListForKeys(candidates.map(p => p.key));
  const escolhidos = candidates.slice(0, vagas);

  // O cupom que este produto consegue ANUNCIAR: o primeiro com palavra. A lista já
  // vem ordenada com os que têm `code` na frente (couponsListForKeys), então é só
  // pegar o primeiro — e é o mesmo critério que o envio usa em couponRuleForItem,
  // que é o que faz a prévia da tela e a mensagem enviada contarem a mesma história.
  const cupomDe = key => (cupons.get(key) || []).find(c => c.code) || null;

  const rawItems = escolhidos.map(p => ({
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
    // O cupom do ML que cobre o produto, já filtrado pelos que têm PALAVRA — sem
    // ela não há o que o cliente digite no checkout, e o envio não desconta
    // (couponRuleForItem). O rótulo sai do detalheDoCupom em vez de ser montado à
    // mão aqui: a regra do "15% OFF" fica num lugar só.
    coupon: cupomDe(p.key)?.code || null,
    couponCampaignId: cupomDe(p.key)?.campaignId || null,
    couponLabel: coupons.detalheDoCupom(p.price, cupomDe(p.key))?.rotulo || null,
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

  // `skippedSent` é o que o catálogo NÃO devolveu por já estar na fila, nos
  // pendentes ou no histórico — a diferença entre as vagas e o que veio. Serve
  // pra mensagem da tela explicar por que entrou menos do que cabia.
  const skippedSent = Math.max(0, vagas - candidates.length);

  return {
    cleanedQueue, cleanedPending, newItems, target, removedFromQueue,
    skippedAff: skippedAff.total, skippedSent, teto, vagas, full: false,
  };
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

// A regra do cupom que vale AGORA pra este item — o que o {preco_com_cupom} usa.
//
// A leitura é aqui, no envio, e não no refill de propósito: o item fica dias na
// fila e o cupom vence nesse meio-tempo. Guardar valor/validade no payload da fila
// seria anunciar promessa velha; o banco é o único lugar onde "vale hoje" é
// verdade. Custa uma consulta por envio, contra os 4s de espera que já existem
// entre um grupo e outro.
//
// A REGRA QUE MANDA AQUI: sem PALAVRA não há desconto a anunciar. A palavra é o que
// o cliente digita no checkout do ML — sem ela a mensagem estaria prometendo um
// preço que ninguém consegue chegar. Foi assim que o fallback por campanha (e o por
// chave de produto, que devolvia o cupom de maior desconto com ou sem palavra)
// saiu daqui: os dois descontavam calados em cupom que o cliente não tinha como usar.
//
// Ordem: a palavra do próprio item primeiro (no repasse vem da legenda do grupo
// líder, ou digitada à mão na fila) — é a que o usuário escolheu. Só depois o
// catálogo, e ali também só cupom COM palavra; `couponsListForKeys` já entrega a
// lista nessa ordem, com os que têm `code` na frente.
//
// Só Mercado Livre: `ml_coupons` é a aba de cupons do ML, e o desconto de lá não
// vale num produto da Amazon ou da Shopee. Sem essa trava, um produto da Amazon com
// a palavra "SAVE10" na legenda do grupo líder colidiria com um cupom do ML de
// mesmo nome e a mensagem anunciaria um preço que não existe.
//
// Nada encontrado, ou banco fora do ar → null → preço normal. É o silêncio certo.
async function couponRuleForItem(item) {
  if (item?.store !== "Mercado Livre") return null;
  const word = (item?.coupon || "").toString().trim();
  if (word) {
    const c = await coupons.findCouponByCode(word).catch(() => null);
    if (c) return c;
  }
  if (item?.key) {
    const mapa = await coupons.couponsListForKeys([item.key]).catch(() => null);
    const c = (mapa?.get(item.key) || []).find(x => x.code);
    if (c) return c;
  }
  return null;
}

// Conversão de link de afiliado por loja. Tabela em vez de três `else if`
// idênticos: o descarte precisava do mesmo tratamento nos três, e repetir a
// gravação do log três vezes é como ela sairia de sincronia.
const AFFILIATE_CONVERTERS = {
  "Mercado Livre": { statusKey: "ml", label: "ML", convert: (u, l) => affiliate.gerarLinkAfiliadoML(u, l) },
  "Amazon": { statusKey: "amazon", label: "Amazon", convert: (u, l) => affiliate.gerarLinkAfiliadoAmazon(u, l) },
  "Shopee": { statusKey: "shopee", label: "Shopee", convert: (u, l) => affiliate.gerarLinkAfiliadoShopee(u, l) },
};

// Grava no log de Repasse o descarte que acontece no ENVIO. Só pra itens que
// vieram do repasse — item de catálogo não tem linha nesse log e inventar uma
// confundiria a contagem. Fire-and-forget: observabilidade não pode atrasar nem
// derrubar o envio.
function logSendDiscard(userId, group, item, reason) {
  if (item?.source !== "repasse") return;
  Promise.resolve(captureLog.logCapture({
    groupId: group.id,
    userId,
    // A coluna é NOT NULL e aqui não existe grupo líder de origem — string vazia
    // em vez de inventar um jid que não é verdade.
    waJid: "",
    rawUrl: item.rawUrl || item.link,
    resolvedUrl: item.link,
    store: item.store,
    sourceAllowed: true,
    affiliateConfigured: true,
    scrapeOk: true,
    productName: item.name, productImg: item.img,
    price: item.price, originalPrice: item.originalPrice,
    discount: item.discount, sold: item.sold, coupon: item.coupon,
    outcome: "discarded",
    errorKind: KIND.CONVERSAO_AFILIADO_FALHOU,
    stage: STAGE.SEND,
    reason,
  })).catch(() => {});
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
  } else if (item.link && AFFILIATE_CONVERTERS[item.store]) {
    // Fallback pra itens legados ou inseridos manualmente (sem affiliateLink).
    // Mesma política de convertItemAffiliate: se o afiliado está configurado e a
    // conversão falha, NÃO manda link sem comissão — descarta (lança erro).
    const { statusKey, convert, label } = AFFILIATE_CONVERTERS[item.store];
    const aff = await convert(userId, item.link);
    if (aff) {
      itemForSend = { ...item, link: aff };
    } else if (affiliate.status(userId)[statusKey].configured) {
      const err = new Error(`Afiliado ${label} falhou pra "${item.name?.slice(0, 40)}" — item descartado (sem link com comissão).`);
      err.code = "affiliate_conversion_failed";
      // Fim da história do repasse: até aqui o item sumia em silêncio — saía da
      // fila, o erro virava um log de servidor e o painel de Repasse nunca contava
      // esse descarte. Registra aqui, e não no catch de quem chama, porque são três
      // chamadores diferentes e só neste ponto se sabe o motivo exato (os catches
      // também pegam falha de WhatsApp, que não é descarte de repasse).
      //
      // Uma linha por TENTATIVA: se o BullMQ retentar o job, conta de novo. É o
      // certo pra um log de eventos, e o painel avisa disso.
      logSendDiscard(userId, group, item, err.message);
      throw err;
    }
  }
  // Defesa: itens já no catálogo/fila podem ter URL de thumb (Amazon, ML ou
  // Shopee) — sobe pra resolução nativa antes de mandar pro WhatsApp pra a
  // prévia ficar enquadrada e nítida.
  if (itemForSend.img) {
    const upgraded = upgradeImageUrl(itemForSend.img);
    if (upgraded !== itemForSend.img) itemForSend = { ...itemForSend, img: upgraded };
  }

  // Cupom: o do próprio item (que vem da legenda do grupo líder no repasse, ou
  // digitado à mão na fila) ou, na falta dele, o que o catálogo conhece.
  const coupon = (itemForSend.coupon || "").toString().trim();
  // A regra do cupom lida AGORA — e ela sempre tem palavra (couponRuleForItem não
  // devolve cupom sem `code`).
  const regraCupom = await couponRuleForItem(itemForSend);
  // Quando o item não trazia palavra e o catálogo tinha uma, ela é HERDADA aqui.
  // Sem isso, o {preco_com_cupom} descontava e o {cupom} sumia da mesma mensagem:
  // preço de cupom sem dizer qual cupom. Os dois falam do mesmo cupom ou nenhum.
  const palavra = coupon || (regraCupom?.code || "").toString().trim();
  // O preço com o desconto e o quanto ele vale, contra o que o banco diz do cupom
  // neste instante. `null` = não deu pra calcular, e aí o {preco_com_cupom} sai
  // igual ao {preco} e as linhas de {desconto_cupom}/{economia_cupom} somem.
  const detalhe = coupons.detalheDoCupom(itemForSend.price, regraCupom);
  itemForSend = {
    ...itemForSend,
    coupon: palavra,
    priceWithCoupon: detalhe ? detalhe.final : null,
    couponLabel: detalhe ? detalhe.rotulo : null,
    couponSaving: detalhe ? detalhe.economia : null,
  };

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
        await new Promise(r => setTimeout(r, SEND_GAP_MS));
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
  // Envio instantâneo (repasse): ignora janelas e intervalo — tudo que está na
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
      usableWhatsappGroups(state.whatsappGroups || [], state.planPaused, state.numbers),
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
  const waGate = await whatsappGate(userId, group, state.whatsappGroups || [], state.planPaused, state.numbers);
  if (waGate.paused) {
    throw new Error(`Campanha pausada: ${waGate.reason}.`);
  }

  // Sem poda por filtro: "Enviar agora" manda o primeiro da fila, que é o que a
  // tela está mostrando. Filtro decide o que ENTRA na fila, não o que fica nela.
  // Tenta refill se queue está vazia — "enviar agora" é ação manual do user,
  // então força os itens pra queue mesmo se a campanha está em modo de revisão.
  let queue = group.queue || [];
  if (!queue.length && !isRepasse(group) && isAutoRefill(group)) {
    const { cleanedQueue, newItems } = await refillQueue(userId, group);
    const refilled = [...cleanedQueue, ...newItems];
    if (refilled.length) {
      await storage.updateGroupOps(userId, groupId, { queue: refilled });
      queue = refilled;
      group.queue = refilled;
    }
  }

  if (!queue.length) {
    if (isRepasse(group)) throw new Error("Fila vazia — nenhum produto capturado dos grupos líderes ainda. Aprove os pendentes ou aguarde novos links nos grupos líderes.");
    if (!isAutoRefill(group)) throw new Error("Fila vazia — o preenchimento automático desta campanha está desligado. Use \"Preencher fila agora\" na aba Busca de Produtos ou ligue o preenchimento automático.");
    throw new Error("Fila vazia — sem produtos no catálogo que passem nos filtros desta campanha. Peça pro admin atualizar o catálogo (página Scraping) ou afrouxe os filtros.");
  }

  const result = await sendItem(
    userId, group,
    usableWhatsappGroups(state.whatsappGroups || [], state.planPaused, state.numbers),
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
  const waGate = await whatsappGate(userId, group, whatsappGroups, planPaused, numbers);
  if (waGate.paused) {
    userNotifier.onCampaignStopped(userId, group.id, group.name, waGate.reason, true).catch(() => {});
    return;
  }
  // Sem nenhuma janela de envio a campanha está parada de verdade: não envia e
  // também não busca produtos novos (senão a fila cresceria sem nunca sair).
  // O envio instantâneo ignora as janelas de propósito, então ele não conta.
  if (!windowGate(group).ok) {
    userNotifier.onCampaignStopped(userId, group.id, group.name, "nenhuma janela de envio configurada", true).catch(() => {});
    return;
  }
  // Não está parada por gate: reseta o edge-trigger pra uma próxima parada avisar.
  userNotifier.onCampaignStopped(userId, group.id, group.name, null, false).catch(() => {});

  // Nada de poda por filtro aqui. Este tick rodava a cada minuto apagando da fila
  // tudo que não batesse mais com os filtros atuais, sem nada na tela dizendo por
  // quê: bastava ajustar um campo na aba Busca de Produtos (que salva sozinha) pra
  // a fila encolher sozinha depois. Filtro é regra de entrada — o que está na fila
  // sai por envio ou porque o usuário tirou.
  // Refill se a campanha precisa de itens — leve porque consulta catálogo.
  // Dois gatilhos possíveis (autoRefillDue): fila acabando dentro da janela de
  // envio, ou horário fixo escolhido pelo usuário. O "buffer" do primeiro é
  // queue + pending, pra contar também o que está aguardando revisão no repasse.
  const inWindow = !!activeWindow(now, group.schedule);
  const due = autoRefillDue(group, now, inWindow);
  // Repasse não puxa do catálogo — a fila é alimentada só pelos grupos líderes.
  if (!isRepasse(group) && isAutoRefill(group) && due.go) {
    markAutoRefill(group.id, now, due.slot);
    const { cleanedQueue, cleanedPending, newItems, target, removedFromQueue } = await refillQueue(userId, group);
    if (newItems.length || removedFromQueue > 0 || cleanedPending.length !== (group.pending || []).length) {
      if (target === "queue") {
        // Embaralha a fila inteira (antigos + novos) quando o usuário pediu —
        // só faz sentido pra fila; pendente espera aprovação, não tem ordem.
        const next = [...cleanedQueue, ...newItems];
        updates.queue = newItems.length && shuffleAfterRefill(group) ? shuffleArray(next) : next;
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
    usableWhatsappGroups(whatsappGroups, planPaused, numbers),
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
  if (isRepasse(group)) throw new Error("Campanha de repasse não busca no catálogo — a fila é alimentada pelos links dos grupos líderes.");

  const merged = { ...group };
  const hasOverride = overrides && (
    overrides.filters || overrides.sources || overrides.categories ||
    overrides.sortBy !== undefined || overrides.batchSize !== undefined ||
    overrides.shuffleAfterRefill !== undefined
  );
  if (hasOverride) {
    merged.scraping = {
      ...(group.scraping || {}),
      ...(overrides.sources !== undefined ? { sources: overrides.sources } : {}),
      ...(overrides.filters !== undefined ? { filters: overrides.filters } : {}),
      ...(overrides.sortBy !== undefined ? { sortBy: overrides.sortBy } : {}),
      ...(overrides.batchSize !== undefined ? { batchSize: overrides.batchSize } : {}),
      ...(overrides.shuffleAfterRefill !== undefined ? { shuffleAfterRefill: overrides.shuffleAfterRefill } : {}),
    };
    if (Array.isArray(overrides.categories)) merged.categories = overrides.categories;
  }

  const {
    cleanedQueue, cleanedPending, newItems, target, removedFromQueue,
    skippedAff, skippedSent, teto, vagas, full,
  } = await refillQueue(userId, merged);
  const updates = {};
  if (target === "queue") {
    const next = [...cleanedQueue, ...newItems];
    updates.queue = newItems.length && shuffleAfterRefill(merged) ? shuffleArray(next) : next;
    if (cleanedPending.length !== (group.pending || []).length) updates.pending = cleanedPending;
  } else {
    updates.pending = [...cleanedPending, ...newItems];
    if (cleanedQueue.length !== (group.queue || []).length) updates.queue = cleanedQueue;
  }
  // O grupo que volta daqui já é o que ficou GRAVADO: updateGroupOps deduplica
  // por productKey ao escrever, então contar `updates.queue` aqui podia anunciar
  // uma fila maior do que a que existe.
  const saved = await storage.updateGroupOps(userId, groupId, updates);
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
    queueSize: (saved?.queue || updates.queue || group.queue || []).length,
    pendingSize: (saved?.pending || updates.pending || group.pending || []).length,
    added: newItems.length,
    removed: removedFromQueue,
    skippedAffiliate: skippedAff || 0,
    // Quantos o catálogo não tinha pra oferecer porque a campanha já mandou (ou
    // já tem na fila) — a tela usa isso pra explicar um lote menor que as vagas.
    skippedSent: skippedSent || 0,
    // O teto da fila e quantas vagas havia quando esta rodada começou.
    limit: teto,
    slots: vagas,
    full: !!full,
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
  isRepasse, isAutoApprove, isAutoRefill, resolveSources, activeSources, sourcesForCampaign,
  status, processSendJob,
  // O descarte por conversão de afiliado acontece dentro do sendItem, antes de
  // qualquer envio — exportado pra tests/unit/scheduler-send-discard.test.js
  // poder cobrir esse caminho sem subir WhatsApp.
  sendItem,
  // Funções puras exportadas só pra teste unitário (tests/unit/scheduler-core.test.js).
  inWindow, activeWindow, windowGate, cooldownMinutes, renderTemplate,
  affiliateGate,
  sortMode, batchSize, refillMode, refillThreshold, refillTimes, autoRefillDue, markAutoRefill,
  shuffleArray, shuffleAfterRefill,
};
