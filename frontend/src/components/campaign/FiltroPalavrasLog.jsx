import { useState, useEffect, useCallback } from "react";
import { PRIMARY, PRIMARY_DARK, PRIMARY_LIGHT, formatPrice, formatDateBR, formatTimeBR } from "../../data/constants";
import { filtroPalavrasLog, errText } from "../../data/api";

// Histórico → Filtro de palavras da campanha de repasse: cada produto que passou
// pela lista branca/negra (backend/repasse/word-filter.js), se foi aprovado ou
// reprovado, e por quê. A aba inteira some quando o admin desliga a função em
// Admin → Gerais (quem decide é o GroupDashboard).

const FILTROS = [
  { id: "", label: "Todos" },
  { id: "approved", label: "Aprovados" },
  { id: "rejected", label: "Reprovados" },
];

// O que aconteceu com o produto aprovado depois do filtro (outcome do log).
const DEPOIS = {
  queued: "entrou na fila",
  pending: "foi pra revisão",
  duplicate: "já estava na fila",
  cooldown: "enviado há pouco — pulado",
  discarded: "loja não habilitada na campanha",
  error: "erro ao entrar na fila",
};

function Selo({ aprovado }) {
  return (
    <span style={{
      display: "inline-block", padding: "2px 8px", borderRadius: 6, fontSize: 11, fontWeight: 600,
      background: aprovado ? "var(--success-bg, #E6F4EA)" : "var(--danger-bg)",
      color: aprovado ? "var(--success-text, #1B7A43)" : "var(--danger-text)",
    }}>
      {aprovado ? "Aprovado" : "Reprovado"}
    </span>
  );
}

export default function FiltroPalavrasLog({ groupId }) {
  const [filtro, setFiltro] = useState("");
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState(null);

  // Primeira página: recarrega quando o filtro muda. O setState fica só nos
  // callbacks da promise; o "carregando" liga em trocarFiltro.
  useEffect(() => {
    let alive = true;
    filtroPalavrasLog(groupId, { page: 1, filtro })
      .then(r => {
        if (!alive) return;
        setRows(r.rows || []);
        setTotal(r.total || 0);
        setPage(1);
      })
      .catch(err => { if (alive) setErro(errText(err, "Não deu pra carregar o filtro de palavras.")); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [groupId, filtro]);

  function trocarFiltro(f) {
    if (f === filtro) return;
    setLoading(true);
    setErro(null);
    setRows([]);
    setFiltro(f);
  }

  const carregarMais = useCallback(async () => {
    setLoading(true);
    setErro(null);
    try {
      const r = await filtroPalavrasLog(groupId, { page: page + 1, filtro });
      setRows(prev => [...prev, ...(r.rows || [])]);
      setTotal(r.total || 0);
      setPage(page + 1);
    } catch (err) {
      setErro(errText(err, "Não deu pra carregar o filtro de palavras."));
    } finally {
      setLoading(false);
    }
  }, [groupId, filtro, page]);

  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 14, fontWeight: 500 }}>Filtro de palavras</div>
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 2 }}>
          Produtos que passaram pela lista branca e pela lista negra desta campanha, e o motivo de cada um.
        </div>
      </div>

      <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
        {FILTROS.map(f => {
          const ativo = filtro === f.id;
          return (
            <button key={f.id || "todos"} type="button" aria-pressed={ativo} onClick={() => trocarFiltro(f.id)}
              style={{
                padding: "6px 12px", borderRadius: 7, fontSize: 12, cursor: "pointer",
                border: `0.5px solid ${ativo ? PRIMARY : "var(--color-border-secondary)"}`,
                background: ativo ? PRIMARY_LIGHT : "transparent",
                color: ativo ? PRIMARY_DARK : "var(--color-text-primary)", fontWeight: ativo ? 600 : 400,
              }}>
              {f.label}
            </button>
          );
        })}
      </div>

      {erro && <div role="alert" style={{ fontSize: 13, color: "var(--danger-text)", marginBottom: 12 }}>{erro}</div>}

      {!loading && !erro && rows.length === 0 && (
        <div style={{ textAlign: "center", padding: "40px 16px", color: "var(--color-text-secondary)", fontSize: 13, background: "var(--color-background-secondary)", borderRadius: 12 }}>
          Nenhum produto passou pelo filtro ainda. Ele só roda quando a campanha tem palavras na lista branca ou negra (aba Gerenciar).
        </div>
      )}

      {rows.length > 0 && (
        <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, overflow: "hidden" }}>
          {rows.map((r, i) => {
            const aprovado = r.wordFilter === "approved";
            const quando = r.createdAt ? new Date(r.createdAt) : null;
            const valido = quando && !isNaN(quando.getTime());
            const depois = aprovado ? DEPOIS[r.outcome] : null;
            return (
              <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderBottom: i < rows.length - 1 ? "0.5px solid var(--color-border-tertiary)" : "none" }}>
                <div style={{ width: 44, height: 44, borderRadius: 8, background: "var(--color-background-secondary)", flexShrink: 0, overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  {r.productImg
                    ? <img src={r.productImg} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} onError={e => { e.target.style.display = "none"; }} />
                    : <span style={{ fontSize: 18, color: "var(--color-text-secondary)" }}>📦</span>}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={r.productName || r.rawUrl}>
                    {r.productName || r.rawUrl}
                  </div>
                  <div style={{ fontSize: 12, marginTop: 3, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <Selo aprovado={aprovado} />
                    <span>{r.wordFilterReason}</span>
                    {depois && <span style={{ color: "var(--color-text-secondary)" }}>· {depois}</span>}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 3 }}>
                    {valido ? `${formatDateBR(quando)} ${formatTimeBR(quando)}` : "—"} · {r.store || "—"}
                  </div>
                </div>
                {r.price != null && (
                  <div style={{ fontSize: 13, fontWeight: 500, color: PRIMARY_DARK, flexShrink: 0 }}>{formatPrice(Number(r.price))}</div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {loading && <div style={{ fontSize: 13, color: "var(--color-text-secondary)", padding: "12px 0" }}>Carregando…</div>}

      {!loading && rows.length < total && (
        <div style={{ display: "flex", justifyContent: "center", marginTop: 12 }}>
          <button type="button" onClick={carregarMais}
            style={{ padding: "6px 14px", borderRadius: 7, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 12, cursor: "pointer" }}>
            Carregar mais ({total - rows.length})
          </button>
        </div>
      )}
    </div>
  );
}
