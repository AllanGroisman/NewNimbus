const express = require("express");
const cors = require("cors");
const { scrapeOfertas, CATEGORIES } = require("./scraper");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Cache por categoria
const cacheByCategory = {};
const CACHE_TTL = 5 * 60 * 1000; // 5 minutos

function getCache(category) {
  const key = category || "_all";
  return cacheByCategory[key] || { data: null, timestamp: 0 };
}

function setCache(category, data) {
  const key = category || "_all";
  cacheByCategory[key] = { data, timestamp: Date.now() };
}

// GET /api/ofertas — retorna ofertas do Mercado Livre
// Query params: category, minDiscount, maxPrice, limit, refresh
app.get("/api/ofertas", async (req, res) => {
  try {
    const category = req.query.category || null;
    const minDiscount = parseInt(req.query.minDiscount) || 0;
    const maxPrice = parseFloat(req.query.maxPrice) || Infinity;
    const limit = parseInt(req.query.limit) || 50;
    const forceRefresh = req.query.refresh === "true";

    const cache = getCache(category);
    const now = Date.now();
    const cacheValid = cache.data && (now - cache.timestamp < CACHE_TTL) && !forceRefresh;

    let allProducts;
    if (cacheValid) {
      allProducts = cache.data;
      console.log(`[cache] ${category || "geral"}: ${allProducts.length} produtos do cache`);
    } else {
      console.log(`[scraper] Buscando ${category || "todas as"} ofertas...`);
      const start = Date.now();
      allProducts = await scrapeOfertas({ category, minDiscount: 0, maxPrice: Infinity, limit: 200 });
      setCache(category, allProducts);
      console.log(`[scraper] ${allProducts.length} produtos (${category || "geral"}) em ${Date.now() - start}ms`);
    }

    let filtered = allProducts;
    if (minDiscount > 0) {
      filtered = filtered.filter(p => p.discount && p.discount >= minDiscount);
    }
    if (maxPrice < Infinity) {
      filtered = filtered.filter(p => p.price <= maxPrice);
    }
    filtered = filtered.slice(0, limit);

    res.json({
      total: filtered.length,
      cached: cacheValid,
      category,
      products: filtered,
    });
  } catch (err) {
    console.error("[scraper] Erro:", err.message);
    res.status(500).json({ error: "Falha ao buscar ofertas", details: err.message });
  }
});

// GET /api/categories — lista categorias disponíveis
app.get("/api/categories", (req, res) => {
  const cats = Object.entries(CATEGORIES).map(([id, info]) => ({
    id,
    label: info.label,
    code: info.code,
  }));
  res.json(cats);
});

// GET /api/status — health check
app.get("/api/status", (req, res) => {
  const caches = Object.entries(cacheByCategory).map(([key, c]) => ({
    category: key,
    products: c.data ? c.data.length : 0,
    age: c.data ? Math.round((Date.now() - c.timestamp) / 1000) + "s" : null,
  }));
  res.json({
    status: "ok",
    categories: Object.keys(CATEGORIES),
    caches,
  });
});

app.listen(PORT, () => {
  console.log(`Nimbus Backend rodando em http://localhost:${PORT}`);
  console.log(`  GET /api/ofertas?category=gamer&minDiscount=20&limit=10`);
  console.log(`  GET /api/categories`);
  console.log(`  GET /api/status`);
});
