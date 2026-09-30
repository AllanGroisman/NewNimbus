// Mensagem no privado no cartão do grupo destino (task 6, só admin).
//
// O envio roda no servidor, em segundo plano (backend/dm-broadcast/runner.js).
// Aqui é só uma faixa pequena com o andamento da parte DESTE grupo e o cancelar
// ali mesmo. Cancelar para só este grupo: num "Mensagem a todos", os outros
// continuam. O que mostrar mora em dmPartes.js.
import { PRIMARY } from "../../data/constants";
import { parteAtiva, textoDaParte } from "./dmPartes";

const btnMini = { padding: "3px 10px", borderRadius: 6, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 11, cursor: "pointer", flexShrink: 0 };

export default function DmProgresso({ parte, broadcast, onCancelar, onDispensar }) {
  const ativa = parteAtiva(parte);
  const pct = parte.total ? Math.round(((parte.sent + parte.failed) / parte.total) * 100) : 0;
  const parou = !ativa && broadcast.status === "failed";
  return (
    <div
      role="status"
      aria-label="Mensagem no privado"
      title={broadcast.text}
      style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, padding: "6px 8px", borderRadius: 8, background: "var(--color-background-secondary)", fontSize: 12 }}
    >
      <span aria-hidden="true">✉</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", color: parou ? "var(--danger-text)" : "var(--color-text-secondary)" }}>
          {parte.total > 0 && (
            <span style={{ color: "var(--color-text-primary)" }}><b>{parte.sent}</b> de {parte.total}</span>
          )}
          <span>{textoDaParte(parte, broadcast)}</span>
          {parte.failed > 0 && <span>· {parte.failed} com falha</span>}
        </div>
        {ativa && parte.total > 0 && (
          <div style={{ height: 3, borderRadius: 2, marginTop: 4, background: "var(--color-border-tertiary)", overflow: "hidden" }}>
            <div style={{ width: `${pct}%`, height: "100%", background: PRIMARY }} />
          </div>
        )}
      </div>
      {ativa ? (
        <button type="button" onClick={onCancelar} style={{ ...btnMini, color: "var(--danger-text)" }}>Cancelar</button>
      ) : (
        <button type="button" onClick={onDispensar} aria-label="Dispensar" title="Dispensar" style={{ ...btnMini, border: "none", fontSize: 14, color: "var(--color-text-secondary)" }}>×</button>
      )}
    </div>
  );
}
