import { useState, useEffect, useCallback } from "react";
import { PRIMARY_DARK } from "../data/constants";
import { adminRepasseLogs, errText} from "../data/api";

const POLL_MS = 5000;

const selectStyle = {
  padding: "7px 10px",
  borderRadius: 8,
  border: "0.5px solid var(--color-border-tertiary)",
  background: "var(--color-background-secondary)",
  fontSize: 13,
};

const OUTCOME_LABEL = {
  queued: { label: "→ fila", color: "#1B7A43" },
  pending: { label: "→ pendente", color: PRIMARY_DARK },
  discarded: { label: "descartado", color: "var(--warn-text)" },
  duplicate: { label: "duplicata", color: "var(--color-text-secondary)" },
  cooldown: { label: "cooldown", color: "var(--color-text-secondary)" },
  error: { label: "erro", color: "var(--danger-text)" },
};

function Flag({ ok }) {
  if (ok === null || ok === undefined) return <span style={{ color: "var(--color-text-secondary)" }}>—</span>;
  return <span style={{ color: ok ? "#1B7A43" : "var(--danger-text)" }}>{ok ? "✓" : "✗"}</span>;
}

export default function PageAdminRepasse() {
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(50);
  const [filter, setFilter] = useState({ store: "", outcome: "" });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [auto, setAuto] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await adminRepasseLogs({ page, pageSize, ...filter });
      setItems(r.items || []);
      setTotal(r.total || 0);
      setError(null);
    } catch (err) {
      setError(errText(err, "Não foi possível carregar os repasses."));
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, filter]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (!auto) return;
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [auto, refresh]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 1100 }}>
      <div>
        <div style={{ fontWeight: 600, fontSize: 16 }}>Repasse — log de captura</div>
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
          Cada link visto num grupo líder de campanha de repasse, e o que aconteceu com ele: loja
          detectada, fonte habilitada na campanha, afiliado configurado, scrape do produto e destino final.
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <select value={filter.store} onChange={e => { setFilter(f => ({ ...f, store: e.target.value })); setPage(1); }} style={selectStyle}>
          <option value="">Todas as lojas</option>
          <option value="Mercado Livre">Mercado Livre</option>
          <option value="Amazon">Amazon</option>
          <option value="Shopee">Shopee</option>
        </select>
        <select value={filter.outcome} onChange={e => { setFilter(f => ({ ...f, outcome: e.target.value })); setPage(1); }} style={selectStyle}>
          <option value="">Todos os resultados</option>
          <option value="queued">Fila</option>
          <option value="pending">Pendente</option>
          <option value="discarded">Descartado</option>
          <option value="duplicate">Duplicata</option>
          <option value="cooldown">Cooldown</option>
          <option value="error">Erro</option>
        </select>
        <button onClick={refresh} disabled={loading} style={{ padding: "6px 12px", borderRadius: 7, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 12, cursor: "pointer" }}>
          {loading ? "⟳" : "⟳ Atualizar"}
        </button>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--color-text-secondary)" }}>
          <input type="checkbox" checked={auto} onChange={e => setAuto(e.target.checked)} />
          auto-atualizar
        </label>
        <div style={{ marginLeft: "auto", fontSize: 12, color: "var(--color-text-secondary)" }}>{total} registros</div>
      </div>

      {error && <div style={{ color: "var(--danger-text)", fontSize: 12 }}>{error}</div>}

      <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16 }}>
        {items.length === 0 ? (
          <div style={{ textAlign: "center", padding: 40, color: "var(--color-text-secondary)", fontSize: 13 }}>
            {loading ? "Carregando..." : "Nenhum link capturado ainda. Poste um link no grupo líder de uma campanha de repasse."}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {items.map(r => {
              const outcome = OUTCOME_LABEL[r.outcome] || { label: r.outcome, color: "var(--color-text-secondary)" };
              return (
                <div key={r.id} style={{ padding: "10px 12px", borderRadius: 8, background: "var(--color-background-secondary)", fontSize: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                    <div style={{ fontWeight: 500 }}>
                      {r.groupName || `campanha #${r.groupId}`} <span style={{ color: "var(--color-text-secondary)", fontWeight: 400 }}>({r.userEmail || r.userId})</span>
                    </div>
                    <div style={{ color: "var(--color-text-secondary)" }}>{new Date(r.createdAt).toLocaleString("pt-BR")}</div>
                  </div>
                  <div style={{ marginTop: 4, wordBreak: "break-all", color: "var(--color-text-secondary)" }}>
                    {r.rawUrl}
                    {r.resolvedUrl && r.resolvedUrl !== r.rawUrl && <> → {r.resolvedUrl}</>}
                  </div>
                  <div style={{ marginTop: 6, display: "flex", gap: 10, alignItems: "flex-start" }}>
                    {r.productImg && (
                      <img src={r.productImg} alt="" style={{ width: 44, height: 44, objectFit: "cover", borderRadius: 6, flexShrink: 0 }} />
                    )}
                    <div>
                      {r.productName && <div>{r.productName}</div>}
                      {(r.price != null || r.sold != null) && (
                        <div style={{ marginTop: 2, display: "flex", gap: 10, flexWrap: "wrap", color: "var(--color-text-secondary)" }}>
                          {r.price != null && (
                            <span>
                              <strong style={{ color: "var(--color-text-primary)" }}>R$ {Number(r.price).toFixed(2)}</strong>
                              {r.originalPrice != null && r.originalPrice > r.price && (
                                <span style={{ textDecoration: "line-through", marginLeft: 6 }}>R$ {Number(r.originalPrice).toFixed(2)}</span>
                              )}
                              {r.discount != null && r.discount > 0 && <span style={{ marginLeft: 6 }}>-{r.discount}%</span>}
                            </span>
                          )}
                          {r.sold != null && <span>{r.sold} vendidos</span>}
                        </div>
                      )}
                    </div>
                  </div>
                  <div style={{ marginTop: 6, display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center" }}>
                    <span>loja: <strong>{r.store || "desconhecida"}</strong></span>
                    <span>fonte habilitada: <Flag ok={r.sourceAllowed} /></span>
                    <span>afiliado: <Flag ok={r.affiliateConfigured} /></span>
                    <span>scrape: <Flag ok={r.scrapeOk} /></span>
                    <span style={{ color: outcome.color, fontWeight: 500 }}>{outcome.label}</span>
                    {r.reason && <span style={{ color: "var(--color-text-secondary)" }}>({r.reason})</span>}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {total > pageSize && (
          <div style={{ display: "flex", justifyContent: "center", gap: 8, marginTop: 14 }}>
            <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1} style={{ padding: "5px 10px", borderRadius: 6, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 12, cursor: page <= 1 ? "not-allowed" : "pointer", opacity: page <= 1 ? 0.5 : 1 }}>← Anterior</button>
            <span style={{ fontSize: 12, alignSelf: "center" }}>{page} / {totalPages}</span>
            <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages} style={{ padding: "5px 10px", borderRadius: 6, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 12, cursor: page >= totalPages ? "not-allowed" : "pointer", opacity: page >= totalPages ? 0.5 : 1 }}>Próxima →</button>
          </div>
        )}
      </div>
    </div>
  );
}
