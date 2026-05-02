export const PRIMARY = "#1D9E75";
export const PRIMARY_DARK = "#0F6E56";
export const PRIMARY_LIGHT = "#E1F5EE";

export const allSources = ["Mercado Livre", "Amazon", "Shopee", "Americanas"];

// Categorias — mapeia id → label e cor do badge
// IMPORTANTE: manter em sincronia com backend/scraper.js → CATEGORIES
export const CATEGORIES = {
  gamer:       { label: "Gamer",       color: "blue" },
  bebe:        { label: "Bebê",        color: "teal" },
  eletronicos: { label: "Eletrônicos", color: "purple" },
  casa:        { label: "Casa",        color: "amber" },
  beleza:      { label: "Beleza",      color: "green" },
};

export const categoryLabel = (id) => CATEGORIES[id]?.label || id;
export const categoryColor = (id) => CATEGORIES[id]?.color || "gray";

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

// Estatísticas derivadas dos grupos de WhatsApp vinculados.
// Se o grupo depende de ML e o afiliado não está configurado, status = "paused"
// (o backend não envia até a tag/cookie estarem ok).
export const getGroupStats = (group, whatsappGroups = [], { affiliateConfigured = true } = {}) => {
  const linked = getLinkedWhatsapps(group, whatsappGroups);
  const members = linked.reduce((s, w) => s + (w.members || 0), 0);
  const connected = linked.filter(w => w.status === "connected").length;
  const pausedByAffiliate = !affiliateConfigured && groupUsesML(group);
  let status;
  if (pausedByAffiliate) status = "paused";
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

export const sidebarItems = [
  { id: "dashboard", icon: "▦", label: "Dashboard geral" },
  { id: "products", icon: "⊟", label: "Produtos" },
  { id: "whatsapp", icon: "◎", label: "WhatsApp" },
  { id: "settings", icon: "⚙", label: "Configurações" },
  { id: "subscription", icon: "★", label: "Assinatura" },
];
