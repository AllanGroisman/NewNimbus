import { useState, useEffect, useCallback } from "react";
import { PRIMARY, PRIMARY_DARK, PRIMARY_LIGHT, formatPrice } from "../data/constants";
import Badge from "../components/ui/Badge";
import Toggle from "../components/ui/Toggle";
import Modal from "../components/ui/Modal";
import ScheduleField from "../components/ui/ScheduleField";
import Pagination from "../components/ui/Pagination";
import { useLembrado } from "../data/useLembrado";
import Barra from "../components/admin/Barra";
import Numero from "../components/admin/Numero";
import { duracao } from "../data/andamentoColheita";
import {
  adminScraperConfig,
  adminSaveScraperConfig,
  adminRunScraper,
  adminCancelScraper,
  adminPauseScraper,
  adminScraperStatus,
  adminCatalog,
  adminClearCatalog,
  errText,
} from "../data/api";

const STATUS_POLL_MS = 5000;
const STATUS_POLL_RUNNING_MS = 2000;   // mais fino enquanto roda — a barra anda por passo

// Filtro guardado de uma versão antiga da tela não pode quebrá-la.
function sanearCatFilter(v) {
  if (!v || typeof v !== "object") return null;
  const s = (x, p = "") => (typeof x === "string" ? x : p);
  return { category: s(v.category), source: s(v.source), q: s(v.q), sortBy: s(v.sortBy, "lastSeen_desc") || "lastSeen_desc" };
}

export default function PageAdminScraper() {
  const [available, setAvailable] = useState({ categories: [], sources: [] });
  const [config, setConfig] = useState(null);
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [error, setError] = useState(null);
  const [savedMsg, setSavedMsg] = useState(null);

  // Catálogo (visualização)
  const [catItems, setCatItems] = useState([]);
  const [catTotal, setCatTotal] = useState(0);
  const [catStats, setCatStats] = useState(null);
  const [catPage, setCatPage] = useState(1);
  // Filtros e ordem do catálogo lembrados no servidor, iguais para todos os admins.
  const [catFilter, setCatFilter] = useLembrado("admin.scraper.catalogo", { category: "", source: "", q: "", sortBy: "lastSeen_desc" }, sanearCatFilter);
  const [catLoading, setCatLoading] = useState(false);
  const [clearing, setClearing] = useState(false);
  // Confirmação de "Limpar catálogo" — antes era um window.confirm do navegador.
  const [confirmClear, setConfirmClear] = useState(false);

  const refreshConfig = useCallback(async () => {
    try {
      const r = await adminScraperConfig();
      setConfig(r.config);
      setAvailable(r.available);
    } catch (err) {
      setError(errText(err, "Não foi possível concluir a ação no scraping."));
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
      if (r.stats) setCatStats(r.stats);
    } catch (err) {
      setError(errText(err, "Não foi possível concluir a ação no scraping."));
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

  // Polling de status (mais rápido enquanto rodando)
  const isRunning = !!status?.running;
  useEffect(() => {
    const id = setInterval(refreshStatus, isRunning ? STATUS_POLL_RUNNING_MS : STATUS_POLL_MS);
    return () => clearInterval(id);
  }, [refreshStatus, isRunning]);

  // Quando termina de rodar, recarrega catálogo
  useEffect(() => {
    if (status && !status.running && running) {
      setRunning(false);
      setCanceling(false);
      setPausing(false);
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
      setError(errText(err, "Não foi possível concluir a ação no scraping."));
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
      setError(errText(err, "Não foi possível concluir a ação no scraping."));
    } finally {
      setSaving(false);
    }
  }

  async function runNow({ resume = false } = {}) {
    setError(null);
    try {
      await adminRunScraper({ resume });
      setRunning(true);
      await refreshStatus();
    } catch (err) {
      setError(errText(err, "Não foi possível concluir a ação no scraping."));
    }
  }

  async function cancelRun() {
    setError(null);
    setCanceling(true);
    try {
      await adminCancelScraper();
      await refreshStatus();
    } catch (err) {
      setCanceling(false);
      setError(errText(err, "Não foi possível concluir a ação no scraping."));
    }
  }

  async function pauseRun() {
    setError(null);
    setPausing(true);
    try {
      await adminPauseScraper();
      await refreshStatus();
    } catch (err) {
      setPausing(false);
      setError(errText(err, "Não foi possível concluir a ação no scraping."));
    }
  }

  // Descarta o run pausado (o backend reaproveita o /cancel quando nada roda).
  async function discardPaused() {
    setError(null);
    try {
      await adminCancelScraper();
      await refreshStatus();
    } catch (err) {
      setError(errText(err, "Não foi possível concluir a ação no scraping."));
    }
  }

  async function clearCatalog() {
    setConfirmClear(false);
    setError(null);
    setClearing(true);
    try {
      await adminClearCatalog();
      setCatPage(1);
      await refreshCatalog();
    } catch (err) {
      setError(errText(err, "Não foi possível concluir a ação no scraping."));
    } finally {
      setClearing(false);
    }
  }

  if (loading || !config) {
    return <div style={{ padding: 40, textAlign: "center", color: "var(--color-text-secondary)" }}>Carregando...</div>;
  }

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
        <div style={{ background: "var(--danger-bg)", color: "var(--danger-text)", padding: "10px 12px", borderRadius: 8, fontSize: 13, marginBottom: 14 }}>
          {error}
        </div>
      )}

      {/* Status / stats — TODOS os campos lidos de `status` (snapshot do backend),
          nunca de `config` local. Senão dessincroniza durante toggle. */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10, marginBottom: 18 }}>
        <StatBox
          label="Status"
          value={status?.canceling ? "✕ Cancelando..." : status?.pausing ? "⏸ Pausando..." : status?.running ? "⟳ Rodando" : status?.paused ? "⏸ Pausado" : (status?.config?.enabled ? "Agendado" : "Desligado")}
          color={status?.canceling ? "var(--danger-text)" : (status?.pausing || status?.paused) ? "var(--warn-text)" : status?.running ? PRIMARY : (status?.config?.enabled ? PRIMARY_DARK : "var(--warn-text)")}
        />
        <StatBox label="Último run" value={fmtDate(status?.lastRun)} sub={status?.lastDuration ? `${(status.lastDuration / 1000).toFixed(1)}s` : null} />
        <StatBox label="Próximo run" value={status?.config?.enabled ? fmtDate(status?.nextRunAt) : "—"} />
        <StatBox label="Produtos no catálogo" value={lastResult?.total ?? "—"} />
      </div>

      <ScraperProgress status={status} available={available} />

      {/* Cards por loja — total + quebra por categoria (lidos de catStats do catálogo) */}
      {available.sources.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 10, marginBottom: 18 }}>
          {available.sources.map(s => {
            const total = catStats?.byStore?.[s.id] ?? 0;
            const perCat = catStats?.byStoreCategory?.[s.id] || {};
            const rows = available.categories
              .map(c => ({ label: c.label, count: perCat[c.id] || 0 }))
              .filter(r => r.count > 0)
              .sort((a, b) => b.count - a.count);
            return (
              <div key={s.id} style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
                  <div style={{ fontWeight: 500 }}>{s.label}</div>
                  <div style={{ fontSize: 20, fontWeight: 600, color: PRIMARY_DARK }}>{total}</div>
                </div>
                {rows.length === 0 ? (
                  <div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>Nenhum produto ainda</div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {rows.map(r => (
                      <div key={r.label} style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                        <span style={{ color: "var(--color-text-secondary)" }}>{r.label}</span>
                        <span style={{ fontWeight: 500 }}>{r.count}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {lastResult && (
        <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 14, marginBottom: 18 }}>
          <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8 }}>
            Resultado do último scraping
            {lastResult.cancelled && <span style={{ fontSize: 11, fontWeight: 400, color: "var(--danger-text)", marginLeft: 8 }}>(cancelado — incompleto)</span>}
            {lastResult.paused && <span style={{ fontSize: 11, fontWeight: 400, color: "var(--warn-text)", marginLeft: 8 }}>(pausado — parcial)</span>}
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
            <Badge color="green">+{lastResult.inserted} novos</Badge>
            <Badge color="blue">{lastResult.updated} atualizados</Badge>
            {lastResult.purged != null ? (
              <>
                {lastResult.prunedOld > 0 && <Badge color="amber">-{lastResult.prunedOld} sem ser vistos há {status?.config?.pruneAfterDays ?? 30}+ dias</Badge>}
                {lastResult.purged > 0 && <Badge color="amber">-{lastResult.purged} de dias anteriores</Badge>}
                {lastResult.keptCoupon > 0 && <Badge color="blue">{lastResult.keptCoupon} de cupons mantidos</Badge>}
              </>
            ) : (
              lastResult.pruned > 0 && <Badge color="amber">-{lastResult.pruned} antigos limpos</Badge>
            )}
          </div>
          {lastResult.perCategory && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 6 }}>
              {Object.entries(lastResult.perCategory).map(([tag, r]) => (
                <div key={tag} style={{ fontSize: 11, padding: "6px 10px", borderRadius: 6, background: r.ok ? "var(--color-background-secondary)" : "var(--danger-bg)", color: r.ok ? "var(--color-text-primary)" : "var(--danger-text)" }}>
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
            <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
              {config.scheduleMode === "times" ? "Roda nos horários escolhidos" : "Roda em loop no intervalo configurado"}
            </div>
          </div>
          <Toggle value={config.enabled} onChange={v => saveImmediate({ enabled: v })} />
        </div>

        <div style={{ marginBottom: 14 }}>
          <ScheduleField
            mode={config.scheduleMode}
            intervalMinutes={config.intervalMinutes}
            times={config.times}
            minInterval={5}
            onChange={updateConfig}
          />
        </div>

        <Field label="Limite de produtos por loja (aplicado a cada categoria daquela loja)">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
            {available.sources.map(s => (
              <div key={s.id}>
                <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 4 }}>{s.label}</div>
                <input
                  type="number" min={10} max={1000}
                  value={config.limitsBySource?.[s.id] ?? ""}
                  onChange={e => updateConfig({
                    limitsBySource: { ...config.limitsBySource, [s.id]: e.target.value === "" ? "" : parseInt(e.target.value) },
                  })}
                  style={inputStyle}
                />
              </div>
            ))}
          </div>
        </Field>

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
            value={config.pruneAfterDays ?? ""}
            onChange={e => updateConfig({ pruneAfterDays: e.target.value === "" ? "" : parseInt(e.target.value) })}
            style={{ ...inputStyle, maxWidth: 120 }}
          />
        </Field>

        <div style={{ display: "flex", gap: 8, marginTop: 4, flexWrap: "wrap" }}>
          <button onClick={save} disabled={saving} style={{ padding: "8px 16px", borderRadius: 8, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500, opacity: saving ? 0.6 : 1 }}>
            {saving ? "Salvando..." : "Salvar configuração"}
          </button>
          {!status?.running && status?.paused?.resumable && (
            <button onClick={() => runNow({ resume: true })} style={{ padding: "8px 16px", borderRadius: 8, background: "#fff", color: PRIMARY_DARK, border: `0.5px solid ${PRIMARY}`, fontSize: 13, cursor: "pointer", fontWeight: 500 }}>
              ▶ Retomar
            </button>
          )}
          <button onClick={() => runNow()} disabled={status?.running} style={{ padding: "8px 16px", borderRadius: 8, background: status?.running ? "var(--color-border-secondary)" : "#fff", color: status?.running ? "var(--color-text-secondary)" : PRIMARY_DARK, border: `0.5px solid ${PRIMARY}`, fontSize: 13, cursor: status?.running ? "not-allowed" : "pointer", fontWeight: 500 }}>
            {status?.running ? "⟳ Rodando..." : (status?.paused ? "↻ Recomeçar do zero" : "▶ Rodar agora")}
          </button>
          {status?.running && (() => {
            const isCanceling = canceling || status?.canceling;
            const isPausing = pausing || status?.pausing;
            return (
              <>
                <button onClick={pauseRun} disabled={isPausing || isCanceling} style={{ padding: "8px 16px", borderRadius: 8, background: "#fff", color: (isPausing || isCanceling) ? "var(--color-text-secondary)" : "var(--warn-text)", border: `0.5px solid ${(isPausing || isCanceling) ? "var(--color-border-secondary)" : "var(--warn-text)"}`, fontSize: 13, cursor: (isPausing || isCanceling) ? "not-allowed" : "pointer", fontWeight: 500 }}>
                  {isPausing ? "Pausando..." : "⏸ Pausar"}
                </button>
                <button onClick={cancelRun} disabled={isCanceling} style={{ padding: "8px 16px", borderRadius: 8, background: "#fff", color: isCanceling ? "var(--color-text-secondary)" : "var(--danger-text)", border: `0.5px solid ${isCanceling ? "var(--color-border-secondary)" : "var(--danger-text)"}`, fontSize: 13, cursor: isCanceling ? "not-allowed" : "pointer", fontWeight: 500 }}>
                  {isCanceling ? "Cancelando..." : "✕ Cancelar scraping"}
                </button>
              </>
            );
          })()}
          {!status?.running && status?.paused && (
            <button onClick={discardPaused} style={{ padding: "8px 16px", borderRadius: 8, background: "#fff", color: "var(--danger-text)", border: "0.5px solid var(--danger-text)", fontSize: 13, cursor: "pointer", fontWeight: 500 }}>
              ✕ Descartar pausado
            </button>
          )}
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
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={refreshCatalog} disabled={catLoading} style={{ padding: "6px 12px", borderRadius: 7, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 12, cursor: "pointer" }}>
              {catLoading ? "⟳" : "⟳ Atualizar"}
            </button>
            <button onClick={() => setConfirmClear(true)} disabled={clearing || catTotal === 0} style={{ padding: "6px 12px", borderRadius: 7, border: "0.5px solid var(--danger-text)", background: "transparent", color: "var(--danger-text)", fontSize: 12, cursor: clearing || catTotal === 0 ? "not-allowed" : "pointer", opacity: clearing || catTotal === 0 ? 0.5 : 1 }}>
              {clearing ? "Apagando..." : "🗑 Apagar todos"}
            </button>
          </div>
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

        <Pagination page={catPage} totalPages={Math.ceil(catTotal / 50)} onChange={setCatPage} disabled={catLoading} />
      </div>

      {confirmClear && (
        <Modal title="Apagar todo o catálogo?" onClose={() => setConfirmClear(false)} danger>
          <p style={{ fontSize: 13, marginBottom: 16, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
            Todos os <strong style={{ color: "var(--color-text-primary)" }}>{catTotal}</strong> produtos do catálogo central serão apagados, junto com o registro dos produtos já sondados no checkout (o lote volta a sondar todos). As campanhas ficam sem produtos até o próximo scraping. Esta ação não pode ser desfeita.
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={() => setConfirmClear(false)} style={{ padding: "8px 16px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: "pointer" }}>Cancelar</button>
            <button onClick={clearCatalog} style={{ padding: "8px 16px", borderRadius: 8, background: "#E24B4A", color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500 }}>Apagar tudo</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

const inputStyle ={ width: "100%", padding: "7px 10px", borderRadius: 7, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13, boxSizing: "border-box" };
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

// Andamento do scraping: rodando (barra por passo categoria × loja, passo atual,
// contagens e ETA) ou pausado (onde parou e se dá pra retomar).
function ScraperProgress({ status, available }) {
  const [agora, setAgora] = useState(() => Date.now());
  const p = status?.running ? status.progress : null;
  const paused = !status?.running ? status?.paused : null;
  const ativo = !!p;
  useEffect(() => {
    if (!ativo) return undefined;
    const id = setInterval(() => setAgora(Date.now()), 1000);
    return () => clearInterval(id);
  }, [ativo]);
  if (!p && !paused) return null;

  const box = { marginBottom: 18, padding: "12px 14px", borderRadius: 10, background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-tertiary)" };
  const muted = { fontSize: 12, color: "var(--color-text-secondary)" };

  if (paused) {
    return (
      <div style={{ ...box, background: "var(--warn-bg)", border: "0.5px solid var(--warn-border)" }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--warn-text)" }}>
          ⏸ {paused.interrupted ? "Scraping interrompido (backend reiniciou)" : "Scraping pausado"} em {paused.done} de {paused.total} passos
        </div>
        <Barra valor={paused.done} total={paused.total} rotulo={`Iniciado em ${new Date(paused.startedAt).toLocaleString("pt-BR")}`} />
        <div style={{ ...muted, marginTop: 6, lineHeight: 1.5 }}>
          {paused.resumable
            ? "Retome para continuar de onde parou — os passos já feitos não são refeitos. O próximo run agendado também retoma daqui."
            : "Esta pausa é de outro dia: o próximo run começa do zero para não misturar preços antigos."}
        </div>
      </div>
    );
  }

  const label = (list, id) => list.find(x => x.id === id)?.label || id;
  const decorrido = agora - new Date(p.sessionStartedAt).getTime();
  const eta = p.avgStepMs ? (p.total - p.done) * p.avgStepMs - (p.current ? agora - new Date(p.current.startedAt).getTime() : 0) : null;
  return (
    <div style={box}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "baseline" }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>
          {status.pausing ? "⏸ Pausando após o passo atual..." : status.canceling ? "✕ Cancelando após o passo atual..." : `⟳ Scraping${p.resumed ? " (retomado)" : ""}`}
        </div>
        <div style={{ ...muted, fontSize: 11, fontVariantNumeric: "tabular-nums" }}>
          rodando há {duracao(decorrido)}
          {eta != null && eta > 0 ? ` · faltam ~${duracao(eta)}` : ""}
        </div>
      </div>
      <Barra valor={p.done} total={p.total} rotulo={`Passos (categoria × loja): ${p.done} de ${p.total}`} />
      {p.current && (
        <div style={{ ...muted, marginTop: 6 }}>
          Agora: <b style={{ color: "var(--color-text-primary)" }}>{label(available.categories, p.current.cat)} · {label(available.sources, p.current.src)}</b>
          {" "}há {duracao(agora - new Date(p.current.startedAt).getTime())}
        </div>
      )}
      <div style={{ display: "flex", gap: 18, flexWrap: "wrap", fontSize: 12, marginTop: 10 }}>
        <Numero label="Novos" valor={p.inserted} />
        <Numero label="Atualizados" valor={p.updated} />
        <Numero label="Passos com falha" valor={p.failed} />
      </div>
    </div>
  );
}
