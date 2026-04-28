import { useState, useEffect } from "react";
import { PRIMARY, PRIMARY_DARK, PRIMARY_LIGHT, CATEGORIES } from "../data/constants";
import { fetchOfertas } from "../data/api";
import { ProductGridCard } from "../components/ui/ProductCard";

const categoryList = [
  { id: "gamer", label: CATEGORIES.gamer.label },
  { id: "bebe", label: CATEGORIES.bebe.label },
];

export default function PageProducts() {
  const [activeCat, setActiveCat] = useState("gamer");
  const [products, setProducts] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState("");
  const [minDiscount, setMinDiscount] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [sortBy, setSortBy] = useState("discount_desc");
  const [storeFilter, setStoreFilter] = useState("all");

  const load = async (cat, refresh = false) => {
    try {
      if (refresh) setRefreshing(true);
      else setLoading(true);
      setError(null);
      const res = await fetchOfertas({ category: cat, minDiscount, limit: 50, refresh });
      setProducts(prev => ({ ...prev, [cat]: res.products }));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    if (!products[activeCat]) load(activeCat);
  }, [activeCat]);

  // Recarregar quando filtro de desconto muda
  useEffect(() => { load(activeCat); }, [minDiscount]);

  const currentProducts = products[activeCat] || [];

  // Extrair lojas (fontes de scraping) únicas
  const stores = [...new Set(currentProducts.map(p => p.store).filter(Boolean))].sort();

  // Filtrar
  let filtered = currentProducts;
  if (search) filtered = filtered.filter(p => p.name.toLowerCase().includes(search.toLowerCase()));
  if (storeFilter !== "all") filtered = filtered.filter(p => p.store === storeFilter);

  // Ordenar
  const sortFns = {
    discount_desc: (a, b) => (b.discount || 0) - (a.discount || 0),
    price_asc: (a, b) => (a.price || 0) - (b.price || 0),
    price_desc: (a, b) => (b.price || 0) - (a.price || 0),
    rating_desc: (a, b) => (b.rating || 0) - (a.rating || 0),
    reviews_desc: (a, b) => (parseInt(b.reviewsCount) || 0) - (parseInt(a.reviewsCount) || 0),
    sold_desc: (a, b) => {
      const parse = (s) => { if (!s) return 0; const m = s.match(/[\d.]+/); return m ? parseInt(m[0].replace(/\./g, "")) : 0; };
      return parse(b.sold) - parse(a.sold);
    },
    name_asc: (a, b) => (a.name || "").localeCompare(b.name || "", "pt-BR"),
  };
  if (sortFns[sortBy]) filtered = [...filtered].sort(sortFns[sortBy]);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 10 }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 500 }}>Produtos</h2>
          <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 4 }}>
            {loading ? "Buscando ofertas..." : `${filtered.length} ofertas — ${CATEGORIES[activeCat]?.label}`}
          </div>
        </div>
        <button
          onClick={() => load(activeCat, true)}
          disabled={refreshing}
          style={{ padding: "7px 14px", borderRadius: 8, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500, opacity: refreshing ? 0.6 : 1 }}
        >
          {refreshing ? "⟳ Atualizando..." : "⟳ Atualizar ofertas"}
        </button>
      </div>

      {/* Category tabs */}
      <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
        {categoryList.map(c => (
          <button
            key={c.id}
            onClick={() => { setActiveCat(c.id); setStoreFilter("all"); }}
            style={{
              padding: "6px 14px", borderRadius: 8, border: "0.5px solid",
              borderColor: activeCat === c.id ? PRIMARY : "var(--color-border-tertiary)",
              background: activeCat === c.id ? PRIMARY_LIGHT : "transparent",
              color: activeCat === c.id ? PRIMARY_DARK : "var(--color-text-secondary)",
              fontSize: 13, cursor: "pointer", fontWeight: activeCat === c.id ? 500 : 400,
            }}
          >{c.label}</button>
        ))}
      </div>

      {/* Filters */}
      <div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
        <input
          placeholder="Buscar produto..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ flex: 1, minWidth: 160, padding: "7px 12px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-primary)", fontSize: 13 }}
        />
        <select
          value={storeFilter}
          onChange={e => setStoreFilter(e.target.value)}
          style={{ padding: "7px 12px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-primary)", fontSize: 13 }}
        >
          <option value="all">Todas as lojas</option>
          {stores.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select
          value={minDiscount}
          onChange={e => setMinDiscount(Number(e.target.value))}
          style={{ padding: "7px 12px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-primary)", fontSize: 13 }}
        >
          <option value={0}>Todos os descontos</option>
          <option value={10}>Desconto mín: 10%</option>
          <option value={20}>Desconto mín: 20%</option>
          <option value={30}>Desconto mín: 30%</option>
          <option value={50}>Desconto mín: 50%</option>
        </select>
        <select
          value={sortBy}
          onChange={e => setSortBy(e.target.value)}
          style={{ padding: "7px 12px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-primary)", fontSize: 13 }}
        >
          <option value="discount_desc">Maior desconto</option>
          <option value="price_asc">Menor preço</option>
          <option value="price_desc">Maior preço</option>
          <option value="rating_desc">Melhor avaliação</option>
          <option value="reviews_desc">Mais avaliações</option>
          <option value="sold_desc">Mais vendidos</option>
          <option value="name_asc">Nome A-Z</option>
        </select>
      </div>
      {/* Active filters summary */}
      {(storeFilter !== "all" || minDiscount > 0 || search) && (
        <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>Filtros:</span>
          {search && (
            <span onClick={() => setSearch("")} style={{ fontSize: 11, padding: "2px 8px", borderRadius: 6, background: PRIMARY_LIGHT, color: PRIMARY_DARK, cursor: "pointer" }}>
              "{search}" ✕
            </span>
          )}
          {storeFilter !== "all" && (
            <span onClick={() => setStoreFilter("all")} style={{ fontSize: 11, padding: "2px 8px", borderRadius: 6, background: PRIMARY_LIGHT, color: PRIMARY_DARK, cursor: "pointer" }}>
              {storeFilter} ✕
            </span>
          )}
          {minDiscount > 0 && (
            <span onClick={() => setMinDiscount(0)} style={{ fontSize: 11, padding: "2px 8px", borderRadius: 6, background: PRIMARY_LIGHT, color: PRIMARY_DARK, cursor: "pointer" }}>
              Desconto ≥ {minDiscount}% ✕
            </span>
          )}
          <span onClick={() => { setSearch(""); setStoreFilter("all"); setMinDiscount(0); }} style={{ fontSize: 11, color: "var(--color-text-secondary)", cursor: "pointer", textDecoration: "underline" }}>
            Limpar todos
          </span>
        </div>
      )}

      {error && (
        <div style={{ background: "#FCEBEB", border: "0.5px solid #F7C1C1", borderRadius: 12, padding: 16, marginBottom: 14, textAlign: "center" }}>
          <div style={{ fontSize: 13, color: "#A32D2D", fontWeight: 500, marginBottom: 4 }}>Erro ao buscar ofertas</div>
          <div style={{ fontSize: 12, color: "#A32D2D" }}>{error}</div>
          <button onClick={() => load(activeCat)} style={{ marginTop: 10, padding: "6px 14px", borderRadius: 8, border: "0.5px solid #F7C1C1", background: "#fff", color: "#A32D2D", fontSize: 12, cursor: "pointer" }}>Tentar novamente</button>
        </div>
      )}

      {loading && !currentProducts.length ? (
        <div style={{ textAlign: "center", padding: "60px 0", color: "var(--color-text-secondary)" }}>
          <div style={{ fontSize: 24, marginBottom: 12 }}>{"⟳"}</div>
          <div style={{ fontSize: 13 }}>Buscando ofertas de {CATEGORIES[activeCat]?.label}...</div>
          <div style={{ fontSize: 12, marginTop: 4 }}>Isso pode levar alguns segundos na primeira vez</div>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 12 }}>
          {filtered.map((p, i) => <ProductGridCard key={p.link + i} product={p} />)}
        </div>
      )}
    </div>
  );
}
