// Produtos de fixture pro catalogo — coordenados com o productKey() do backend.

function mlProduct(i = 1, overrides = {}) {
  const id = 1000000 + i;
  return {
    name: `Produto ML ${i}`,
    link: `https://www.mercadolivre.com.br/produto/p/MLB${id}`,
    img: `https://example.com/img-ml-${i}.jpg`,
    price: 100 + i,
    originalPrice: 200 + i,
    discount: 50,
    store: "Mercado Livre",
    category: "gamer",
    rating: 4.5,
    reviewsCount: 100,
    sold: "1mil",
    freeShipping: true,
    seller: "Loja ML",
    ...overrides,
  };
}

function amazonProduct(i = 1, overrides = {}) {
  const asin = `B${String(i).padStart(9, "0")}`;
  return {
    name: `Produto Amazon ${i}`,
    link: `https://www.amazon.com.br/dp/${asin}`,
    img: `https://m.media-amazon.com/images/I/abc${i}._AC_UY218_QL90_.jpg`,
    price: 50 + i,
    originalPrice: 100 + i,
    discount: 50,
    store: "Amazon",
    category: "eletronicos",
    rating: 4.3,
    reviewsCount: 80,
    sold: null,
    freeShipping: false,
    seller: null,
    ...overrides,
  };
}

function makeGroup(overrides = {}) {
  return {
    id: overrides.id || 1,
    name: overrides.name || "Grupo Teste",
    paused: false,
    category: overrides.category || "gamer",
    categories: overrides.categories || ["gamer"],
    whatsappGroupIds: overrides.whatsappGroupIds || ["wa-1"],
    messageTemplate: "{produto} por {preco} ({desconto} OFF) -> {link}",
    scraping: {
      auto: overrides.auto !== undefined ? overrides.auto : true,
      sources: overrides.sources || ["ml"],
      filters: overrides.filters || { minDiscount: 0, minPrice: 0, maxPrice: 99999 },
    },
    schedule: overrides.schedule || {
      windows: [{ from: "00:00", to: "23:59", interval: 0 }],
      cooldownValue: 24,
      cooldownUnit: "horas",
    },
    queue: overrides.queue || [],
    pending: overrides.pending || [],
    history: overrides.history || [],
    sentToday: 0,
    sentWeek: 0,
    weekData: [0, 0, 0, 0, 0, 0, 0],
    lastSend: "—",
    avgDiscount: 0,
  };
}

function makeWhatsAppGroup(overrides = {}) {
  return {
    id: overrides.id || "wa-1",
    name: overrides.name || "Grupo WhatsApp Teste",
    jid: overrides.jid || "123456789@g.us",
    numberId: overrides.numberId || "num-1",
  };
}

export { mlProduct, amazonProduct, makeGroup, makeWhatsAppGroup };
