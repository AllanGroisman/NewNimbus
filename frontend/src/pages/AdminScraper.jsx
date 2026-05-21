import { useState, useEffect, useCallback } from "react";
import { PRIMARY, PRIMARY_DARK, PRIMARY_LIGHT, formatPrice } from "../data/constants";
import Badge from "../components/ui/Badge";
import Toggle from "../components/ui/Toggle";
import {
  adminScraperConfig,
  adminSaveScraperConfig,
  adminRunScraper,
  adminScraperStatus,
  adminCatalog,
} from "../data/api";

const STATUS_POLL_MS = 5000;

export default function PageAdminScraper() {
  const [available, setAvailable] = useState({ categories: [], sources: [] });
  const [config, setConfig] = useState(null);
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const [savedMsg, setSavedMsg] = useState(null);

  // Catálogo (visualização)
  const [catItems, setCatItems] = useState([]);
  const [catTotal, setCatTotal] = useState(0);
  const [catPage, setCatPage] = useState(1);
  const [catFilter, setCatFilter] = useState({ category: "", source: "", q: "", sortBy: "lastSeen_desc" });
  const [catLoading, setCatLoading] = useState(false);

  const refreshConfig = useCallback(async () => {
    try {
      const r = await adminScraperConfig();
      setConfig(r.config);
      setAvailable(r.available);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const s = await adminScraperStatus();
      setStatus(s);
    } catch {
      // silencioso
    }
  }, []);

  const refreshCatalog = useCallback(async () => {
    setCatLoading(true);
    try {
      const r = await adminCatalog({ page: catPage, pageSize: 50, ...catFilter });
      setCatItems(r.items || []);
      setCatTotal(r.total || 0);
    } catch (err) {
      setError(err.message);
    } finally {
      setCatLoading(false);
    }
  }, [catPage, catFilter]);

  useEffect(() => {
    (async () => {
      await Promise.all([refreshConfig(), refreshStatus()]);
      setLoading(false);
    })();
  }, [refreshConfig, refreshStatus]);

  useEffect(() => {
    refreshCatalog();
  }, [refreshCatalog]);

  // Polling de status enquanto rodando
  useEffect(() => {
    const id = setInterval(refreshStatus, STATUS_POLL_MS);
    return () => clearInterval(id);
  }, [refreshStatus]);

  // Quando termina de rodar, recarrega catálogo
  useEffect(() => {
    if (status && !status.running && running) {
      setRunning(false);
      refreshCatalog();
    }
    if (status?.running && !running) setRunning(true);
  }, [status?.running]);

  const updateConfig = (patch) => setConfig(c => ({ ...c, ...patch }));

  const toggleArrayItem = (key, value) => {
    setConfig(c => {
      const cur = new Set(c[key] || []);
      cur.has(value) ? cur.delete(value) : cur.add(value);
      return { ...c, [key]: [...cur] };
    });
  };

  // Salva direto (sem state-merge antes) — usado pelo toggle automático.
  // Aceita um patch e devolve a config resultante; aplica no state local.
  async function saveImmediate(patch) {
    setSaving(true);
    setError(null);
    setSavedMsg(null);
    try {
      const merged = { ...config, ...patch };
      setConfig(merged);
      const r = await adminSaveScraperConfig(merged);
      setConfig(r.config);
      setSavedMsg("Salvo!");
      setTimeout(() => setSavedMsg(null), 2000);
      await refreshStatus();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function save() {
    setSaving(true);
    setError(null);
    setSavedMsg(null);
    try {
      const r = await adminSaveScraperConfig(config);
      setConfig(r.config);
      setSavedMsg("Salvo!");
      setTimeout(() => setSavedMsg(null), 2000);
      await refreshStatus();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function runNow() {
    setError(null);
    try {
      await adminRunScraper();
      setRunning(true);
      await refreshStatus();
    } catch (err) {
      setError(err.message);
    }
  }

  if (loading || !config) {
    return <div style={{ padding: 40, textAlign: "center", color: "var(--color-text-secondary)" }}>Carregando...</div>;
  }

  const stats = status?.config ? {
    total: 0,
    byCategory: {},
    byStore: {},
    updatedAt: null,
  } : null;
  const lastResult = status?.lastResult;
  const fmtDate = (iso) => iso ? new Date(iso).toLocaleString("pt-BR") : "—";

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <h2 style={{ fontSize: 18, fontWeight: 500 }}>Scraping global</h2>
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 4 }}>
          Configura o scraper que alimenta o catálogo central. Todas as campanhas consomem deste catálogo.
        </div>
      </div>

      {error && (
        <div style={{ background: "#FCEBEB", color: "#A32D2D", padding: "10px 12px", borderRadius: 8, fontSize: 13, marginBottom: 14 }}>
          {error}
        </div>
      )}

      {/* Status / stats — TODOS os campos lidos de `status` (snapshot do backend),
          nunca de `config` local. Senão dessincroniza durante toggle. */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10, marginBottom: 18 }}>
        <StatBox label="Status" value={status?.running ? "⟳ Rodando" : (status?.config?.enabled ? "Agendado" : "Pausado")} color={status?.running ? PRIMARY : (status?.config?.enabled ? PRIMARY_DARK : "#854F0B")} />
        <StatBox label="Último run" value={fmtDate(status?.lastRun)} sub={status?.lastDuration ? `${(status.lastDuration / 1000).toFixed(1)}s` : null} />
        <StatBox label="Próximo run" value={status?.config?.enabled ? fmtDate(status?.nextRunAt) : "—"} />
        <StatBox label="Produtos no catálogo" value={lastResult?.total ?? "—"} />
      </div>

      {lastResult && (
        <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 14, marginBottom: 18 }}>
          <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8 }}>Resultado do último scraping</div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
            <Badge color="green">+{lastResult.inserted} novos</Badge>
            <Badge color="blue">{lastResult.updated} atualizados</Badge>
            {lastResult.pruned > 0 && <Badge color="amber">-{lastResult.pruned} antigos limpos</Badge>}
          </div>
          {lastResult.perCategory && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 6 }}>
              {Object.entries(lastResult.perCategory).map(([tag, r]) => (
                <div key={tag} style={{ fontSize: 11, padding: "6px 10px", borderRadius: 6, background: r.ok ? "var(--color-background-secondary)" : "#FCEBEB", color: r.ok ? "var(--color-text-primary)" : "#A32D2D" }}>
                  {r.ok ? `${tag}: ${r.inserted}+ ${r.updated}~` : `${tag}: ${r.error}`}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Config */}
      <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16, marginBottom: 18 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <div>
            <div style={{ fontWeight: 500 }}>Scraping automático</div>
            <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>Roda em loop no intervalo configurado</div>
          </div>
          <Toggle value={config.enabled} onChange={v => saveImmediate({ enabled: v })} />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>
          <Field label="Intervalo (minutos)">
            <input
              type="number" min={5} max={10080}
              value={config.intervalMinutes}
              onChange={e => updateConfig({ intervalMinutes: parseInt(e.target.value) || 60 })}
              style={inputStyle}
            />
            <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 4 }}>
              {config.intervalMinutes >= 60 ? `≈ ${Math.round(config.intervalMinutes / 60)}h` : `${config.intervalMinutes}min`}
            </div>
          </Field>
          <Field label="Limite por categoria/loja">
            <input
              type="number" min={10} max={1000}
              value={config.limitPerCategory}
              onChange={e => updateConfig({ limitPerCategory: parseInt(e.target.value) || 200 })}
              style={inputStyle}
            />
          </Field>
        </div>

        <Field label="Categorias">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {available.categories.map(c => {
              const active = (config.categories || []).includes(c.id);
              return (
                <div key={c.id} onClick={() => toggleArrayItem("categories", c.id)}
                  style={{ padding: "6px 12px", borderRadius: 7, border: `0.5px solid ${active ? PRIMARY : "var(--color-border-tertiary)"}`, background: active ? PRIMARY_LIGHT : "transparent", color: active ? PRIMARY_DARK : "var(--color-text-secondary)", fontSize: 12, cursor: "pointer", fontWeight: active ? 500 : 400 }}>
                  {active ? "✓ " : ""}{c.label}
                </div>
              );
            })}
          </div>
        </Field>

        <Field label="Lojas">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {available.sources.map(s => {
              const active = (config.sources || []).includes(s.id);
              return (
                <div key={s.id} onClick={() => toggleArrayItem("sources", s.id)}
                  style={{ padding: "6px 12px", borderRadius: 7, border: `0.5px solid ${active ? PRIMARY : "var(--color-border-tertiary)"}`, background: active ? PRIMARY_LIGHT : "transparent", color: active ? PRIMARY_DARK : "var(--color-text-secondary)", fontSize: 12, cursor: "pointer", fontWeight: active ? 500 : 400 }}>
                  {active ? "✓ " : ""}{s.label}
                </div>
              );
            })}
          </div>
        </Field>

        <Field label="Limpar produtos não vistos há mais de (dias)">
          <input
            type="number" min={1} max={365}
            value={config.pruneAfterDays}
            onChange={e => updateConfig({ pruneAfterDays: parseInt(e.target.value) || 30 })}
            style={{ ...inputStyle, maxWidth: 120 }}
          />
        </Field>

        <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
          <button onClick={save} disabled={saving} style={{ padding: "8px 16px", borderRadius: 8, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500, opacity: saving ? 0.6 : 1 }}>
            {saving ? "Salvando..." : "Salvar configuração"}
          </button>
          <button onClick={runNow} disabled={status?.running} style={{ padding: "8px 16px", borderRadius: 8, background: status?.running ? "var(--color-border-secondary)" : "#fff", color: status?.running ? "var(--color-text-secondary)" : PRIMARY_DARK, border: `0.5px solid ${PRIMARY}`, fontSize: 13, cursor: status?.running ? "not-allowed" : "pointer", fontWeight: 500 }}>
            {status?.running ? "⟳ Rodando..." : "▶ Rodar agora"}
          </button>
          {savedMsg && <span style={{ alignSelf: "center", fontSize: 12, color: PRIMARY_DARK }}>{savedMsg}</span>}
        </div>
      </div>

      {/* Catálogo */}
      <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, gap: 10, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontWeight: 500 }}>Catálogo de produtos</div>
            <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>{catTotal} produtos · página {catPage}</div>
          </div>
          <button onClick={refreshCatalog} disabled={catLoading} style={{ padding: "6px 12px", borderRadius: 7, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 12, cursor: "pointer" }}>
            {catLoading ? "⟳" : "⟳ Atualizar"}
          </button>
        </div>

        <div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
          <input
            placeholder="Buscar nome..."
            value={catFilter.q}
            onChange={e => { setCatFilter(f => ({ ...f, q: e.target.value })); setCatPage(1); }}
            style={{ flex: 1, minWidth: 180, padding: "7px 10px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13 }}
          />
          <select value={catFilter.category} onChange={e => { setCatFilter(f => ({ ...f, category: e.target.value })); setCatPage(1); }} style={selectStyle}>
            <option value="">Todas categorias</option>
            {available.categories.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
          <select value={catFilter.source} onChange={e => { setCatFilter(f => ({ ...f, source: e.target.value })); setCatPage(1); }} style={selectStyle}>
            <option value="">Todas lojas</option>
            {available.sources.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
          <select value={catFilter.sortBy} onChange={e => setCatFilter(f => ({ ...f, sortBy: e.target.value }))} style={selectStyle}>
            <option value="lastSeen_desc">Mais recente</option>
            <option value="discount_desc">Maior desconto</option>
            <option value="price_asc">Menor preço</option>
            <option value="price_desc">Maior preço</option>
            <option value="rating_desc">Melhor avaliação</option>
          </select>
        </div>

        {catItems.length === 0 ? (
          <div style={{ textAlign: "center", padding: 40, color: "var(--color-text-secondary)", fontSize: 13 }}>
            {catLoading ? "Carregando..." : "Catálogo vazio. Clique em 'Rodar agora' pra começar."}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {catItems.map(p => (
              <div key={p.key} style={{ display: "flex", alignItems: "center", gap: 10, padding: 8, borderRadius: 8, background: "var(--color-background-secondary)" }}>
                {p.img ? (
                  <img src={p.img} alt="" style={{ width: 40, height: 40, objectFit: "contain", borderRadius: 4, background: "#fff", flexShrink: 0 }} />
                ) : <div style={{ width: 40, height: 40, borderRadius: 4, background: "var(--color-background-secondary)", flexShrink: 0 }} />}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</div>
                  <div style={{ fontSize: 10, color: "var(--color-text-secondary)", display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <span>{p.store}</span>
                    <span>{typeof p.category === "string" ? p.category : p.category?.id || ""}</span>
                    {p.discount && <span style={{ color: PRIMARY_DARK }}>-{p.discount}%</span>}
                    {p.rating && <span>★ {p.rating}</span>}
                    <span>visto: {new Date(p.lastSeenAt).toLocaleDateString("pt-BR")}</span>
                  </div>
                </div>
                <div style={{ fontSize: 12, fontWeight: 500, color: PRIMARY_DARK, flexShrink: 0 }}>
                  {typeof p.price === "number" ? formatPrice(p.price) : p.price}
                </div>
              </div>
            ))}
          </div>
        )}

        {catTotal > 50 && (
          <div style={{ display: "flex", justifyContent: "center", gap: 8, marginTop: 14 }}>
            <button onClick={() => setCatPage(p => Math.max(1, p - 1))} disabled={catPage <= 1} style={{ padding: "5px 10px", borderRadius: 6, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 12, cursor: catPage <= 1 ? "not-allowed" : "pointer", opacity: catPage <= 1 ? 0.5 : 1 }}>← Anterior</button>
            <span style={{ fontSize: 12, alignSelf: "center" }}>{catPage} / {Math.ceil(catTotal / 50)}</span>
            <button onClick={() => setCatPage(p => p + 1)} disabled={catPage >= Math.ceil(catTotal / 50)} style={{ padding: "5px 10px", borderRadius: 6, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 12, cursor: catPage >= Math.ceil(catTotal / 50) ? "not-allowed" : "pointer", opacity: catPage >= Math.ceil(catTotal / 50) ? 0.5 : 1 }}>Próxima →</button>
          </div>
        )}
      </div>
    </div>
  );
}

const inputStyle = { width: "100%", padding: "7px 10px", borderRadius: 7, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13, boxSizing: "border-box" };
const selectStyle = { padding: "7px 10px", borderRadius: 7, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13 };

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "block", marginBottom: 6 }}>{label}</label>
      {children}
    </div>
  );
}

function StatBox({ label, value, sub, color }) {
  return (
    <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 10, padding: "10px 14px" }}>
      <div style={{ fontSize: 10, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 500, color: color || "var(--color-text-primary)", marginTop: 2 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

// ShopeeAdminSection foi extraído pra pages/AdminShopee.jsx
