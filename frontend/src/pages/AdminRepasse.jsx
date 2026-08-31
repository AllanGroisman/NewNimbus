import { useState, useEffect, useCallback } from "react";
import { adminRepasseLogs, adminRepasseSummary, errText} from "../data/api";
import Pagination from "../components/ui/Pagination";
import Badge from "../components/ui/Badge";
import RepasseSummary from "../components/admin/RepasseSummary";
import CouponDetection from "../components/admin/CouponDetection";
import { OUTCOME_LABEL } from "../data/cupomRotulos";

const POLL_MS = 5000;

const selectStyle = {
  padding: "7px 10px",
  borderRadius: 8,
  border: "0.5px solid var(--color-border-tertiary)",
  background: "var(--color-background-secondary)",
  fontSize: 13,
};

// Ordem das etapas do caminho de um link. Espelha STAGE_ORDER de
// backend/repasse/error-kinds.js — é o que permite dizer que uma checagem não
// chegou a rodar em vez de mostrar um traço que parece defeito.
const STAGE_ORDER = {
  store: 0, "affiliate-config": 1, scrape: 2, validate: 3, source: 4, queue: 5, send: 6,
};

const STAGE_LABEL = {
  store: "detecção da loja", "affiliate-config": "checagem do afiliado", scrape: "leitura da página",
  validate: "validação do produto", source: "lojas da campanha", queue: "fila", send: "envio",
};

function Flag({ ok, rowStage, atStage }) {
  // A etapa nem chegou a rodar: o link foi descartado antes. Um "—" aqui parecia
  // defeito do sistema; o que houve foi só um descarte anterior.
  if (rowStage && STAGE_ORDER[rowStage] < STAGE_ORDER[atStage]) {
    return (
      <span style={{ color: "var(--color-text-secondary)", fontStyle: "italic" }}
            title={`descartado antes, na etapa: ${STAGE_LABEL[rowStage] || rowStage}`}>
        não rodou
      </span>
    );
  }
  // Linha antiga (sem stage) ou etapa que rodou e não gravou nada: traço mesmo.
  if (ok === null || ok === undefined) return <span style={{ color: "var(--color-text-secondary)" }}>—</span>;
  return <span style={{ color: ok ? "#1B7A43" : "var(--danger-text)" }}>{ok ? "✓" : "✗"}</span>;
}

// Cor do selo de motivo: vermelho quando alguém precisa agir, âmbar quando é só
// esperar passar, cinza quando nada quebrou.
function kindColor(info) {
  if (!info) return "gray";
  if (info.transient === true) return "amber";
  if (info.transient === false) return "red";
  return "gray";
}

export default function PageAdminRepasse() {
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(50);
  const [filter, setFilter] = useState({ store: "", outcome: "", errorKind: "" });
  const [summary, setSummary] = useState(null);
  const [hours, setHours] = useState(24);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [auto, setAuto] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      // Lista e resumo juntos: buscados em separado, o resumo piscaria fora de
      // sincronia com a lista a cada auto-atualização.
      const [r, sum] = await Promise.all([
        adminRepasseLogs({ page, pageSize, ...filter }),
        adminRepasseSummary({ hours, store: filter.store || undefined }),
      ]);
      setItems(r.items || []);
      setTotal(r.total || 0);
      setSummary(sum);
      setError(null);
    } catch (err) {
      setError(errText(err, "Não foi possível carregar os repasses."));
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, filter, hours]);

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
          Descartes marcados como <em>no envio</em> contam tentativas, não itens únicos.
        </div>
      </div>

      <CouponDetection />

      <RepasseSummary
        summary={summary}
        hours={hours}
        onHours={setHours}
        onPickKind={k => { setFilter(f => ({ ...f, errorKind: k })); setPage(1); }}
      />

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
        <select value={filter.errorKind} onChange={e => { setFilter(f => ({ ...f, errorKind: e.target.value })); setPage(1); }} style={selectStyle}>
          <option value="">Todos os motivos</option>
          {Object.entries(summary?.kinds || {}).map(([kind, info]) => (
            <option key={kind} value={kind}>{info.label}</option>
          ))}
          <option value="none">Sem motivo de erro</option>
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
            {loading ? "Carregando..." : "Nenhum link capturado ainda. Poste um link num grupo líder de uma campanha de repasse."}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {items.map(r => {
              const outcome = OUTCOME_LABEL[r.outcome] || { label: r.outcome, color: "var(--color-text-secondary)" };
              // Catálogo de motivos vem do backend (summary.kinds), não de uma cópia
              // aqui — motivo novo no servidor aparece sozinho, sem drift.
              const kindInfo = summary?.kinds?.[r.errorKind];
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
                    <span>fonte habilitada: <Flag ok={r.sourceAllowed} rowStage={r.stage} atStage="source" /></span>
                    <span>afiliado: <Flag ok={r.affiliateConfigured} rowStage={r.stage} atStage="affiliate-config" /></span>
                    <span>scrape: <Flag ok={r.scrapeOk} rowStage={r.stage} atStage="scrape" /></span>
                    {/* Cupom da legenda do grupo líder. Sempre visível, inclusive o
                        "—": saber que a mensagem NÃO trazia cupom é metade da resposta. */}
                    <span>cupom: {r.coupon
                      ? <strong style={{ fontFamily: "monospace" }}>{r.coupon}</strong>
                      : <span style={{ color: "var(--color-text-secondary)" }}>—</span>}</span>
                    <span style={{ color: outcome.color, fontWeight: 500 }}>
                      {outcome.label}{r.stage === "send" ? " no envio" : ""}
                    </span>
                    {/* Selo com o motivo fechado (dá pra filtrar e contar) E o texto
                        humano ao lado — um não substitui o outro. */}
                    {r.errorKind && (
                      <span title={kindInfo ? `${kindInfo.what}\n\nO que fazer: ${kindInfo.action}` : undefined}>
                        <Badge color={kindColor(kindInfo)}>{kindInfo?.label || r.errorKind}</Badge>
                      </span>
                    )}
                    {r.reason && <span style={{ color: "var(--color-text-secondary)" }}>({r.reason})</span>}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <Pagination page={page} totalPages={totalPages} onChange={setPage} />
      </div>
    </div>
  );
}
