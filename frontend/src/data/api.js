const API_BASE = "";

export async function fetchOfertas({ category, minDiscount = 0, maxPrice, limit = 50, refresh = false } = {}) {
  const params = new URLSearchParams();
  if (category) params.set("category", category);
  if (minDiscount > 0) params.set("minDiscount", minDiscount);
  if (maxPrice) params.set("maxPrice", maxPrice);
  if (limit) params.set("limit", limit);
  if (refresh) params.set("refresh", "true");

  const res = await fetch(`${API_BASE}/api/ofertas?${params}`);
  if (!res.ok) throw new Error("Falha ao buscar ofertas");
  return res.json();
}

export async function fetchStatus() {
  const res = await fetch(`${API_BASE}/api/status`);
  if (!res.ok) throw new Error("Backend indisponível");
  return res.json();
}
