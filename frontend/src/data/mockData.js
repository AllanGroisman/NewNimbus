export const initialNumbers = [];

export const initialWhatsappGroups = [];

export const initialGroups = [];

// Template padrão sugerido ao criar uma campanha nova.
// Usuário pode editar livremente na aba Gerenciar.
export const DEFAULT_MESSAGE_TEMPLATE = `🔥 OFERTA IMPERDÍVEL!

📦 {produto}
🏪 {loja}

💰 De: {preco_antigo}
✅ Por: {preco}
🏷️ Desconto: -{desconto}

🛒 Compre aqui: {link}`;

// Cria uma campanha vazia com defaults razoáveis
export const makeEmptyGroup = ({ id, name, categories }) => ({
  id,
  name,
  categories,
  whatsappGroupIds: [],
  messageTemplate: DEFAULT_MESSAGE_TEMPLATE,
  sentToday: 0,
  sentWeek: 0,
  avgDiscount: "—",
  lastSend: "—",
  weekData: [0, 0, 0, 0, 0, 0, 0],
  schedule: {
    windows: [{ id: 1, from: "09:00", to: "12:00", interval: 30 }, { id: 2, from: "14:00", to: "18:00", interval: 30 }],
    cooldownValue: 2,
    cooldownUnit: "dias",
  },
  scraping: {
    auto: true,
    times: ["08:00", "14:00"],
    mode: "both", // "Auto com revisão" — mais seguro pra começar
    sources: ["Mercado Livre", "Amazon", "Shopee", "Americanas"],
    filters: { minDiscount: 25, maxPrice: 3000, minRating: 4.0, minSales: 50, keywords: "" },
  },
  queue: [],
  pending: [],
  history: [],
});
