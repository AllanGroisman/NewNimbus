import { useState, useEffect, useCallback, useRef } from "react";
import { PRIMARY, PRIMARY_DARK, PRIMARY_LIGHT, CATEGORIES } from "../data/constants";
import { adminCatalog, adminScraperConfig, adminRunScraper, adminScraperStatus } from "../data/api";
import { ProductGridCard } from "../components/ui/ProductCard";

const STATUS_POLL_MS = 4000;

export default function PageProducts() {
  const [available, setAvailable] = useState({ categories: [], sources: [] });
  const [activeCat, setActiveCat] = useState("all");
  const [storeFilter, setStoreFilter] = useState("all");
  const [products, setProducts] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState("");
  const [minDiscount, setMinDiscount] = useState(0);
  const [sortBy, setSortBy] = useState("discount_desc");
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 60;

  const [scraperStatus, setScraperStatus] = useState(null);
  const [runError, setRunError] = useState(null);

  // Carrega categorias/lojas disponíveis do backend (via config do admin)
  useEffect(() => {
    (async () => {
      try {
        const r = await adminScraperConfig();
        setAvailable(r.available || { categories: [], sources: [] });
      } catch (err) {
        setError(err.message);
      }
    })();
  }, []);

  const loadCatalog = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await adminCatalog({
        page,
        pageSize: PAGE_SIZE,
        category: activeCat === "all" ? undefined : activeCat,
        source: storeFilter === "all" ? undefined : storeFilter,
        q: search || undefined,
        sortBy,
      });
      let items = r.items || [];
      // Filtro de desconto é aplicado client-side porque adminCatalog não expõe minDiscount
      if (minDiscount > 0) items = items.filter(p => (p.discount || 0) >= minDiscount);
      setProducts(items);
      setTotal(r.total || 0);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [activeCat, storeFilter, search, sortBy, page, minDiscount]);

  useEffect(() => { loadCatalog(); }, [loadCatalog]);

  const refreshStatus = useCallback(async () => {
    try {
      const s = await adminScraperStatus();
      setScraperStatus(s);
    } catch {}
  }, []);

  useEffect(() => {
    refreshStatus();
    const id = setInterval(refreshStatus, STATUS_POLL_MS);
    return () => clearInterval(id);
  }, [refreshStatus]);

  // Quando termina de rodar, recarrega catálogo
  const wasRunning = useRef(false);
  useEffect(() => {
    if (scraperStatus?.running) wasRunning.current = true;
    else if (wasRunning.current && !scraperStatus?.running) {
      wasRunning.current = false;
      loadCatalog();
    }
  }, [scraperStatus?.running, loadCatalog]);

  async function runScraper() {
    setRunError(null);
    try {
      await adminRunScraper();
      await refreshStatus();
    } catch (err) {
      setRunError(err.message);
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Reseta página quando filtros mudam
  useEffect(() => { setPage(1); }, [activeCat, storeFilter, search, sortBy, minDiscount]);

  const exportHTML = () => {
    if (!products.length) return;
    const escapeHTML = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
    const stars = (rating) => {
      const filled = Math.max(0, Math.min(5, Math.round(Number(rating) || 0)));
      return "★".repeat(filled) + "☆".repeat(5 - filled);
    };
    const priceText = (p) => typeof p === "number"
      ? `R$ ${p.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`
      : (p || "");

    const cards = products.map(p => {
      const ratingBlock = p.rating ? `
        <div class="rating-nimbus">
            <span class="stars-nimbus">${stars(p.rating)}</span>${p.reviewsCount ? `
            <span class="reviews-nimbus">(${escapeHTML(p.reviewsCount)} avaliações)</span>` : ""}
        </div>` : "";
      return `    <div class="product-card-nimbus">
        <div class="img-placeholder-nimbus">IMG 1080x1080</div>
        <span class="title-nimbus">${escapeHTML(p.name)}</span>${ratingBlock}
        <span class="price-nimbus">${escapeHTML(priceText(p.price))}</span>
    </div>`;
    }).join("\n");

    const html = `<style>
    .product-grid-nimbus { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 20px; padding: 15px; background-color: #F4F4F4; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
    .product-card-nimbus { background: #FFFFFF; border: 1px solid #E0E0E0; border-radius: 4px; padding: 16px; box-shadow: 0 2px 4px rgba(0,0,0,0.05); }
    .img-placeholder-nimbus { width: 100%; aspect-ratio: 1 / 1; background-color: #EEE; display: flex; align-items: center; justify-content: center; margin-bottom: 12px; color: #999; font-weight: bold; }
    .title-nimbus { color: #0B2A33; font-size: 1rem; font-weight: 600; margin: 0 0 8px 0; line-height: 1.4; display: block; }
    .rating-nimbus { display: flex; align-items: center; margin-bottom: 10px; gap: 5px; }
    .stars-nimbus { color: #FF5E12; }
    .reviews-nimbus { font-size: 0.8rem; color: #666; }
    .price-nimbus { color: #FF5E12; font-size: 1.25rem; font-weight: 700; display: block; }
</style>

<div class="product-grid-nimbus">
${cards}
</div>`;

    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `produtos-${activeCat}-${storeFilter}-${new Date().toISOString().slice(0, 10)}.html`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const fmtDate = (iso) => iso ? new Date(iso).toLocaleString("pt-BR") : "—";
  const isRunning = scraperStatus?.running;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 10 }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 500 }}>Produtos do catálogo</h2>
          <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 4 }}>
            {loading ? "Carregando..." : `${total} produtos no filtro atual`}
            {scraperStatus?.lastRun && <> · último scraping: {fmtDate(scraperStatus.lastRun)}</>}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            onClick={exportHTML}
            disabled={!products.length}
            style={{ padding: "7px 14px", borderRadius: 8, background: "transparent", color: PRIMARY_DARK, border: `0.5px solid ${PRIMARY}`, fontSize: 13, cursor: products.length ? "pointer" : "not-allowed", fontWeight: 500, opacity: products.length ? 1 : 0.5 }}
          >
            ↓ Exportar HTML
          </button>
          <button
            onClick={loadCatalog}
            disabled={loading}
            style={{ padding: "7px 14px", borderRadius: 8, background: "transparent", color: "var(--color-text-primary)", border: "0.5px solid var(--color-border-secondary)", fontSize: 13, cursor: "pointer", fontWeight: 500 }}
          >
            ⟳ Atualizar
          </button>
          <button
            onClick={runScraper}
            disabled={isRunning}
            style={{ padding: "7px 14px", borderRadius: 8, background: isRunning ? "var(--color-border-secondary)" : PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: isRunning ? "not-allowed" : "pointer", fontWeight: 500 }}
            title="Roda o scraper global e atualiza o catálogo"
          >
            {isRunning ? "⟳ Scraping rodando..." : "▶ Rodar scraper agora"}
          </button>
        </div>
      </div>

      {(runError || (scraperStatus?.lastError && !isRunning)) && (
        <div style={{ background: "#FCEBEB", border: "0.5px solid #F7C1C1", borderRadius: 8, padding: "8px 12px", marginBottom: 12, fontSize: 12, color: "#A32D2D" }}>
          {runError || scraperStatus?.lastError}
        </div>
      )}

      {isRunning && (
        <div style={{ background: PRIMARY_LIGHT, border: `0.5px solid ${PRIMARY}`, borderRadius: 8, padding: "8px 12px", marginBottom: 12, fontSize: 12, color: PRIMARY_DARK }}>
          ⟳ Scraping em andamento — o catálogo será atualizado automaticamente quando terminar.
        </div>
      )}

      {/* Categorias */}
      <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
        <button
          onClick={() => setActiveCat("all")}
          style={catBtnStyle(activeCat === "all")}
        >Todas categorias</button>
        {available.categories.map(c => (
          <button
            key={c.id}
            onClick={() => setActiveCat(c.id)}
            style={catBtnStyle(activeCat === c.id)}
          >{c.label}</button>
        ))}
      </div>

      {/* Lojas */}
      <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
        <button
          onClick={() => setStoreFilter("all")}
          style={storeBtnStyle(storeFilter === "all")}
        >Todas lojas</button>
        {available.sources.map(s => (
          <button
            key={s.id}
            onClick={() => setStoreFilter(s.id)}
            style={storeBtnStyle(storeFilter === s.id)}
          >{s.label}</button>
        ))}
      </div>

      {/* Search + sort + discount */}
      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        <input
          placeholder="Buscar nome do produto..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ flex: 1, minWidth: 180, padding: "7px 12px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-primary)", fontSize: 13 }}
        />
        <select
          value={minDiscount}
          onChange={e => setMinDiscount(Number(e.target.value))}
          style={selectStyle}
        >
          <option value={0}>Todos descontos</option>
          <option value={10}>Desconto ≥ 10%</option>
          <option value={20}>Desconto ≥ 20%</option>
          <option value={30}>Desconto ≥ 30%</option>
          <option value={50}>Desconto ≥ 50%</option>
        </select>
        <select
          value={sortBy}
          onChange={e => setSortBy(e.target.value)}
          style={selectStyle}
        >
          <option value="discount_desc">Maior desconto</option>
          <option value="lastSeen_desc">Mais recente</option>
          <option value="price_asc">Menor preço</option>
          <option value="price_desc">Maior preço</option>
          <option value="rating_desc">Melhor avaliação</option>
        </select>
      </div>

      {/* Active filters chips */}
      {(activeCat !== "all" || storeFilter !== "all" || minDiscount > 0 || search) && (
        <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>Filtros ativos:</span>
          {activeCat !== "all" && (
            <span onClick={() => setActiveCat("all")} style={chipStyle}>
              {available.categories.find(c => c.id === activeCat)?.label || activeCat} ✕
            </span>
          )}
          {storeFilter !== "all" && (
            <span onClick={() => setStoreFilter("all")} style={chipStyle}>
              {available.sources.find(s => s.id === storeFilter)?.label || storeFilter} ✕
            </span>
          )}
          {minDiscount > 0 && (
            <span onClick={() => setMinDiscount(0)} style={chipStyle}>
              Desconto ≥ {minDiscount}% ✕
            </span>
          )}
          {search && (
            <span onClick={() => setSearch("")} style={chipStyle}>
              "{search}" ✕
            </span>
          )}
          <span onClick={() => { setSearch(""); setStoreFilter("all"); setMinDiscount(0); setActiveCat("all"); }} style={{ fontSize: 11, color: "var(--color-text-secondary)", cursor: "pointer", textDecoration: "underline" }}>
            Limpar tudo
          </span>
        </div>
      )}

      {error && (
        <div style={{ background: "#FCEBEB", border: "0.5px solid #F7C1C1", borderRadius: 12, padding: 16, marginBottom: 14, textAlign: "center" }}>
          <div style={{ fontSize: 13, color: "#A32D2D", fontWeight: 500, marginBottom: 4 }}>Erro ao carregar catálogo</div>
          <div style={{ fontSize: 12, color: "#A32D2D" }}>{error}</div>
          <button onClick={loadCatalog} style={{ marginTop: 10, padding: "6px 14px", borderRadius: 8, border: "0.5px solid #F7C1C1", background: "#fff", color: "#A32D2D", fontSize: 12, cursor: "pointer" }}>Tentar novamente</button>
        </div>
      )}

      {loading && products.length === 0 ? (
        <div style={{ textAlign: "center", padding: "60px 0", color: "var(--color-text-secondary)" }}>
          <div style={{ fontSize: 24, marginBottom: 12 }}>⟳</div>
          <div style={{ fontSize: 13 }}>Carregando catálogo...</div>
        </div>
      ) : products.length === 0 ? (
        <div style={{ textAlign: "center", padding: "60px 20px", color: "var(--color-text-secondary)", background: "var(--color-background-secondary)", borderRadius: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 6 }}>Nenhum produto encontrado</div>
          <div style={{ fontSize: 12, marginBottom: 14 }}>Os filtros atuais não retornaram nada. Tente afrouxar ou rode o scraper.</div>
          <button onClick={runScraper} disabled={isRunning} style={{ padding: "7px 16px", borderRadius: 8, background: isRunning ? "var(--color-border-secondary)" : PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: isRunning ? "wait" : "pointer", fontWeight: 500 }}>
            {isRunning ? "⟳ Rodando..." : "▶ Rodar scraper agora"}
          </button>
        </div>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 12 }}>
            {products.map((p, i) => <ProductGridCard key={p.key || (p.link + i)} product={p} />)}
          </div>

          {totalPages > 1 && (
            <div style={{ display: "flex", justifyContent: "center", gap: 8, marginTop: 18 }}>
              <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1} style={pagBtnStyle(page <= 1)}>← Anterior</button>
              <span style={{ fontSize: 12, alignSelf: "center", padding: "0 10px" }}>{page} / {totalPages}</span>
              <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages} style={pagBtnStyle(page >= totalPages)}>Próxima →</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

const selectStyle = { padding: "7px 12px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-primary)", fontSize: 13 };
const chipStyle = { fontSize: 11, padding: "2px 8px", borderRadius: 6, background: PRIMARY_LIGHT, color: PRIMARY_DARK, cursor: "pointer" };

function catBtnStyle(active) {
  return {
    padding: "6px 14px", borderRadius: 8, border: "0.5px solid",
    borderColor: active ? PRIMARY : "var(--color-border-tertiary)",
    background: active ? PRIMARY_LIGHT : "transparent",
    color: active ? PRIMARY_DARK : "var(--color-text-secondary)",
    fontSize: 13, cursor: "pointer", fontWeight: active ? 500 : 400,
  };
}
function storeBtnStyle(active) {
  return {
    padding: "5px 12px", borderRadius: 7, border: "0.5px solid",
    borderColor: active ? "#0F6E56" : "var(--color-border-tertiary)",
    background: active ? "var(--color-background-secondary)" : "transparent",
    color: active ? "var(--color-text-primary)" : "var(--color-text-secondary)",
    fontSize: 12, cursor: "pointer", fontWeight: active ? 500 : 400,
  };
}
function pagBtnStyle(disabled) {
  return {
    padding: "6px 14px", borderRadius: 7,
    border: "0.5px solid var(--color-border-secondary)",
    background: "transparent", fontSize: 12,
    cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1,
  };
}
