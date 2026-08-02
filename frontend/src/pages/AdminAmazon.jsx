import { useState, useEffect, useRef } from "react";
import { PRIMARY, PRIMARY_DARK, PRIMARY_LIGHT } from "../data/constants";
import { adminScraperAmazonFilters, adminScraperAmazonFiltersSave, errText } from "../data/api";
import StoreLockCard from "../components/ui/StoreLockCard";
import AlertBanner from "../components/ui/AlertBanner";

export default function PageAdminAmazon() {
  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <h2 style={{ fontSize: 18, fontWeight: 500 }}>Amazon (admin)</h2>
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 4 }}>
          Filtros globais aplicados ao scraping da Amazon antes de salvar no catálogo central.
        </div>
      </div>
      <StoreLockCard store="amazon" storeLabel="Amazon" />
      <AmazonFiltersSection />
    </div>
  );
}

const RECOMENDADOS = { minRating: 4.0, minReviews: 20, minPrice: 20, maxPrice: 0, maxDiscount: 90, minDiscount: 0, enrichLimit: 40 };

function AmazonFiltersSection() {
  const [filters, setFilters] = useState(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  const [loadError, setLoadError] = useState(null);

  // Ver AdminML.jsx: em erro o form fica vazio de propósito, pra ninguém salvar
  // valores default por cima da configuração real do servidor.
  const load = () => {
    adminScraperAmazonFilters()
      .then(r => { setLoadError(null); setFilters(r.filters); })
      .catch(err => setLoadError(errText(err, "Não foi possível carregar os filtros.")));
  };
  useEffect(() => { load(); }, []);

  if (loadError) {
    return <AlertBanner tone="error" message={loadError} onRetry={load} />;
  }
  if (!filters) {
    return <div style={{ padding: 20, color: "var(--color-text-secondary)", fontSize: 13 }}>Carregando filtros...</div>;
  }

  const set = (key, value) => setFilters(f => ({ ...f, [key]: value }));

  async function save() {
    setSaving(true);
    setMsg(null);
    try {
      const r = await adminScraperAmazonFiltersSave(filters);
      setFilters(r.filters);
      setMsg({ type: "ok", text: "Filtros salvos! Próximo scraping vai aplicar." });
      setTimeout(() => setMsg(null), 3000);
    } catch (err) {
      setMsg({ type: "err", text: errText(err, "Não foi possível salvar os filtros.") });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16, marginBottom: 18 }}>
      <div style={{ fontWeight: 500, marginBottom: 4 }}>Filtros de qualidade</div>
      <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 16 }}>
        Aplicados a cada produto antes de salvar no catálogo. Valor <code>0</code> = sem filtro.
        Recomendados: rating ≥ 4.0, avaliações ≥ 20, desconto máx 90%.
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 14 }}>
        <NumField label="Rating mínimo (0 a 5)"     step="0.1" max="5"
          value={filters.minRating}     onChange={v => set("minRating", v)}
          hint="Ex: 4.0 — corta produtos com avaliação baixa" />
        <NumField label="Avaliações mínimas"         step="5"
          value={filters.minReviews}    onChange={v => set("minReviews", v)}
          hint="Ex: 20 — corta produtos sem histórico" />
        <NumField label="Preço mínimo (R$)"          step="1"
          value={filters.minPrice}      onChange={v => set("minPrice", v)}
          hint="Ex: 20 — corta produtos muito baratos" />
        <NumField label="Preço máximo (R$)"          step="50"
          value={filters.maxPrice}      onChange={v => set("maxPrice", v)}
          hint="0 = sem teto. Ex: 5000" />
        <NumField label="Desconto máximo (%)"        step="5" max="100"
          value={filters.maxDiscount}   onChange={v => set("maxDiscount", v)}
          hint="Ex: 90 — corta descontos inflados" />
        <NumField label="Desconto mínimo (%)"        step="5" max="100"
          value={filters.minDiscount}   onChange={v => set("minDiscount", v)}
          hint="Ex: 1 — só itens em promoção. 0 = qualquer um" />
        <NumField label="Produtos enriquecidos"      step="10" max="300"
          value={filters.enrichLimit}   onChange={v => set("enrichLimit", v)}
          hint="Quantos produtos por rodada ganham nota, vendas, vendedor e frete. Cada um abre a página do produto (~5s). Mais = dado mais completo, rodada mais lenta e mais risco de bloqueio. Padrão: 40" />
      </div>

      {msg && (
        <div style={{ marginTop: 14, padding: "8px 10px", borderRadius: 8, fontSize: 12, background: msg.type === "ok" ? PRIMARY_LIGHT : "var(--danger-bg)", color: msg.type === "ok" ? PRIMARY_DARK : "var(--danger-text)" }}>
          {msg.text}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <button
          onClick={save}
          disabled={saving}
          style={{ padding: "8px 16px", borderRadius: 8, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: saving ? "wait" : "pointer", fontWeight: 500, opacity: saving ? 0.6 : 1 }}
        >
          {saving ? "Salvando..." : "Salvar filtros"}
        </button>
        <button
          onClick={() => setFilters({ ...RECOMENDADOS })}
          disabled={saving}
          style={{ padding: "8px 16px", borderRadius: 8, background: "transparent", border: "0.5px solid var(--color-border-secondary)", fontSize: 13, cursor: "pointer" }}
        >
          Aplicar recomendados
        </button>
      </div>
    </div>
  );
}

function NumField({ label, hint, value, onChange, step = "1", max }) {
  // Buffer de texto local: o campo pode ficar vazio/parcial ("", "3.") enquanto o usuário digita,
  // sem que Number("") = 0 force um 0 no estado do pai. O pai só recebe números válidos.
  const fmt = (v) => (v === "" || v == null || Number.isNaN(Number(v))) ? "" : String(Math.round(Number(v) * 1e6) / 1e6);
  const [text, setText] = useState(() => fmt(value));
  const lastNum = useRef(value);
  useEffect(() => {
    // Ressincroniza só quando `value` muda por fora da digitação (reset/carregamento). A comparação
    // aproximada evita o "eco" do próprio onChange e o ruído de float (ex: comissão 0.03 * 100).
    if (Math.abs(Number(value) - Number(lastNum.current)) >= 1e-9) {
      lastNum.current = value;
      setText(fmt(value));
    }
  }, [value]);
  const handleChange = (e) => {
    const t = e.target.value;
    setText(t);
    if (t === "") return;
    const n = Number(t);
    if (!Number.isNaN(n)) { lastNum.current = n; onChange(n); }
  };
  const handleBlur = () => {
    if (text === "" || Number.isNaN(Number(text))) setText(fmt(value));
  };
  return (
    <div>
      <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>{label}</label>
      <input
        type="number"
        min={0}
        max={max}
        step={step}
        value={text}
        onChange={handleChange}
        onBlur={handleBlur}
        style={{ width: "100%", padding: "7px 10px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13, boxSizing: "border-box", fontFamily: "monospace" }}
      />
      {hint && <div style={{ fontSize: 10, color: "var(--color-text-secondary)", marginTop: 3 }}>{hint}</div>}
    </div>
  );
}
