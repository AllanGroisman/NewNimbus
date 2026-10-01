import { useState } from "react";
import Badge from "../ui/Badge";

// Resumo do topo do Admin → Repasse.
//
// Existe por causa de um caso real: o Mercado Livre recusou 10 links seguidos por
// CAPTCHA durante duas horas e o painel mostrava 10 linhas parecidas — nada dizia
// que era UM problema. Aqui a resposta aparece de cara: qual loja parou, desde
// quando, e se o caso é esperar ou agir.

const PERIODS = [
  { hours: 1, label: "1h" },
  { hours: 24, label: "24h" },
  { hours: 168, label: "7d" },
];

const OUTCOME_TEXT = {
  queued: "fila",
  pending: "revisão",
  discarded: "descartados",
  duplicate: "duplicatas",
  cooldown: "cooldown",
  error: "erros",
};

// Uma loja está "parada" quando nada passou e já se acumulou um punhado de
// falhas. O piso de 5 evita gritar por causa de dois links ruins seguidos.
const STUCK_MIN_FAILURES = 5;

function isStuck(s) {
  return s.successRate === 0 && s.failuresSinceLastOk >= STUCK_MIN_FAILURES;
}

// "esperar" x "agir" — a separação que a mensagem antiga não fazia.
function urgency(kindInfo) {
  if (!kindInfo) return null;
  if (kindInfo.transient === true) return { color: "amber", text: "esperar" };
  if (kindInfo.transient === false) return { color: "red", text: "agir" };
  return { color: "gray", text: "esperado" };
}

function hhmm(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

const card = {
  background: "var(--color-background-primary)",
  border: "0.5px solid var(--color-border-tertiary)",
  borderRadius: 12,
  padding: 14,
};

export default function RepasseSummary({ summary, hours, onHours, onPickKind }) {
  const [openKind, setOpenKind] = useState(null);
  const kinds = summary?.kinds || {};
  const total = summary?.total || 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <div style={{ fontWeight: 600, fontSize: 13 }}>Resumo</div>
        <div style={{ display: "flex", gap: 4 }}>
          {PERIODS.map(p => (
            <button
              key={p.hours}
              onClick={() => onHours(p.hours)}
              style={{
                padding: "3px 10px", borderRadius: 6, fontSize: 12, cursor: "pointer",
                border: "0.5px solid var(--color-border-secondary)",
                background: hours === p.hours ? "var(--color-background-secondary)" : "transparent",
                fontWeight: hours === p.hours ? 600 : 400,
              }}
            >{p.label}</button>
          ))}
        </div>
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
          {total} link{total === 1 ? "" : "s"} nesse período
        </div>
      </div>

      {/* Faixas de alerta: é aqui que "sistêmico" vira uma frase legível. */}
      {(summary?.byStore || []).filter(isStuck).map(s => {
        const kindInfo = kinds[s.topErrorKind];
        return (
          <div key={`alert-${s.store}`} style={{
            ...card, borderColor: "var(--danger-text)", color: "var(--danger-text)", fontSize: 13,
          }}>
            <strong>{s.store}: nenhum link aprovado{s.lastOkAt ? ` desde ${hhmm(s.lastOkAt)}` : " neste período"}</strong>
            {" — "}{s.failuresSinceLastOk} tentativa{s.failuresSinceLastOk === 1 ? "" : "s"} seguida{s.failuresSinceLastOk === 1 ? "" : "s"} falharam
            {kindInfo ? ` (${kindInfo.label})` : ""}.
            {kindInfo && <div style={{ marginTop: 4, color: "var(--color-text-primary)", fontSize: 12 }}>{kindInfo.action}</div>}
          </div>
        );
      })}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 10 }}>
        {/* 1. Resultados */}
        <div style={card}>
          <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 8 }}>Resultados</div>
          {total === 0 ? (
            <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>Nenhum link nesse período.</div>
          ) : (
            <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
              {Object.entries(summary.byOutcome || {}).map(([outcome, n]) => {
                // Descarte em destaque quando é a maioria: é o sinal de que algo
                // está errado, não só de que alguns links não serviram.
                const alarm = outcome === "discarded" && n > total / 2;
                return (
                  <div key={outcome}>
                    <div style={{ fontSize: alarm ? 22 : 18, fontWeight: 600, color: alarm ? "var(--danger-text)" : "var(--color-text-primary)" }}>{n}</div>
                    <div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>{OUTCOME_TEXT[outcome] || outcome}</div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 2. Motivos */}
        <div style={card}>
          <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 8 }}>Motivos</div>
          {!(summary?.byErrorKind || []).length ? (
            <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>Nenhum descarte com motivo registrado.</div>
          ) : summary.byErrorKind.map(k => {
            const info = kinds[k.kind];
            const u = urgency(info);
            const pct = total ? Math.round((k.count / total) * 100) : 0;
            const open = openKind === k.kind;
            return (
              <div key={k.kind} style={{ marginBottom: 6 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                  <button
                    onClick={() => setOpenKind(open ? null : k.kind)}
                    title="Ver o que aconteceu e o que fazer"
                    style={{ border: "none", background: "transparent", padding: 0, cursor: "pointer", color: "inherit", fontSize: 12, textAlign: "left" }}
                  >{info?.label || k.kind}</button>
                  {u && <Badge color={u.color}>{u.text}</Badge>}
                  <span style={{ marginLeft: "auto", color: "var(--color-text-secondary)" }}>{k.count} · {pct}%</span>
                  <button
                    onClick={() => onPickKind(k.kind)}
                    title="Filtrar a lista por esse motivo"
                    style={{ border: "none", background: "transparent", padding: 0, cursor: "pointer", color: "var(--color-text-secondary)", fontSize: 12 }}
                  >filtrar</button>
                </div>
                <div style={{ height: 4, borderRadius: 2, background: "var(--color-background-secondary)", marginTop: 3 }}>
                  <div style={{ width: `${pct}%`, height: "100%", borderRadius: 2, background: u?.color === "red" ? "var(--danger-text)" : "var(--color-text-secondary)" }} />
                </div>
                {open && info && (
                  <div style={{ marginTop: 5, fontSize: 11, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
                    <div><strong>O que aconteceu:</strong> {info.what}</div>
                    <div><strong>O que fazer:</strong> {info.action}</div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* 3. Por loja */}
        <div style={card}>
          <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 8 }}>Por loja</div>
          {!(summary?.byStore || []).length ? (
            <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>Nenhuma loja nesse período.</div>
          ) : summary.byStore.map(s => (
            <div key={s.store} style={{ display: "flex", alignItems: "baseline", gap: 6, fontSize: 12, marginBottom: 4 }}>
              <span>{s.store}</span>
              <span style={{ marginLeft: "auto", fontWeight: 600, color: isStuck(s) ? "var(--danger-text)" : "var(--color-text-primary)" }}>
                {s.successRate == null ? "—" : `${s.successRate}%`}
              </span>
              <span style={{ color: "var(--color-text-secondary)" }}>({s.ok}/{s.ok + s.discarded})</span>
            </div>
          ))}
        </div>
      </div>

      {/* Linha do tempo por hora: o corte fica visível de relance. As barras
          encolhem até sumir o vão: com "7d" são 168, e com largura mínima elas
          empurravam a página inteira pro lado no celular. */}
      {(summary?.byHour || []).length > 1 && (
        <div style={{ ...card, display: "flex", alignItems: "flex-end", gap: summary.byHour.length > 48 ? 0 : 2, height: 56 }}>
          {summary.byHour.map(h => {
            const max = Math.max(...summary.byHour.map(x => x.total)) || 1;
            return (
              <div
                key={h.hour}
                title={`${new Date(h.hour).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit" })}h — ${h.ok} ok / ${h.discarded} descartados`}
                style={{ flex: 1, height: `${(h.total / max) * 100}%`, display: "flex", flexDirection: "column", justifyContent: "flex-end", minWidth: 0 }}
              >
                <div style={{ height: `${(h.discarded / h.total) * 100}%`, background: "var(--danger-text)" }} />
                <div style={{ height: `${(h.ok / h.total) * 100}%`, background: "#1B7A43" }} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
