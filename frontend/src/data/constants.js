export const PRIMARY = "#1D9E75";
export const PRIMARY_DARK = "#0F6E56";
export const PRIMARY_LIGHT = "#E1F5EE";

export const allSources = ["Mercado Livre", "Amazon", "Shopee", "Americanas"];

// Categorias — mapeia id → label e cor do badge
export const CATEGORIES = {
  gamer: { label: "Gamer", color: "blue" },
  bebe: { label: "Bebê", color: "teal" },
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

// Estatísticas derivadas dos grupos de WhatsApp vinculados
export const getGroupStats = (group, whatsappGroups = []) => {
  const linked = getLinkedWhatsapps(group, whatsappGroups);
  const members = linked.reduce((s, w) => s + (w.members || 0), 0);
  const connected = linked.filter(w => w.status === "connected").length;
  return {
    linked,
    count: linked.length,
    members,
    connected,
    status: linked.length === 0 ? "empty" : connected > 0 ? "connected" : "disconnected",
  };
};

export const formatPrice = (v) =>
  v != null ? `R$ ${v.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}` : "";

export const sidebarItems = [
  { id: "dashboard", icon: "▦", label: "Dashboard geral" },
  { id: "products", icon: "⊟", label: "Produtos" },
  { id: "whatsapp", icon: "◎", label: "WhatsApp" },
  { id: "settings", icon: "⚙", label: "Configurações" },
  { id: "subscription", icon: "★", label: "Assinatura" },
];
