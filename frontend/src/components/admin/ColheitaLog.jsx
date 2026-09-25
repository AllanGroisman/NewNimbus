// O passo a passo de uma colheita, e o balanço dela no fim.
//
// Existe porque as duas colheitas de cupom demoram minutos e, até aqui, cada uma
// mostrava UMA linha de texto que se sobrescrevia: dava pra ver que algo estava
// acontecendo, nunca O QUE aconteceu. As duas terminavam sem deixar rastro.
//
// Serve as duas de propósito, apesar de virem de lugares diferentes — a rodada do
// servidor (`backend/coupons/sync.js`, lida pelo poll do status) e o lote pela
// extensão (montado no próprio navegador). Chegando aqui as duas já são a mesma
// coisa: uma lista de eventos e um resumo.
import { useEffect, useRef } from "react";
import Numero from "./Numero";
import { th, td } from "./cupomEstilos";

const ICONE = { info: "·", ok: "✅", aviso: "⚠️", erro: "❌" };
const COR = {
  info: "var(--color-text-secondary)",
  ok: "var(--color-text-primary)",
  aviso: "var(--warn-text)",
  erro: "var(--danger-text)",
};

const hora = (at) => {
  const d = at ? new Date(at) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleTimeString("pt-BR") : "";
};

export default function ColheitaLog({ eventos, resumo, rodando = false, titulo = "O que está acontecendo", vazio = null }) {
  const caixa = useRef(null);
  const grudado = useRef(true);

  // Rolar sozinho só ENQUANTO roda, e só DENTRO da caixa do log. Era um
  // `scrollIntoView` no fim da lista, que rolava a PÁGINA inteira a cada evento
  // novo: mexer na tela durante a rodada puxava a vista de volta pro log (task 21).
  // E só se o admin já estava no fim da caixa — subiu pra ler algo, fica lá.
  useEffect(() => {
    const el = caixa.current;
    if (rodando && el && grudado.current) el.scrollTop = el.scrollHeight;
  }, [eventos?.length, rodando]);

  const aoRolar = (e) => {
    const el = e.currentTarget;
    grudado.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  const temEventos = !!eventos?.length;
  if (!temEventos && !resumo) return vazio;

  return (
    <div style={{ marginTop: 12 }}>
      {temEventos && (
        <>
          <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 4 }}>
            {rodando ? `⟳ ${titulo}` : titulo}
          </div>
          <div
            ref={caixa}
            onScroll={aoRolar}
            style={{
              maxHeight: 220, overflowY: "auto", fontSize: 12, lineHeight: 1.6,
              background: "var(--color-background-secondary)", borderRadius: 8,
              border: "0.5px solid var(--color-border-tertiary)", padding: "8px 10px",
            }}
          >
            {eventos.map((e, i) => (
              <div key={`${e.at}-${i}`} style={{ display: "flex", gap: 8, color: COR[e.tipo] || COR.info }}>
                <span style={{ color: "var(--color-text-secondary)", fontVariantNumeric: "tabular-nums" }}>{hora(e.at)}</span>
                <span>{ICONE[e.tipo] || ICONE.info}</span>
                <span style={{ flex: 1, wordBreak: "break-word" }}>{e.texto}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {resumo && <Resumo resumo={resumo} />}
    </div>
  );
}

// O balanço. `numeros` é o que sempre aparece; `linhas` (opcional) é o detalhe por
// cupom, que só o lote da extensão tem — o servidor conta, não lista.
function Resumo({ resumo }) {
  const { titulo = "Resumo", nota = null, tom = "ok", numeros = [], linhas = null, colunas = null } = resumo;
  const fundo = tom === "erro" ? "var(--danger-bg)" : tom === "aviso" ? "var(--warn-bg)" : "var(--color-background-secondary)";
  const borda = tom === "erro" ? "var(--danger-border)" : tom === "aviso" ? "var(--warn-border)" : "var(--color-border-tertiary)";

  return (
    <div style={{ marginTop: 10, background: fundo, border: `0.5px solid ${borda}`, borderRadius: 10, padding: "10px 12px" }}>
      <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 8 }}>{titulo}</div>
      {nota && <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 8 }}>{nota}</div>}
      {!!numeros.length && (
        <div style={{ display: "flex", gap: 18, flexWrap: "wrap", fontSize: 12 }}>
          {numeros.map(n => <Numero key={n.label} label={n.label} valor={n.valor} />)}
        </div>
      )}
      {!!linhas?.length && (
        <div style={{ overflowX: "auto", marginTop: 10 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--color-text-secondary)" }}>
                {(colunas || []).map(c => <th key={c} style={th}>{c}</th>)}
              </tr>
            </thead>
            <tbody>
              {linhas.map((l, i) => (
                <tr key={i} style={{ borderTop: "0.5px solid var(--color-border-tertiary)" }}>
                  {l.map((celula, j) => <td key={j} style={td}>{celula}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
