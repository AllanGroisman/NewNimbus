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

export const formatPrice = (v) =>
  v != null ? `R$ ${v.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}` : "";

export const sidebarItems = [
  { id: "dashboard", icon: "▦", label: "Dashboard geral" },
  { id: "products", icon: "⊟", label: "Produtos" },
  { id: "whatsapp", icon: "◎", label: "WhatsApp" },
  { id: "settings", icon: "⚙", label: "Configurações" },
  { id: "subscription", icon: "★", label: "Assinatura" },
];
