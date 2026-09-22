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
export const makeEmptyGroup = ({ id, name, categories, template, type, repasse, sources }) => {
  const isRepasse = type === "repasse";
  return {
    id,
    name,
    categories: categories || [],
    whatsappGroupIds: [],
    messageTemplate: template || DEFAULT_MESSAGE_TEMPLATE,
    paused: false,
    sentToday: 0,
    sentWeek: 0,
    avgDiscount: "—",
    lastSend: "—",
    weekData: [0, 0, 0, 0, 0, 0, 0],
    schedule: {
      // Sem janela de propósito: a campanha nasce pausada e só começa a enviar
      // depois que o usuário escolher o horário na aba "Janelas de envio".
      windows: [],
      cooldownValue: 2,
      cooldownUnit: "dias",
    },
    scraping: {
      // kind="repasse" desliga o scraping do catálogo — a fila é alimentada
      // pelos grupos líderes. `auto` é reaproveitado como "aprovação automática".
      kind: isRepasse ? "repasse" : "scraping",
      auto: isRepasse ? !!repasse?.autoApprove : true,
      times: ["08:00", "14:00"],
      mode: "both", // "Auto com revisão" — mais seguro pra começar
      // Campanha nova já nasce sem as lojas trancadas pelo admin (o caller passa
      // a lista liberada); sem isso ela apontaria pra uma loja indisponível.
      sources: sources && sources.length ? sources : ["Mercado Livre", "Amazon", "Shopee"],
      filters: { minDiscount: 25, minPrice: 0, maxPrice: 3000, minRating: 4.0, minSales: 50, keywords: "" },
      // { leaders: [{ numberId, jid, name }] } — preenchido na aba Repasse.
      repasse: isRepasse ? { leaders: [], messageMode: "template" } : undefined,
    },
    queue: [],
    pending: [],
    history: [],
  };
};
