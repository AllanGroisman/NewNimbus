import { useState } from "react";
import { PRIMARY } from "../data/constants";
import Modal from "./ui/Modal";

// Diálogo "Salvar / Descartar / Cancelar" mostrado ao tentar navegar com
// alterações não salvas. onSave/onDiscard executam a decisão e depois seguem
// a navegação pendente; onCancel apenas fecha.
export default function UnsavedChangesModal({ onSave, onDiscard, onCancel }) {
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Alterações não salvas" onClose={onCancel}>
      <p style={{ fontSize: 13, marginBottom: 16, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
        Você tem alterações não salvas nesta tela. O que deseja fazer?
      </p>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
        <button onClick={onCancel} disabled={saving} style={{ padding: "8px 16px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: saving ? "not-allowed" : "pointer" }}>Cancelar</button>
        <button onClick={onDiscard} disabled={saving} style={{ padding: "8px 16px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", color: "#A32D2D", fontSize: 13, cursor: saving ? "not-allowed" : "pointer" }}>Descartar</button>
        <button onClick={handleSave} disabled={saving} style={{ padding: "8px 16px", borderRadius: 8, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: saving ? "wait" : "pointer", fontWeight: 500, opacity: saving ? 0.7 : 1 }}>{saving ? "Salvando..." : "Salvar"}</button>
      </div>
    </Modal>
  );
}
