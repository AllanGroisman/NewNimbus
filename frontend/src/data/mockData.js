export const initialNumbers = [
  { id: 1, phone: "+55 11 91234-5678", label: "Principal", status: "connected", lastActivity: "há 2 min", groupsCount: 2 },
  { id: 2, phone: "+55 11 98765-4321", label: "Secundário", status: "disconnected", lastActivity: "há 2 dias", groupsCount: 1 },
];

export const initialGroups = [
  {
    id: 1, name: "Ofertas Tech SP", members: 128, status: "connected", category: "gamer",
    numberId: 1, messageTemplate: "🔥 OFERTA TECH!\n\n📦 {produto}\n💰 De: {preco_antigo}\n✅ Por: {preco}\n🏷️ -{desconto}\n\n🔗 {link}",
    sentToday: 14, sentWeek: 87, avgDiscount: "27%", lastSend: "13:45",
    weekData: [12, 8, 15, 10, 18, 14, 10],
    schedule: { windows: [{ id: 1, from: "09:00", to: "12:00", interval: 30 }, { id: 2, from: "14:00", to: "18:00", interval: 45 }], cooldownValue: 2, cooldownUnit: "horas" },
    scraping: { auto: true, times: ["07:00", "13:00"], mode: "auto", sources: ["Mercado Livre", "Amazon", "Shopee"], filters: { minDiscount: 20, maxPrice: 5000, minRating: 4.0, minSales: 100, keywords: "notebook, monitor, fone" } },
    queue: [
      { id: 1, name: "Smartphone Samsung Galaxy A55", price: "R$ 1.899", discount: "24%", store: "Mercado Livre", img: "📱", sendAt: "14:00" },
      { id: 2, name: "Monitor LG 24\" Full HD", price: "R$ 899", discount: "25%", store: "Shopee", img: "🖥️", sendAt: "14:30" },
      { id: 3, name: "Fone Bluetooth JBL", price: "R$ 199", discount: "33%", store: "Amazon", img: "🎧", sendAt: "15:00" },
    ],
    pending: [
      { id: 10, name: "SSD Kingston 1TB", price: "R$ 399", discount: "28%", store: "Amazon", img: "💾", rating: 4.7, sales: 320 },
      { id: 11, name: "Carregador Turbo 65W", price: "R$ 89", discount: "40%", store: "Shopee", img: "🔌", rating: 4.5, sales: 890 },
    ],
    history: [
      { time: "13:45", name: "Smartphone Samsung Galaxy A55", price: "R$ 1.899", discount: "24%", store: "Mercado Livre" },
      { time: "11:30", name: "Monitor LG 24\"", price: "R$ 899", discount: "25%", store: "Shopee" },
      { time: "09:15", name: "Fone Bluetooth JBL", price: "R$ 199", discount: "33%", store: "Amazon" },
    ],
  },
  {
    id: 2, name: "Promoções Mamãe & Bebê", members: 89, status: "connected", category: "bebe",
    numberId: 1, messageTemplate: "👶 OFERTA BEBÊ!\n\n{produto}\n💰 {preco} (-{desconto})\n🏪 {loja}\n🔗 {link}",
    sentToday: 8, sentWeek: 52, avgDiscount: "29%", lastSend: "12:00",
    weekData: [6, 9, 7, 11, 8, 5, 6],
    schedule: { windows: [{ id: 1, from: "08:00", to: "20:00", interval: 60 }], cooldownValue: 1, cooldownUnit: "dias" },
    scraping: { auto: true, times: ["06:30"], mode: "manual", sources: ["Mercado Livre", "Americanas"], filters: { minDiscount: 15, maxPrice: 2000, minRating: 4.2, minSales: 50, keywords: "carrinho, berço, fralda" } },
    queue: [
      { id: 1, name: "Carrinho de Bebê Burigotto", price: "R$ 649", discount: "28%", store: "Americanas", img: "🛒", sendAt: "16:00" },
      { id: 2, name: "Berço Portátil Chicco", price: "R$ 429", discount: "28%", store: "Mercado Livre", img: "🛏️", sendAt: "17:00" },
    ],
    pending: [],
    history: [
      { time: "12:00", name: "Carrinho de Bebê Burigotto", price: "R$ 649", discount: "28%", store: "Americanas" },
      { time: "08:00", name: "Berço Portátil Chicco", price: "R$ 429", discount: "28%", store: "Mercado Livre" },
    ],
  },
  {
    id: 3, name: "Gadgets Baratos BR", members: 214, status: "disconnected", category: "gamer",
    numberId: 2, messageTemplate: "",
    sentToday: 0, sentWeek: 31, avgDiscount: "22%", lastSend: "2 dias atrás",
    weekData: [10, 12, 9, 0, 0, 0, 0],
    schedule: { windows: [{ id: 1, from: "10:00", to: "22:00", interval: 20 }], cooldownValue: 3, cooldownUnit: "horas" },
    scraping: { auto: false, times: ["08:00"], mode: "manual", sources: ["Shopee", "Americanas"], filters: { minDiscount: 30, maxPrice: 500, minRating: 4.0, minSales: 200, keywords: "gadget, acessório" } },
    queue: [], pending: [], history: [],
  },
];

export const allProducts = [
  { id: 101, name: "Smartwatch Xiaomi Band 8", price: "R$ 249", oldPrice: "R$ 359", discount: "31%", store: "Shopee", category: "gamer", img: "⌚", rating: 4.6, sales: 1200 },
  { id: 102, name: "Carregador Turbo 65W", price: "R$ 89", oldPrice: "R$ 149", discount: "40%", store: "Amazon", category: "gamer", img: "🔌", rating: 4.5, sales: 890 },
  { id: 103, name: "SSD 1TB Kingston", price: "R$ 399", oldPrice: "R$ 549", discount: "28%", store: "Americanas", category: "gamer", img: "💾", rating: 4.7, sales: 320 },
  { id: 104, name: "Cadeirinha Maxi-Cosi", price: "R$ 899", oldPrice: "R$ 1.299", discount: "30%", store: "Amazon", category: "bebe", img: "🪑", rating: 4.8, sales: 210 },
  { id: 105, name: "Tablet Samsung A9", price: "R$ 1.299", oldPrice: "R$ 1.599", discount: "19%", store: "Mercado Livre", category: "gamer", img: "📱", rating: 4.4, sales: 540 },
  { id: 106, name: "Fralda Pampers", price: "R$ 89", oldPrice: "R$ 129", discount: "31%", store: "Americanas", category: "bebe", img: "🧷", rating: 4.9, sales: 3200 },
];
