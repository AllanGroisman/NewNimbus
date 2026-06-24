export const PRIMARY = "#ea580c";
export const PRIMARY_DARK = "#c2410c";
export const PRIMARY_LIGHT = "#ffedd5";
export const BRAND_BLUE = "#031432";
export const BRAND_BLUE_LIGHT = "#1a2b48";

export const allSources = ["Mercado Livre", "Amazon", "Shopee"];

// URLs reais de produtos populares pra usar como teste padrão nos
// "Testar transformação" das telas de afiliado. Trocar aqui propaga
// pra todas as telas (ML, Amazon, Shopee usuário, Shopee admin).
// Se uma URL quebrar (produto sumiu), basta editar este arquivo.
export const TEST_URLS = {
  ml:     "https://www.mercadolivre.com.br/echo-dot-5a-geraco-alto-falante-preto-amazon-bivolt-preto/p/MLB27190731",
  amazon: "https://www.amazon.com.br/dp/B09B8V1LZ3",   // Echo Dot 5ª geração
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
  let status;
  if (pausedManual || pausedByAffiliate) status = "paused";
  else if (linked.length === 0) status = "empty";
  else if (connected > 0) status = "connected";
  else status = "disconnected";
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
    paused: pausedManual || pausedByAffiliate,
  };
};

export const formatPrice = (v) =>
  v != null ? `R$ ${v.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}` : "";

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
  { id: "dashboard", icon: "▦", label: "Visão Geral" },
  { id: "whatsapp", icon: "◎", label: "WhatsApp" },
  { id: "mercado-livre", icon: "◆", label: "Mercado Livre" },
  { id: "amazon", icon: "◇", label: "Amazon" },
  { id: "shopee", icon: "◈", label: "Shopee" },
  { id: "tutorials", icon: "⊙", label: "Tutoriais" },
  { id: "settings", icon: "⚙", label: "Configurações" },
  { id: "subscription", icon: "★", label: "Assinatura" },
  { id: "products",       icon: "⊟", label: "Produtos",       adminOnly: true },
  { id: "admin-scraper",  icon: "⟳", label: "Scraping",       adminOnly: true },
  { id: "admin-ml",       icon: "◆", label: "Mercado Livre",  adminOnly: true },
  { id: "admin-amazon",   icon: "◇", label: "Amazon",         adminOnly: true },
  { id: "admin-shopee",   icon: "◈", label: "Shopee",         adminOnly: true },
  { id: "admin-users",          icon: "♟", label: "Usuários",       adminOnly: true },
  { id: "admin-backups",        icon: "⊡", label: "Backups",        adminOnly: true },
  { id: "admin-notifications",  icon: "◉", label: "Notificações",   adminOnly: true },
];
