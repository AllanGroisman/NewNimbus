// Cores da marca usadas em estilo inline pelas telas. Apontam pras variáveis
// CSS em vez de trazer o hex: assim a paleta ativa (Admin › Layout) troca tudo
// de uma vez, sem precisar re-renderizar nada em React.
//
// Só servem como VALOR CSS (background, color, border...). Não dá pra fazer
// conta com elas nem concatenar canal alpha (`${PRIMARY}20` não funciona mais)
// — se precisar disso, leia o hex de getComputedStyle ou some uma variável nova
// no index.css.
export const PRIMARY = "var(--color-primary)";
export const PRIMARY_DARK = "var(--color-primary-dark)";
export const PRIMARY_LIGHT = "var(--color-primary-light)";
export const BRAND_BLUE = "#012742";
export const BRAND_BLUE_LIGHT = "#13232f";

export const allSources = ["Mercado Livre", "Amazon", "Shopee"];

// Label da loja (como fica em group.scraping.sources) → id usado no backend e
// nas travas de loja. Espelha STORES em backend/scraping/scraper.js.
export const SOURCE_LABEL_TO_ID = {
  "Mercado Livre": "ml",
  "Amazon": "amazon",
  "Shopee": "shopee",
};

// Cor do selo da loja nos cards de produto (nomes da paleta de ui/Badge). Cada
// loja com a sua, pra bater o olho e saber de onde veio a oferta quando a
// campanha busca nas três ao mesmo tempo.
const STORE_BADGE_COLOR = { ml: "amber", amazon: "indigo", shopee: "orange" };

// Aceita o label ("Mercado Livre", como o catálogo grava em `store`) ou o id.
export function storeBadgeColor(store) {
  const id = SOURCE_LABEL_TO_ID[store] || store;
  return STORE_BADGE_COLOR[id] || "gray";
}

// id da loja → id da aba correspondente no sidebar.
export const STORE_ID_TO_PAGE = {
  ml: "mercado-livre",
  amazon: "amazon",
  shopee: "shopee",
};

// Mensagem de trava da loja, ou null se ela está liberada. Aceita tanto o label
// ("Mercado Livre") quanto o id ("ml"). `locks` é o mapa vindo de /api/stores/locks.
export function storeLockMessage(locks, store) {
  const id = SOURCE_LABEL_TO_ID[store] || store;
  const lock = locks?.[id];
  return lock?.locked ? (lock.message || "Esta loja está indisponível no momento.") : null;
}

// Só as lojas liberadas, na ordem de allSources.
export function unlockedSources(locks) {
  return allSources.filter(s => !storeLockMessage(locks, s));
}

// URLs reais de produtos populares pra usar como teste padrão nos
// "Testar transformação" das telas de afiliado. Trocar aqui propaga
// pra todas as telas (ML, Amazon, Shopee usuário, Shopee admin).
// Se uma URL quebrar (produto sumiu), basta editar este arquivo.
export const TEST_URLS = {
  ml:     "https://www.mercadolivre.com.br/echo-dot-5a-geraco-alto-falante-preto-amazon-bivolt-preto/p/MLB27190731",
  amazon: "https://www.amazon.com.br/dp/B09B8VGCR8",   // Echo Dot 5ª geração
  shopee: "https://shopee.com.br/Fone-Bluetooth-i12-TWS-Inpods12-Sem-Fio-Para-iPhone-Android-Universal-i.355684441.21753556712",
};

// Categorias — mapeia id → label, cor do badge e ícone (emoji)
// IMPORTANTE: manter em sincronia com backend/scraping/scraper.js → CATEGORIES
export const CATEGORIES = {
  gamer:       { label: "Gamer",       color: "blue",   icon: "🎮" },
  bebe:        { label: "Bebê",        color: "teal",   icon: "👶" },
  eletronicos: { label: "Eletrônicos", color: "purple", icon: "📱" },
  casa:        { label: "Casa",        color: "amber",  icon: "🏠" },
  beleza:      { label: "Beleza",      color: "green",  icon: "💄" },
  brinquedos:  { label: "Brinquedos",  color: "red",    icon: "🧸" },
  roupas:      { label: "Roupas",      color: "rose",   icon: "👕" },
  esportes:    { label: "Esportes e Fitness", color: "cyan", icon: "⚽" },
  informatica: { label: "Informática", color: "indigo", icon: "💻" },
  pet:         { label: "Pet Shop",    color: "orange", icon: "🐾" },
};

export const categoryLabel = (id) => CATEGORIES[id]?.label || id;
export const categoryColor = (id) => CATEGORIES[id]?.color || "gray";
export const categoryIcon  = (id) => CATEGORIES[id]?.icon || "•";

// Retrocompatibilidade: aceita `categories` (array) ou `category` (string legado)
export const getGroupCategories = (group) => {
  if (Array.isArray(group?.categories) && group.categories.length > 0) return group.categories;
  if (group?.category) return [group.category];
  return [];
};

// Resolve os grupos de WhatsApp vinculados a um grupo da app
export const getLinkedWhatsapps = (group, whatsappGroups = []) => {
  const ids = group?.whatsappGroupIds || [];
  return whatsappGroups.filter(w => ids.includes(w.id));
};

// Grupo depende de afiliado ML? (sem fontes definidas = default ML)
export const groupUsesML = (group) => {
  const srcs = group?.scraping?.sources;
  if (!Array.isArray(srcs) || srcs.length === 0) return true;
  return srcs.includes("Mercado Livre");
};

// Grupo depende de afiliado Shopee? (só se Shopee aparecer explicitamente)
export const groupUsesShopee = (group) => {
  const srcs = group?.scraping?.sources;
  if (!Array.isArray(srcs) || srcs.length === 0) return false;
  return srcs.includes("Shopee");
};

// Estatísticas derivadas dos grupos de WhatsApp vinculados.
// `affiliateConfigured` aceita boolean (compat antiga = só ML) OU objeto
// `{ ml, shopee }` pra cobrir Shopee. Se o grupo depende de uma loja com gating
// e o afiliado dela não está configurado, status = "paused" (o backend não
// envia até estar ok).
export const getGroupStats = (group, whatsappGroups = [], { affiliateConfigured = true } = {}) => {
  const linked = getLinkedWhatsapps(group, whatsappGroups);
  const members = linked.reduce((s, w) => s + (w.members || 0), 0);
  const connected = linked.filter(w => w.status === "connected").length;
  const mlOk = typeof affiliateConfigured === "object" ? !!affiliateConfigured.ml : !!affiliateConfigured;
  const shopeeOk = typeof affiliateConfigured === "object" ? !!affiliateConfigured.shopee : true;
  const pausedByAffiliateML = !mlOk && groupUsesML(group);
  const pausedByAffiliateShopee = !shopeeOk && groupUsesShopee(group);
  const pausedByAffiliate = pausedByAffiliateML || pausedByAffiliateShopee;
  const pausedManual = !!group?.paused;
  // Sem nenhuma janela de envio a campanha está parada: o backend não envia nem
  // busca produtos novos. O envio instantâneo ignora as janelas de propósito,
  // então com ele ligado a campanha continua rodando.
  const pausedNoWindow = !((group?.schedule?.windows || []).length) && group?.scraping?.autoSend !== true;
  let status;
  if (pausedManual || pausedByAffiliate || pausedNoWindow) status = "paused";  // amarelo (manual/afiliado/sem janela)
  else if (linked.length === 0) status = "empty";                 // cinza
  else if (connected === 0) status = "disconnected";              // vermelho — sem WhatsApp, pausada
  else if (connected < linked.length) status = "degraded";        // amarelo — parcial (algum caído)
  else status = "connected";                                      // verde — todos conectados
  return {
    linked,
    count: linked.length,
    members,
    connected,
    status,
    pausedByAffiliate,
    pausedByAffiliateML,
    pausedByAffiliateShopee,
    pausedManual,
    pausedNoWindow,
    paused: pausedManual || pausedByAffiliate || pausedNoWindow,
  };
};

export const formatPrice = (v) =>
  v != null ? `R$ ${v.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}` : "";

// Formata número grande compacto: 1234 -> "1,2 mil", 1500000 -> "1,5 mi".
export function formatCompact(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return null;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1).replace(".", ",").replace(",0", "")} mi`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1).replace(".", ",").replace(",0", "")} mil`;
  return String(v);
}

// Normaliza "vendidos" para texto curto. As lojas guardam de jeitos diferentes:
// ML traz `sold` (string, ex.: "+50 vendidos"); Shopee traz `soldCount` (número).
export function soldText(product) {
  if (product?.soldCount != null && Number(product.soldCount) > 0) {
    return `${formatCompact(product.soldCount)} vendidos`;
  }
  if (product?.sold) {
    const s = String(product.sold).trim();
    return /vendid/i.test(s) ? s : `${s} vendidos`;
  }
  return null;
}

// Calcula o horário previsto de envio para cada item da fila, baseado nas
// janelas, no interval e no lastSend. Retorna array de Date | null (null se
// o item não cabe nas próximas 24h de janelas).
export function computeQueueETA(group, now = new Date()) {
  const queue = group?.queue || [];
  const windows = (group?.schedule?.windows || []).slice().sort((a, b) => (a.from || "").localeCompare(b.from || ""));
  if (!queue.length || !windows.length) return queue.map(() => null);

  const hhmmToMin = (s) => {
    const [h, m] = String(s || "0:0").split(":").map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  const dateAt = (base, mins) => {
    const d = new Date(base);
    d.setHours(0, 0, 0, 0);
    d.setMinutes(mins);
    return d;
  };

  // Próximo "slot" a partir de um instante: devolve { time, window } ou null
  function nextSlot(after, lookaheadDays = 2) {
    for (let day = 0; day < lookaheadDays; day++) {
      const dayBase = new Date(after); dayBase.setDate(dayBase.getDate() + day);
      const afterMin = (day === 0)
        ? after.getHours() * 60 + after.getMinutes() + (after.getSeconds() > 0 ? 1 : 0)
        : 0;
      for (const w of windows) {
        const from = hhmmToMin(w.from), to = hhmmToMin(w.to);
        const slotMin = Math.max(from, afterMin);
        if (slotMin < to) return { time: dateAt(dayBase, slotMin), window: w };
      }
    }
    return null;
  }

  // Primeiro item: respeita lastSend + interval (se há janela ativa)
  const result = [];
  let cursor = new Date(now);
  if (group.lastSend && group.lastSend !== "—") {
    const last = new Date(group.lastSend);
    if (!isNaN(last.getTime())) {
      const activeWin = windows.find(w => {
        const cur = now.getHours() * 60 + now.getMinutes();
        return cur >= hhmmToMin(w.from) && cur < hhmmToMin(w.to);
      });
      if (activeWin) {
        const earliest = new Date(last.getTime() + (Number(activeWin.interval) || 30) * 60_000);
        if (earliest > cursor) cursor = earliest;
      }
    }
  }

  for (let i = 0; i < queue.length; i++) {
    const slot = nextSlot(cursor);
    if (!slot) { result.push(null); cursor = new Date(cursor.getTime() + 60_000); continue; }
    result.push(slot.time);
    const interval = Number(slot.window.interval) || 30;
    cursor = new Date(slot.time.getTime() + interval * 60_000);
  }
  return result;
}

export function formatETA(d, now = new Date()) {
  if (!d) return "—";
  const sameDay = d.toDateString() === now.toDateString();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  if (sameDay) return `${hh}:${mm}`;
  const dd = String(d.getDate()).padStart(2, "0");
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mo} ${hh}:${mm}`;
}

// ─── Datas no fuso de Brasília ──────────────────────────────────────────
// O backend grava timestamps em UTC (toISOString). Para exibir sempre no
// horário de Brasília — independente do fuso do navegador/servidor — formate
// com timeZone fixo "America/Sao_Paulo".
export const TZ_BR = "America/Sao_Paulo";

const toDate = (d) => {
  if (!d || d === "—") return null;
  const date = d instanceof Date ? d : new Date(d);
  return isNaN(date.getTime()) ? null : date;
};

// "DD/MM/AAAA" no fuso de Brasília
export function formatDateBR(d) {
  const date = toDate(d);
  return date ? date.toLocaleDateString("pt-BR", { timeZone: TZ_BR }) : "—";
}

// "HH:MM" no fuso de Brasília
export function formatTimeBR(d) {
  const date = toDate(d);
  return date
    ? date.toLocaleTimeString("pt-BR", { timeZone: TZ_BR, hour: "2-digit", minute: "2-digit" })
    : "—";
}

// "DD/MM/AAAA HH:MM" no fuso de Brasília
export function formatDateTimeBR(d) {
  const date = toDate(d);
  if (!date) return "—";
  return `${formatDateBR(date)} ${formatTimeBR(date)}`;
}

// true se a data cai no mesmo dia que `now`, ambos avaliados no fuso de Brasília
export function isSameDayBR(d, now = new Date()) {
  const date = toDate(d);
  if (!date) return false;
  return formatDateBR(date) === formatDateBR(now);
}

export const sidebarItems = [
  { id: "dashboard", icon: "▦", label: "Campanhas" },
  { id: "whatsapp", icon: "◎", label: "WhatsApp" },
  { id: "mercado-livre", icon: "◆", label: "Mercado Livre" },
  { id: "amazon", icon: "◇", label: "Amazon" },
  { id: "shopee", icon: "◈", label: "Shopee" },
  { id: "desempenho", icon: "▲", label: "Desempenho" },
  { id: "tutorials", icon: "⊙", label: "Tutoriais" },
  { id: "settings", icon: "⚙", label: "Configurações" },
  { id: "subscription", icon: "★", label: "Assinatura" },
  { id: "products",       icon: "⊟", label: "Produtos",       adminOnly: true },
  { id: "admin-cupons",   icon: "🏷", label: "Cupons",         adminOnly: true },
  { id: "admin-scraper",  icon: "⟳", label: "Scraping",       adminOnly: true },
  { id: "admin-scrap-tester", icon: "⚗", label: "ScrapTester", adminOnly: true },
  { id: "admin-ml",       icon: "◆", label: "Mercado Livre",  adminOnly: true },
  { id: "admin-amazon",   icon: "◇", label: "Amazon",         adminOnly: true },
  { id: "admin-shopee",   icon: "◈", label: "Shopee",         adminOnly: true },
  { id: "admin-repasse",  icon: "⟲", label: "Repasse",        adminOnly: true },
  { id: "admin-cupom",    icon: "🎟", label: "Cupom",          adminOnly: true },
  { id: "admin-downloader", icon: "⤓", label: "Downloader",    adminOnly: true },
  { id: "admin-users",          icon: "♟", label: "Usuários",       adminOnly: true },
  { id: "admin-backups",        icon: "⊡", label: "Backups",        adminOnly: true },
  { id: "admin-notifications",  icon: "◉", label: "Notificações",   adminOnly: true },
  { id: "admin-notif-templates", icon: "✎", label: "Modelos Notificações", adminOnly: true },
  { id: "admin-tutoriais",      icon: "✱", label: "Editar Tutoriais", adminOnly: true },
  { id: "admin-emails",         icon: "✉", label: "E-mails",         adminOnly: true },
  { id: "admin-whatsnimbus",    icon: "❂", label: "WhatsNimbus",    adminOnly: true },
  { id: "admin-layout",         icon: "◐", label: "Layout",         adminOnly: true },
  { id: "admin-stripe",         icon: "▤", label: "Stripe",         adminOnly: true },
];

// Rótulo do plano exibido na sidebar. FALLBACK: o nome de verdade vem do
// produto no Stripe (billing.plans), e estes textos só valem enquanto o
// catálogo não chegou ou o Stripe está fora do ar.
export const PLAN_LABELS = {
  free: "Sem plano ativo",
  basic: "Plano Básico",
  pro: "Plano Pro",
  business: "Plano Business",
};

// Rótulo do plano em uso, ou null quando o billing ainda não carregou (aí a UI
// não mostra nada em vez de chutar um plano que o usuário talvez não tenha).
// `plans` é o catálogo de /api/billing/me — quando presente, o nome vem do
// Stripe, então renomear o produto no dashboard reflete aqui sem deploy.
export function planLabel(effectivePlan, plans = null) {
  if (!effectivePlan) return null;
  const fromStripe = plans?.find(p => p.id === effectivePlan)?.label;
  if (fromStripe) return `Plano ${fromStripe}`;
  return PLAN_LABELS[effectivePlan] || null;
}

// ─── Rotas ──────────────────────────────────────────────────────────────────
// Cada página do sidebar tem um endereço próprio, pro botão voltar do navegador
// funcionar e pra dar pra compartilhar link. Campanhas usam /campanha/:id.
export const PAGE_TO_PATH = {
  dashboard: "/",
  whatsapp: "/whatsapp",
  "mercado-livre": "/mercado-livre",
  amazon: "/amazon",
  shopee: "/shopee",
  desempenho: "/desempenho",
  tutorials: "/tutoriais",
  settings: "/configuracoes",
  subscription: "/assinatura",
  products: "/admin/produtos",
  "admin-cupons": "/admin/cupons",
  "admin-scraper": "/admin/scraping",
  "admin-scrap-tester": "/admin/scrap-tester",
  "admin-ml": "/admin/mercado-livre",
  "admin-amazon": "/admin/amazon",
  "admin-shopee": "/admin/shopee",
  "admin-repasse": "/admin/repasse",
  "admin-cupom": "/admin/cupom",
  "admin-downloader": "/admin/downloader",
  "admin-users": "/admin/usuarios",
  "admin-backups": "/admin/backups",
  "admin-notifications": "/admin/notificacoes",
  "admin-notif-templates": "/admin/modelos-notificacoes",
  "admin-tutoriais": "/admin/tutoriais",
  "admin-emails": "/admin/emails",
  "admin-whatsnimbus": "/admin/whatsnimbus",
  "admin-layout": "/admin/layout",
  "admin-stripe": "/admin/stripe",
};

// Rotas que funcionam SEM login — o caminho de quem vem da landing page pagar.
// App.jsx trata estas antes do gate de autenticação.
export const PUBLIC_PATHS = {
  "/assinar": "assinar",
  "/bem-vindo": "bem-vindo",
};

// Lê e remove um parâmetro da query string (?verify=… / ?reset=… /
// ?trocaemail=…). Tirar da URL na leitura evita que um F5 refaça a ação e que o
// token de uso único fique no histórico do navegador.
export function popQueryParam(name) {
  const qs = new URLSearchParams(window.location.search);
  const v = qs.get(name);
  if (v == null) return null;
  qs.delete(name);
  const newSearch = qs.toString();
  window.history.replaceState({}, "", window.location.pathname + (newSearch ? `?${newSearch}` : ""));
  return v;
}

// Nome da página pública deste endereço, ou null se a rota exige login.
export function publicPageFor(pathname) {
  const clean = (pathname || "/").replace(/\/+$/, "") || "/";
  return PUBLIC_PATHS[clean] || null;
}

// Paletas oferecidas no Admin › Layout. O `id` vira data-palette no <html> e os
// blocos correspondentes moram no topo do index.css. `swatch` é só pra prévia
// no menu — não é usado pra pintar a tela.
export const PALETTES = [
  {
    id: "nimbus",
    label: "Nimbus",
    hint: "Marinho e laranja do logo. É a paleta atual.",
    swatch: { brand: "#cd6f04", bgLight: "#f5f8fa", bgDark: "#13232f", text: "#11212c" },
  },
  {
    id: "laranja",
    label: "Só laranja",
    hint: "O laranja novo da marca, mas com os cinzas neutros de antes.",
    swatch: { brand: "#cd6f04", bgLight: "#f7f7f5", bgDark: "#1e1e1e", text: "#1a1a1a" },
  },
  {
    id: "classica",
    label: "Clássica",
    hint: "As cores do sistema antes da marca entrar.",
    swatch: { brand: "#ea580c", bgLight: "#f7f7f5", bgDark: "#1e1e1e", text: "#1a1a1a" },
  },
];

export const DEFAULT_PALETTE = "nimbus";
export const isValidPalette = (id) => PALETTES.some(p => p.id === id);

const PATH_TO_PAGE = Object.fromEntries(
  Object.entries(PAGE_TO_PATH).map(([page, path]) => [path, page])
);

// Caminho da navegação atual. `groupId` (campanha aberta) tem precedência.
export function navToPath({ page, groupId } = {}) {
  if (groupId != null) return `/campanha/${encodeURIComponent(groupId)}`;
  return PAGE_TO_PATH[page] || "/";
}

// Inverso de navToPath: { page, groupId }. Caminho desconhecido cai no dashboard.
export function pathToNav(pathname) {
  const clean = (pathname || "/").replace(/\/+$/, "") || "/";
  const campanha = clean.match(/^\/campanha\/(.+)$/);
  if (campanha) return { page: "group", groupId: decodeURIComponent(campanha[1]) };
  return { page: PATH_TO_PAGE[clean] || "dashboard", groupId: null };
}

// Eventos que o WhatsNimbus (WhatsApp do sistema) pode avisar por DM.
// `campaign: true` = evento de uma campanha, que também pode ser silenciado
// dentro dela (aba Gerenciar → scraping.notifications).
export const WHATSNIMBUS_EVENTS = [
  { key: "whatsappDisconnected", label: "WhatsApp desconectado", desc: "Aviso quando um dos seus números cai" },
  { key: "campaignStopped",      label: "Campanha parada",        desc: "Quando uma campanha para por algum motivo (ex.: afiliado ou WhatsApp)", campaign: true },
  { key: "campaignDeactivated",  label: "Campanha desativada",    desc: "Quando você pausa uma campanha", campaign: true },
  { key: "campaignReactivated",  label: "Campanha reativada",     desc: "Quando você retoma uma campanha", campaign: true },
  { key: "productSearch",        label: "Busca de produtos",      desc: "Resultado das buscas: aprovados / aguardando confirmação", campaign: true },
  { key: "queueEmpty",           label: "Fila vazia",             desc: "Quando a fila de uma campanha fica sem produtos", campaign: true },
  { key: "groupDuplicated",      label: "Grupo duplicado",        desc: "Quando um grupo destino enche e a duplicação automática cria o próximo" },
];
