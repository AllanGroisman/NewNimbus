import { useState, useEffect, useCallback, useRef } from "react";
import { PRIMARY, PRIMARY_DARK, PRIMARY_LIGHT, TEST_URLS } from "../data/constants";
import Badge from "../components/ui/Badge";
import {
  adminScraperShopee,
  adminScraperShopeeSave,
  adminScraperShopeeClear,
  adminScraperShopeeTest,
  adminScraperShopeeFilters,
  adminScraperShopeeFiltersSave,
} from "../data/api";

// Página admin dedicada à Shopee.
// Hoje cobre só credenciais globais do scraper. Próximas iterações:
// filtros de qualidade (rating/sales mínimos), keywords customizadas por categoria,
// curadoria por loja oficial, etc.
export default function PageAdminShopee() {
  const [data, setData] = useState(null);
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [testUrl, setTestUrl] = useState(TEST_URLS.shopee);
  const [msg, setMsg] = useState(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const r = await adminScraperShopee();
      setData(r);
      if (r.admin?.appId) setAppId(r.admin.appId);
    } catch {}
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function handleSave() {
    setSaving(true);
    setMsg(null);
    try {
      await adminScraperShopeeSave({ appId: appId.trim(), appSecret: appSecret.trim() });
      setAppSecret("");
      setMsg({ type: "ok", text: "Salvo!" });
      refresh();
    } catch (err) {
      setMsg({ type: "err", text: err.message });
    } finally {
      setSaving(false);
    }
  }

  async function handleClear() {
    if (!confirm("Apagar as credenciais Shopee do admin? O scraper volta a usar fallback do primeiro usuário.")) return;
    setSaving(true);
    setMsg(null);
    try {
      await adminScraperShopeeClear();
      setAppId("");
      setAppSecret("");
      setMsg({ type: "ok", text: "Credenciais apagadas." });
      refresh();
    } catch (err) {
      setMsg({ type: "err", text: err.message });
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    setMsg(null);
    try {
      const r = await adminScraperShopeeTest(testUrl.trim());
      setMsg({ type: "ok", text: "Funcionou! Link gerado:", link: r.shortUrl });
    } catch (err) {
      setMsg({ type: "err", text: err.message });
    } finally {
      setTesting(false);
    }
  }

  if (!data) {
    return <div style={{ padding: 40, textAlign: "center", color: "var(--color-text-secondary)" }}>Carregando...</div>;
  }

  const sourceLabel = {
    env: "Variável de ambiente (.env)",
    admin: "Credenciais do admin (esta tela)",
    "user-fallback": "Fallback: 1º usuário configurado",
  }[data.active?.source] || "Nenhuma";
  const sourceColor = data.active?.source === "admin" || data.active?.source === "env" ? "green"
    : data.active?.source === "user-fallback" ? "amber" : "gray";

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <h2 style={{ fontSize: 18, fontWeight: 500 }}>Shopee (admin)</h2>
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 4 }}>
          Credenciais e filtros globais da Shopee usados pelo scraper que alimenta o catálogo central.
        </div>
      </div>

      <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16, marginBottom: 18 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4, gap: 8, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontWeight: 500 }}>Credenciais de afiliado</div>
            <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 4 }}>
              Sobrescreve o fallback de "primeiro usuário configurado" no scraper global.
            </div>
          </div>
          <Badge color={sourceColor}>Fonte ativa: {sourceLabel}</Badge>
        </div>

        <div style={{ marginTop: 14, marginBottom: 10 }}>
          <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>App ID</label>
          <input
            value={appId}
            onChange={e => setAppId(e.target.value)}
            placeholder="ex: 12345678"
            style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13, boxSizing: "border-box", fontFamily: "monospace" }}
          />
        </div>

        <div>
          <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>
            App Secret
            {data.admin?.appSecretPreview && (
              <span style={{ marginLeft: 8, color: "var(--color-text-secondary)" }}>
                (atual: <code>{data.admin.appSecretPreview}</code>)
              </span>
            )}
          </label>
          <div style={{ position: "relative" }}>
            <input
              type={showSecret ? "text" : "password"}
              value={appSecret}
              onChange={e => setAppSecret(e.target.value)}
              placeholder={data.admin?.configured ? "Deixe vazio pra manter o atual" : "cole o App Secret"}
              style={{ width: "100%", padding: "8px 38px 8px 10px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13, boxSizing: "border-box", fontFamily: "monospace" }}
            />
            <button
              type="button"
              onClick={() => setShowSecret(s => !s)}
              style={{ position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)", padding: "2px 8px", borderRadius: 6, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-primary)", fontSize: 10, cursor: "pointer", color: "var(--color-text-secondary)" }}
            >
              {showSecret ? "ocultar" : "mostrar"}
            </button>
          </div>
          <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 4 }}>
            Pega em <a href="https://affiliate.shopee.com.br" target="_blank" rel="noreferrer" style={{ color: PRIMARY }}>affiliate.shopee.com.br</a> → painel → API Open.
          </div>
        </div>

        {data.admin?.configured && (
          <div style={{ marginTop: 14, paddingTop: 12, borderTop: "0.5px solid var(--color-border-tertiary)" }}>
            <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>
              URL pra testar
            </label>
            <input
              value={testUrl}
              onChange={e => setTestUrl(e.target.value)}
              placeholder="https://shopee.com.br/produto-xyz-i.123.456"
              style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 12, boxSizing: "border-box", fontFamily: "monospace" }}
            />
          </div>
        )}

        {msg && (
          <div style={{ marginTop: 10, padding: "8px 10px", borderRadius: 8, fontSize: 12, background: msg.type === "ok" ? PRIMARY_LIGHT : "#FCEBEB", color: msg.type === "ok" ? PRIMARY_DARK : "#A32D2D", wordBreak: "break-all" }}>
            {msg.text}
            {msg.link && (
              <>
                {" "}
                <a href={msg.link} target="_blank" rel="noreferrer" style={{ color: PRIMARY_DARK, textDecoration: "underline", fontFamily: "monospace" }}>
                  {msg.link}
                </a>
              </>
            )}
          </div>
        )}

        <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
          <button
            onClick={handleSave}
            disabled={saving || !appId.trim() || (!data.admin?.configured && !appSecret.trim())}
            style={{ padding: "7px 16px", borderRadius: 8, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500, opacity: (saving || !appId.trim() || (!data.admin?.configured && !appSecret.trim())) ? 0.6 : 1 }}
          >
            {saving ? "Salvando..." : "Salvar"}
          </button>
          <button
            onClick={handleTest}
            disabled={testing || !data.admin?.configured || !testUrl.trim()}
            style={{ padding: "7px 16px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: (!data.admin?.configured || !testUrl.trim()) ? "not-allowed" : "pointer", opacity: (!data.admin?.configured || !testUrl.trim() || testing) ? 0.5 : 1 }}
          >
            {testing ? "Testando..." : "Testar"}
          </button>
          {data.admin?.configured && (
            <button onClick={handleClear} disabled={saving} style={{ padding: "7px 16px", borderRadius: 8, border: "0.5px solid #F7C1C1", background: "#FCEBEB", color: "#A32D2D", fontSize: 13, cursor: "pointer", marginLeft: "auto" }}>
              Apagar
            </button>
          )}
        </div>

        {data.admin?.updatedAt && (
          <div style={{ marginTop: 10, fontSize: 11, color: "var(--color-text-secondary)" }}>
            Atualizado em: {new Date(data.admin.updatedAt).toLocaleString("pt-BR")}
          </div>
        )}
      </div>

      <ShopeeFiltersSection />
    </div>
  );
}

function ShopeeFiltersSection() {
  const [filters, setFilters] = useState(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    adminScraperShopeeFilters().then(r => setFilters(r.filters)).catch(() => {});
  }, []);

  if (!filters) {
    return <div style={{ padding: 20, color: "var(--color-text-secondary)", fontSize: 13 }}>Carregando filtros...</div>;
  }

  const set = (key, value) => setFilters(f => ({ ...f, [key]: value }));

  async function save() {
    setSaving(true);
    setMsg(null);
    try {
      const r = await adminScraperShopeeFiltersSave(filters);
      setFilters(r.filters);
      setMsg({ type: "ok", text: "Filtros salvos! Próximo scraping vai aplicar." });
      setTimeout(() => setMsg(null), 3000);
    } catch (err) {
      setMsg({ type: "err", text: err.message });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16, marginBottom: 18 }}>
      <div style={{ fontWeight: 500, marginBottom: 4 }}>Filtros de qualidade</div>
      <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 16 }}>
        Aplicados a cada produto antes de salvar no catálogo. Valor <code>0</code> = sem filtro.
        Recomendados: rating ≥ 4.0, vendas ≥ 100, desconto máx 95% (corta "99% off" fake).
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14, marginBottom: 16 }}>
        <div>
          <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>
            Pré-seleção da Shopee
          </label>
          <select
            value={filters.listType ?? 0}
            onChange={e => set("listType", Number(e.target.value))}
            style={{ width: "100%", padding: "7px 10px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13, boxSizing: "border-box" }}
          >
            <option value={0}>Recomendados</option>
            <option value={2}>Top performance</option>
            <option value={1}>Maior comissão</option>
          </select>
          <div style={{ fontSize: 10, color: "var(--color-text-secondary)", marginTop: 3 }}>
            Como a Shopee escolhe os produtos dentro de cada categoria.
          </div>
        </div>

        <div>
          <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>
            Ordenação dos resultados
          </label>
          <select
            value={filters.sortType ?? 2}
            onChange={e => set("sortType", Number(e.target.value))}
            style={{ width: "100%", padding: "7px 10px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13, boxSizing: "border-box" }}
          >
            <option value={2}>Mais vendidos (recomendado)</option>
            <option value={1}>Relevância</option>
            <option value={4}>Maior comissão</option>
          </select>
          <div style={{ fontSize: 10, color: "var(--color-text-secondary)", marginTop: 3 }}>
            "Mais vendidos" traz os melhores produtos. "Maior comissão" tende a trazer tranqueira barata.
          </div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 14 }}>
        <NumField label="Rating mínimo (0 a 5)"   step="0.1" max="5"
          value={filters.minRating}        onChange={v => set("minRating", v)}
          hint="Ex: 4.0 — corta produtos com avaliação baixa" />
        <NumField label="Vendas mínimas"          step="10"
          value={filters.minSales}         onChange={v => set("minSales", v)}
          hint="Ex: 100 — corta produtos sem tração" />
        <NumField label="Preço mínimo (R$)"       step="1"
          value={filters.minPrice}         onChange={v => set("minPrice", v)}
          hint="Ex: 20 — corta tranqueira de R$ 5" />
        <NumField label="Preço máximo (R$)"       step="50"
          value={filters.maxPrice}         onChange={v => set("maxPrice", v)}
          hint="0 = sem teto. Ex: 5000" />
        <NumField label="Comissão mínima (%)"     step="0.5" max="100"
          value={filters.minCommissionRate * 100} onChange={v => set("minCommissionRate", v / 100)}
          hint="Ex: 3 = 3% — garante revenue mínimo" />
        <NumField label="Desconto máximo (%)"     step="5" max="100"
          value={filters.maxDiscount}      onChange={v => set("maxDiscount", v)}
          hint="Ex: 95 — corta '99% off' fake" />
        <NumField label="Desconto mínimo (%)"     step="5" max="100"
          value={filters.minDiscount}      onChange={v => set("minDiscount", v)}
          hint="Ex: 1 — só itens em promoção. 0 = qualquer um" />
      </div>

      {msg && (
        <div style={{ marginTop: 14, padding: "8px 10px", borderRadius: 8, fontSize: 12, background: msg.type === "ok" ? PRIMARY_LIGHT : "#FCEBEB", color: msg.type === "ok" ? PRIMARY_DARK : "#A32D2D" }}>
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
          onClick={() => setFilters(f => ({ ...f, minRating: 4.0, minSales: 100, minPrice: 20, maxPrice: 0, minCommissionRate: 0.03, maxDiscount: 95, minDiscount: 0, sortType: 2 }))}
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
