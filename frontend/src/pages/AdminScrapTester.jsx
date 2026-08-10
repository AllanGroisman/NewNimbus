import { useState, useEffect, useCallback } from "react";
import { PRIMARY, PRIMARY_DARK, PRIMARY_LIGHT } from "../data/constants";
import Toggle from "../components/ui/Toggle";
import ScheduleField from "../components/ui/ScheduleField";
import {
  adminScrapTesterConfig,
  adminScrapTesterSave,
  adminScrapTesterStatus,
  adminScrapTesterRun,
  adminScrapTesterCancel,
  adminScrapTesterHistory,
  adminScrapTesterLink,
  errText,
} from "../data/api";

const STATUS_POLL_MS = 5000;

const OVERALL = {
  ok:   { label: "✅ Tudo certo", color: PRIMARY_DARK },
  warn: { label: "⚠️ Campos faltando", color: "var(--warn-text)" },
  fail: { label: "❌ Scraping quebrado", color: "var(--danger-text)" },
};

// Mesmo semáforo, texto adaptado pro teste de um link só.
const LINK_OVERALL = {
  ok:   { label: "✅ Veio tudo", color: PRIMARY_DARK },
  warn: { label: "⚠️ Faltou alguma informação", color: "var(--warn-text)" },
  fail: { label: "❌ Faltou informação essencial", color: "var(--danger-text)" },
};

const CELL = {
  ok:   { bg: "var(--color-background-secondary)", fg: "var(--color-text-primary)" },
  warn: { bg: "#FCF3E4", fg: "var(--warn-text)" },
  fail: { bg: "var(--danger-bg)", fg: "var(--danger-text)" },
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
  // Teste avulso de um link — independente do teste de amostra
  const [linkUrl, setLinkUrl] = useState("");
  const [linkRunning, setLinkRunning] = useState(false);
  const [linkResult, setLinkResult] = useState(null);
  const [linkError, setLinkError] = useState(null);

  const refreshConfig = useCallback(async () => {
    try {
      const r = await adminScrapTesterConfig();
      setConfig(r.config);
      setAvailable(r.available);
      setFieldSpecs(r.fieldSpecs || []);
    } catch (err) {
      setError(errText(err, "Não foi possível concluir a ação no testador."));
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
      setError(errText(err, "Não foi possível concluir a ação no testador."));
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
      setError(errText(err, "Não foi possível concluir a ação no testador."));
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
      setError(errText(err, "Não foi possível concluir a ação no testador."));
    }
  }

  async function testLink() {
    const url = linkUrl.trim();
    if (!url) return;
    setLinkRunning(true);
    setLinkError(null);
    setLinkResult(null);
    try {
      const r = await adminScrapTesterLink(url);
      setLinkResult(r.result);
    } catch (err) {
      setLinkError(errText(err, "Não foi possível testar esse link."));
    } finally {
      setLinkRunning(false);
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
  // A linha "Qualidade da foto" só faz sentido com a conferência de fotos ligada.
  const visibleSpecs = fieldSpecs.filter(spec => config.checkImages !== false || !spec.needsImages);
  const statsSources = testedSources.filter(s => perSource[s.id].imageStats?.checked);

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <h2 style={{ fontSize: 18, fontWeight: 500 }}>ScrapTester</h2>
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 4 }}>
          Puxa uma amostra de produtos de cada fonte no intervalo configurado e confere, campo a campo,
          o que o scraper está conseguindo extrair — inclusive a resolução das fotos.
          O resultado é enviado nas notificações de admin.
        </div>
      </div>

      {error && (
        <div style={{ background: "var(--danger-bg)", color: "var(--danger-text)", padding: "10px 12px", borderRadius: 8, fontSize: 13, marginBottom: 14 }}>
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
        <StatBox label="Amostra" value={status?.sampleSize ? `${status.sampleSize} por fonte` : "—"} sub={status?.categoryLabel || null} />
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
                {visibleSpecs.map(spec => (
                  <tr key={spec.key}>
                    <td style={{ ...tdStyle, fontWeight: 500 }}>
                      {spec.label}
                      {spec.critical && <span title="Campo essencial" style={{ color: "var(--danger-text)", marginLeft: 4 }}>*</span>}
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

        {/* Fontes que falharam por completo */}
        {testedSources.filter(s => !perSource[s.id].ok).map(s => (
          <div key={s.id} style={{ marginTop: 10, background: "var(--danger-bg)", color: "var(--danger-text)", padding: "8px 10px", borderRadius: 8, fontSize: 12 }}>
            <strong>{s.label}:</strong> {perSource[s.id].error}
          </div>
        ))}

        {/* Qualidade das fotos: resolução medida baixando cada imagem da amostra */}
        {statsSources.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontWeight: 500, fontSize: 13, marginBottom: 6 }}>Qualidade das fotos</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {statsSources.map(s => {
                const st = perSource[s.id].imageStats;
                const ruim = st.small + st.broken;
                return (
                  <div key={s.id} style={{ background: ruim ? "#FCF3E4" : "var(--color-background-secondary)", borderRadius: 8, padding: "8px 10px", fontSize: 12 }}>
                    <div>
                      <strong>{s.label}:</strong> {st.good} de {st.checked} fotos boas
                      {st.small > 0 && ` · ${st.small} pequena${st.small > 1 ? "s" : ""}`}
                      {st.broken > 0 && ` · ${st.broken} que não abriu${st.broken > 1 ? "ram" : ""}`}
                      <span style={{ color: "var(--color-text-secondary)" }}> (mínimo {st.minPx}px)</span>
                    </div>
                    {(st.worst || []).length > 0 && (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 8 }}>
                        {st.worst.map((w, i) => (
                          <a key={i} href={w.link || w.img || "#"} target="_blank" rel="noreferrer"
                            style={{ display: "flex", gap: 6, alignItems: "center", textDecoration: "none", color: "inherit", maxWidth: 260 }}>
                            {w.img && <img src={w.img} alt="" style={{ width: 34, height: 34, objectFit: "cover", borderRadius: 6, background: "var(--color-background-primary)" }} />}
                            <span style={{ fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {w.width ? `${w.width}×${w.height}px` : (w.error || "não abriu")}
                              <div style={{ color: "var(--color-text-secondary)", overflow: "hidden", textOverflow: "ellipsis" }}>{w.name || ""}</div>
                            </span>
                          </a>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

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

      {/* Teste de um link avulso — separado do teste de amostra */}
      <div style={cardStyle}>
        <div style={{ fontWeight: 500, marginBottom: 4 }}>Testar um link</div>
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 12 }}>
          Cole o link de um produto (Mercado Livre, Amazon ou Shopee) pra ver na hora o que o scraper
          consegue tirar dele — inclusive o tamanho real da foto. Não mexe no teste de amostra e não
          grava nada no catálogo.
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            type="url"
            placeholder="https://..."
            value={linkUrl}
            onChange={e => setLinkUrl(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && !linkRunning) testLink(); }}
            style={{ ...inputStyle, flex: "1 1 260px", width: "auto" }}
          />
          <button onClick={testLink} disabled={linkRunning || !linkUrl.trim()}
            style={{ padding: "8px 16px", borderRadius: 8, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, fontWeight: 500, cursor: linkRunning || !linkUrl.trim() ? "not-allowed" : "pointer", opacity: linkRunning || !linkUrl.trim() ? 0.6 : 1 }}>
            {linkRunning ? "⟳ Testando..." : "Testar link"}
          </button>
        </div>

        {linkError && (
          <div style={{ marginTop: 10, background: "var(--danger-bg)", color: "var(--danger-text)", padding: "8px 10px", borderRadius: 8, fontSize: 12 }}>
            {linkError}
          </div>
        )}

        {linkResult && (() => {
          const ov = LINK_OVERALL[linkResult.status] || { label: linkResult.status, color: "var(--color-text-secondary)" };
          return (
            <div style={{ marginTop: 14 }}>
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
                <span style={{ fontWeight: 500, color: ov.color }}>{ov.label}</span>
                <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
                  {linkResult.sourceLabel || linkResult.store || "loja desconhecida"} · {((linkResult.durationMs || 0) / 1000).toFixed(1)}s
                </span>
              </div>

              <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
                {linkResult.product?.img && (
                  <a href={linkResult.product.img} target="_blank" rel="noreferrer">
                    <img src={linkResult.product.img} alt="" style={{ width: 110, height: 110, objectFit: "contain", borderRadius: 8, background: "var(--color-background-secondary)" }} />
                  </a>
                )}
                <div style={{ flex: "1 1 260px", minWidth: 240 }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                    <tbody>
                      {(linkResult.checks || []).map(c => (
                        <tr key={c.key}>
                          <td style={{ ...tdStyle, width: 130, color: "var(--color-text-secondary)" }}>
                            {c.label}{c.critical && <span style={{ color: "var(--danger-text)", marginLeft: 3 }}>*</span>}
                          </td>
                          <td style={{ ...tdStyle, color: c.ok ? "var(--color-text-primary)" : (c.critical ? "var(--danger-text)" : "var(--warn-text)") }}>
                            {c.ok ? "✓ " : "✕ "}
                            {c.value === null || c.value === "" ? "não veio" : String(c.value).slice(0, 90)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {linkResult.image && (
                    <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 6 }}>
                      Foto: {linkResult.image.ok
                        ? `${linkResult.image.width}×${linkResult.image.height}px · ${linkResult.image.bytes ? Math.round(linkResult.image.bytes / 1024) + " KB" : "tamanho desconhecido"} · mínimo ${linkResult.imageMinPx}px`
                        : `não deu pra medir (${linkResult.image.error})`}
                    </div>
                  )}
                </div>
              </div>

              <details style={{ marginTop: 12 }}>
                <summary style={{ cursor: "pointer", fontSize: 12, color: "var(--color-text-secondary)" }}>Ver os dados crus</summary>
                <pre style={{ fontSize: 10, background: "var(--color-background-secondary)", padding: 10, borderRadius: 8, overflowX: "auto", marginTop: 8 }}>
                  {JSON.stringify(linkResult.product, null, 2)}
                </pre>
              </details>
            </div>
          );
        })()}
      </div>

      {/* Configuração */}
      <div style={cardStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <div>
            <div style={{ fontWeight: 500 }}>Teste automático</div>
            <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
              {config.scheduleMode === "times" ? "Roda sozinho nos horários escolhidos e notifica o resultado" : "Roda sozinho no intervalo configurado e notifica o resultado"}
            </div>
          </div>
          <Toggle value={config.enabled} onChange={v => save({ enabled: v })} />
        </div>

        <div style={{ marginBottom: 14 }}>
          <ScheduleField
            mode={config.scheduleMode}
            intervalMinutes={config.intervalMinutes}
            times={config.times}
            minInterval={15}
            onChange={updateConfig}
          />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12, marginBottom: 14 }}>
          <Field label="Produtos por fonte">
            <input
              type="number" min={3} max={50}
              value={config.sampleSize ?? ""}
              onChange={e => updateConfig({ sampleSize: e.target.value === "" ? "" : parseInt(e.target.value) })}
              style={inputStyle}
            />
          </Field>
          <Field label="Resolução mínima da foto (px)">
            <input
              type="number" min={100} max={4000} step={50}
              disabled={config.checkImages === false}
              value={config.imageMinPx ?? ""}
              onChange={e => updateConfig({ imageMinPx: e.target.value === "" ? "" : parseInt(e.target.value) })}
              style={{ ...inputStyle, opacity: config.checkImages === false ? 0.5 : 1 }}
            />
            <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 4 }}>
              Largura e altura mínimas
            </div>
          </Field>
          <Field label="Categoria testada">
            <select value={config.category} onChange={e => updateConfig({ category: e.target.value })} style={inputStyle}>
              {available.categories.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </Field>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <div>
            <div style={{ fontWeight: 500 }}>Conferir a qualidade das fotos</div>
            <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
              Baixa cada foto da amostra e mede a resolução de verdade — pega miniatura ruim e foto quebrada.
              Deixa o teste alguns segundos mais lento.
            </div>
          </div>
          <Toggle value={config.checkImages !== false} onChange={v => save({ checkImages: v })} />
        </div>

        <Field label="Fontes testadas">
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
              <button onClick={cancelRun} disabled={isCanceling} style={{ padding: "8px 16px", borderRadius: 8, background: "#fff", color: isCanceling ? "var(--color-text-secondary)" : "var(--danger-text)", border: `0.5px solid ${isCanceling ? "var(--color-border-secondary)" : "var(--danger-text)"}`, fontSize: 13, cursor: isCanceling ? "not-allowed" : "pointer", fontWeight: 500 }}>
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
