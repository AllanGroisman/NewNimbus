import { useState } from "react";
import Modal from "./ui/Modal";

// Troca de item ativo quando o plano já está cheio.
//
// Aparece quando o cliente clica em "Ativar" numa campanha (ou número) pausada
// pelo plano e não há vaga: em vez de recusar, o sistema pergunta qual dos
// ativos deve ser pausado no lugar. Nada é apagado — só troca quem envia.
//
// Props:
//   target     — { id, name } o item que ele quer ativar
//   candidates — [{ id, name }] os ativos hoje (um deles sai)
//   kind       — "campanha" | "número"
//   busy       — trava os botões enquanto a troca está sendo salva
//   error      — mensagem de erro vinda do backend
export default function PlanSwapModal({ target, candidates = [], kind = "campanha", busy, error, onCancel, onConfirm }) {
  const [victimId, setVictimId] = useState(candidates[0]?.id ?? null);
  const artigo = kind === "número" ? "o" : "a";

  return (
    <Modal title={`Ativar ${kind} "${target?.name || ""}"`} onClose={busy ? undefined : onCancel} confirmOnClickOutside>
      <p style={{ fontSize: 13, color: "var(--color-text-secondary)", lineHeight: 1.5, marginBottom: 14 }}>
        Seu plano permite {candidates.length} {kind}{candidates.length === 1 ? "" : "s"} ativ{artigo}{candidates.length === 1 ? "" : "s"} ao
        mesmo tempo. Escolha qual vai ficar pausad{artigo} no lugar — nada é apagado, dá pra trocar de novo quando quiser.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
        {candidates.map(c => (
          <label
            key={c.id}
            style={{
              display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 10,
              border: `0.5px solid ${String(c.id) === String(victimId) ? "var(--warn-border)" : "var(--color-border-tertiary)"}`,
              background: String(c.id) === String(victimId) ? "var(--warn-bg)" : "var(--color-background-secondary)",
              cursor: busy ? "default" : "pointer", fontSize: 13,
            }}
          >
            <input
              type="radio"
              name="plan-swap-victim"
              checked={String(c.id) === String(victimId)}
              onChange={() => setVictimId(c.id)}
              disabled={busy}
            />
            <span style={{ flex: 1, minWidth: 0 }}>{c.name}</span>
          </label>
        ))}
      </div>

      {error && (
        <div role="alert" style={{ background: "var(--danger-bg)", border: "0.5px solid var(--danger-border)", color: "var(--danger-text)", padding: "8px 12px", borderRadius: 8, fontSize: 12, marginBottom: 12 }}>
          {error}
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
        <button
          onClick={onCancel}
          disabled={busy}
          style={{ padding: "8px 16px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", color: "var(--color-text-primary)", fontSize: 13, cursor: busy ? "default" : "pointer" }}
        >
          Cancelar
        </button>
        <button
          onClick={() => onConfirm(victimId)}
          disabled={busy || victimId == null}
          style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: "var(--warn-text)", color: "var(--color-background-primary)", fontSize: 13, fontWeight: 500, cursor: busy || victimId == null ? "default" : "pointer", opacity: busy ? 0.7 : 1 }}
        >
          {busy ? "Trocando…" : "Trocar"}
        </button>
      </div>
    </Modal>
  );
}
