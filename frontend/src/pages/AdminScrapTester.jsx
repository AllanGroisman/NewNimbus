import { useState, useEffect, useCallback } from "react";
import { PRIMARY, PRIMARY_DARK, PRIMARY_LIGHT } from "../data/constants";
import Toggle from "../components/ui/Toggle";
import {
  adminScrapTesterConfig,
  adminScrapTesterSave,
  adminScrapTesterStatus,
  adminScrapTesterRun,
  adminScrapTesterCancel,
  adminScrapTesterHistory,
} from "../data/api";

const STATUS_POLL_MS = 5000;

const OVERALL = {
  ok:   { label: "✅ Tudo certo", color: PRIMARY_DARK },
  warn: { label: "⚠️ Campos faltando", color: "#854F0B" },
  fail: { label: "❌ Scraping quebrado", color: "#A32D2D" },
};

const CELL = {
  ok:   { bg: "var(--color-background-secondary)", fg: "var(--color-text-primary)" },
  warn: { bg: "#FCF3E4", fg: "#854F0B" },
  fail: { bg: "#FCEBEB", fg: "#A32D2D" },
};

export default function PageAdminScrapTester() {
  const [available, setAvailable] = useState({ categories: [], sources: [] });
  const [fieldSpecs, setFieldSpecs] = useState([]);
  const [config, setConfig] = useState(null);
  const [status, setStatus] = useState(null);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [error, setError] = useState(null);
  const [savedMsg, setSavedMsg] = useState(null);

  const refreshConfig = useCallback(async () => {
    try {
      const r = await adminScrapTesterConfig();
      setConfig(r.config);
      setAvailable(r.available);
      setFieldSpecs(r.fieldSpecs || []);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await adminScrapTesterStatus());
    } catch {
      // silencioso — polling
    }
  }, []);

  const refreshHistory = useCallback(async () => {
    try {
      const r = await adminScrapTesterHistory();
      setHistory(r.history || []);
    } catch {
      // silencioso
    }
  }, []);

  useEffect(() => {
    (async () => {
      await Promise.all([refreshConfig(), refreshStatus(), refreshHistory()]);
      setLoading(false);
    })();
  }, [refreshConfig, refreshStatus, refreshHistory]);

  useEffect(() => {
    const id = setInterval(refreshStatus, STATUS_POLL_MS);
    return () => clearInterval(id);
  }, [refreshStatus]);

  // Quando o teste termina, recarrega o histórico
  const running = !!status?.running;
  useEffect(() => {
    if (!running) {
      setCanceling(false);
      refreshHistory();
    }
  }, [running, refreshHistory]);

  const updateConfig = (patch) => setConfig(c => ({ ...c, ...patch }));

  const toggleSource = (id) => {
    setConfig(c => {
      const cur = new Set(c.sources || []);
      cur.has(id) ? cur.delete(id) : cur.add(id);
      return { ...c, sources: [...cur] };
    });
  };

  async function save(patch) {
    setSaving(true);
    setError(null);
    setSavedMsg(null);
    try {
      const body = { ...config, ...(patch || {}) };
      if (patch) setConfig(body);
      const r = await adminScrapTesterSave(body);
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
      await adminScrapTesterRun();
      await refreshStatus();
    } catch (err) {
      setError(err.message);
    }
  }

  async function cancelRun() {
    setError(null);
    setCanceling(true);
    try {
      await adminScrapTesterCancel();
      await refreshStatus();
    } catch (err) {
      setCanceling(false);
      setError(err.message);
    }
  }

  // Muda o limiar de um campo numa loja e salva
  function setThreshold(source, field, value) {
    const thresholds = { ...(config.thresholds || {}) };
    const key = `${source}.${field}`;
    if (value === "" || value === null) delete thresholds[key];
    else thresholds[key] = Number(value);
    setConfig(c => ({ ...c, thresholds }));
  }

  if (loading || !config) {
    return <div style={{ padding: 40, textAlign: "center", color: "var(--color-text-secondary)" }}>Carregando...</div>;
  }

  const fmtDate = (iso) => iso ? new Date(iso).toLocaleString("pt-BR") : "—";
  const perSource = status?.perSource || {};
  const testedSources = available.sources.filter(s => perSource[s.id]);
  const overall = OVERALL[status?.overall] || { label: "— nunca executado", color: "var(--color-text-secondary)" };

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <h2 style={{ fontSize: 18, fontWeight: 500 }}>ScrapTester</h2>
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 4 }}>
          Puxa uma amostra de produtos de cada loja no intervalo configurado e confere, campo a campo,
          o que o scraper está conseguindo extrair. O resultado é enviado nas notificações de admin.
        </div>
      </div>

      {error && (
        <div style={{ background: "#FCEBEB", color: "#A32D2D", padding: "10px 12px", borderRadius: 8, fontSize: 13, marginBottom: 14 }}>
          {error}
        </div>
      )}

      {/* Status geral */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10, marginBottom: 18 }}>
        <StatBox
          label="Resultado"
          value={status?.canceling ? "✕ Cancelando..." : (status?.running ? "⟳ Testando..." : overall.label)}
          color={status?.running ? PRIMARY : overall.color}
        />
        <StatBox label="Último teste" value={fmtDate(status?.lastRun)} sub={status?.lastDuration ? `${(status.lastDuration / 1000).toFixed(1)}s` : null} />
        <StatBox label="Próximo teste" value={config.enabled ? fmtDate(status?.nextRunAt) : "—"} />
        <StatBox label="Amostra" value={status?.sampleSize ? `${status.sampleSize} por loja` : "—"} sub={status?.categoryLabel || null} />
      </div>

      {/* Tabela campo × loja */}
      <div style={cardStyle}>
        <div style={{ fontWeight: 500, marginBottom: 4 }}>Cobertura dos campos</div>
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 12 }}>
          Quantos produtos da amostra vieram com cada informação. Vermelho ou amarelo = abaixo do mínimo
          esperado, ou seja, o scraper daquela loja provavelmente precisa ser atualizado.
          O número editável é o mínimo aceitável (%).
        </div>

        {testedSources.length === 0 ? (
          <div style={{ textAlign: "center", padding: 30, color: "var(--color-text-secondary)", fontSize: 13 }}>
            Nenhum teste executado ainda. Clique em "Testar agora".
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, minWidth: 480 }}>
              <thead>
                <tr>
                  <th style={thStyle}>Campo</th>
                  {testedSources.map(s => (
                    <th key={s.id} style={{ ...thStyle, textAlign: "center" }}>
                      {s.label}
                      <div style={{ fontWeight: 400, fontSize: 10, color: "var(--color-text-secondary)" }}>
                        {perSource[s.id].ok ? `${perSource[s.id].sampled} produtos` : "falhou"}
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {fieldSpecs.map(spec => (
                  <tr key={spec.key}>
                    <td style={{ ...tdStyle, fontWeight: 500 }}>
                      {spec.label}
                      {spec.critical && <span title="Campo essencial" style={{ color: "#A32D2D", marginLeft: 4 }}>*</span>}
                    </td>
                    {testedSources.map(s => {
                      const r = perSource[s.id];
                      if (!spec.applies.includes(s.id)) {
                        return <td key={s.id} style={{ ...tdStyle, textAlign: "center", color: "var(--color-text-secondary)" }}>—</td>;
                      }
                      const f = r.fields?.[spec.key];
                      if (!f) {
                        return <td key={s.id} style={{ ...tdStyle, textAlign: "center", background: CELL.fail.bg, color: CELL.fail.fg }}>sem dados</td>;
                      }
                      const cell = CELL[f.status] || CELL.ok;
                      return (
                        <td key={s.id} style={{ ...tdStyle, textAlign: "center", background: cell.bg, color: cell.fg }}>
                          <div style={{ fontWeight: 500 }}>{f.pct}%</div>
                          <div style={{ fontSize: 10 }}>{f.present}/{f.total}</div>
                          <input
                            type="number" min={0} max={100}
                            title={`Mínimo aceitável para ${spec.label} na ${s.label}`}
                            value={config.thresholds?.[`${s.id}.${spec.key}`] ?? f.minPct}
                            onChange={e => setThreshold(s.id, spec.key, e.target.value)}
                            style={{ width: 52, marginTop: 4, padding: "2px 4px", fontSize: 10, textAlign: "center", borderRadius: 5, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-primary)" }}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Lojas que falharam por completo */}
        {testedSources.filter(s => !perSource[s.id].ok).map(s => (
          <div key={s.id} style={{ marginTop: 10, background: "#FCEBEB", color: "#A32D2D", padding: "8px 10px", borderRadius: 8, fontSize: 12 }}>
            <strong>{s.label}:</strong> {perSource[s.id].error}
          </div>
        ))}

        {/* Amostra crua pra conferir na mão */}
        {testedSources.some(s => (perSource[s.id].sample || []).length > 0) && (
          <details style={{ marginTop: 14 }}>
            <summary style={{ cursor: "pointer", fontSize: 12, color: "var(--color-text-secondary)" }}>
              Ver os produtos da amostra
            </summary>
            <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
              {testedSources.map(s => (perSource[s.id].sample || []).length > 0 && (
                <div key={s.id}>
                  <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 4 }}>{s.label}</div>
                  <pre style={{ fontSize: 10, background: "var(--color-background-secondary)", padding: 10, borderRadius: 8, overflowX: "auto", margin: 0 }}>
                    {JSON.stringify(perSource[s.id].sample, null, 2)}
                  </pre>
                </div>
              ))}
            </div>
          </details>
        )}
      </div>

      {/* Configuração */}
      <div style={cardStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <div>
            <div style={{ fontWeight: 500 }}>Teste automático</div>
            <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>Roda sozinho no intervalo configurado e notifica o resultado</div>
          </div>
          <Toggle value={config.enabled} onChange={v => save({ enabled: v })} />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12, marginBottom: 14 }}>
          <Field label="Intervalo (minutos)">
            <input
              type="number" min={15} max={10080}
              value={config.intervalMinutes ?? ""}
              onChange={e => updateConfig({ intervalMinutes: e.target.value === "" ? "" : parseInt(e.target.value) })}
              style={inputStyle}
            />
            <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 4 }}>
              {config.intervalMinutes >= 60 ? `≈ ${Math.round(config.intervalMinutes / 60)}h` : " "}
            </div>
          </Field>
          <Field label="Produtos por loja">
            <input
              type="number" min={3} max={50}
              value={config.sampleSize ?? ""}
              onChange={e => updateConfig({ sampleSize: e.target.value === "" ? "" : parseInt(e.target.value) })}
              style={inputStyle}
            />
          </Field>
          <Field label="Categoria testada">
            <select value={config.category} onChange={e => updateConfig({ category: e.target.value })} style={inputStyle}>
              {available.categories.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </Field>
        </div>

        <Field label="Lojas testadas">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {available.sources.map(s => {
              const active = (config.sources || []).includes(s.id);
              return (
                <div key={s.id} onClick={() => toggleSource(s.id)}
                  style={{ padding: "6px 12px", borderRadius: 7, border: `0.5px solid ${active ? PRIMARY : "var(--color-border-tertiary)"}`, background: active ? PRIMARY_LIGHT : "transparent", color: active ? PRIMARY_DARK : "var(--color-text-secondary)", fontSize: 12, cursor: "pointer", fontWeight: active ? 500 : 400 }}>
                  {active ? "✓ " : ""}{s.label}
                </div>
              );
            })}
          </div>
        </Field>

        <div style={{ display: "flex", gap: 8, marginTop: 4, flexWrap: "wrap" }}>
          <button onClick={() => save()} disabled={saving} style={{ padding: "8px 16px", borderRadius: 8, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500, opacity: saving ? 0.6 : 1 }}>
            {saving ? "Salvando..." : "Salvar configuração"}
          </button>
          <button onClick={runNow} disabled={running} style={{ padding: "8px 16px", borderRadius: 8, background: running ? "var(--color-border-secondary)" : "#fff", color: running ? "var(--color-text-secondary)" : PRIMARY_DARK, border: `0.5px solid ${PRIMARY}`, fontSize: 13, cursor: running ? "not-allowed" : "pointer", fontWeight: 500 }}>
            {running ? "⟳ Testando..." : "▶ Testar agora"}
          </button>
          {running && (() => {
            const isCanceling = canceling || status?.canceling;
            return (
              <button onClick={cancelRun} disabled={isCanceling} style={{ padding: "8px 16px", borderRadius: 8, background: "#fff", color: isCanceling ? "var(--color-text-secondary)" : "#A32D2D", border: `0.5px solid ${isCanceling ? "var(--color-border-secondary)" : "#A32D2D"}`, fontSize: 13, cursor: isCanceling ? "not-allowed" : "pointer", fontWeight: 500 }}>
                {isCanceling ? "Cancelando..." : "✕ Cancelar"}
              </button>
            );
          })()}
          {savedMsg && <span style={{ alignSelf: "center", fontSize: 12, color: PRIMARY_DARK }}>{savedMsg}</span>}
        </div>
        <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 10 }}>
          O teste faz um scrape real e pode levar alguns minutos. Nada é gravado no catálogo.
        </div>
      </div>

      {/* Histórico */}
      <div style={cardStyle}>
        <div style={{ fontWeight: 500, marginBottom: 4 }}>Histórico</div>
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 12 }}>
          Últimas {history.length} execuções — ajuda a ver desde quando um campo parou de vir.
        </div>
        {history.length === 0 ? (
          <div style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>Nenhuma execução registrada.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {history.map((h, i) => {
              const ov = OVERALL[h.overall] || { label: h.overall, color: "var(--color-text-secondary)" };
              return (
                <div key={h.at || i} style={{ padding: "8px 10px", borderRadius: 8, background: "var(--color-background-secondary)", fontSize: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                    <span>{fmtDate(h.at)}</span>
                    <span style={{ color: ov.color, fontWeight: 500 }}>{ov.label}</span>
                  </div>
                  <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 3 }}>
                    {Object.entries(h.perSource || {}).map(([src, r]) => (
                      <span key={src} style={{ marginRight: 10 }}>
                        {src}: {r.ok ? (r.missing?.length ? `faltou ${r.missing.join(", ")}` : "ok") : (r.error || "falhou")}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

const cardStyle = { background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16, marginBottom: 18 };
const inputStyle = { width: "100%", padding: "7px 10px", borderRadius: 7, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13, boxSizing: "border-box" };
const thStyle = { textAlign: "left", padding: "6px 8px", borderBottom: "0.5px solid var(--color-border-tertiary)", fontSize: 11, color: "var(--color-text-secondary)", fontWeight: 500 };
const tdStyle = { padding: "6px 8px", borderBottom: "0.5px solid var(--color-border-tertiary)" };

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
