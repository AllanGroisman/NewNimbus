import { PRIMARY } from "../data/constants";
import Modal from "./ui/Modal";

// Confirmação de logout, usada tanto pelo botão "Sair" da sidebar (via App)
// quanto por Configurações → Conta → "Sair da conta".
export default function LogoutConfirmModal({ onConfirm, onCancel }) {
  return (
    <Modal title="Sair da conta?" onClose={onCancel}>
      <p style={{ fontSize: 13, marginBottom: 16, color: "var(--color-text-secondary)" }}>Você será desconectado neste dispositivo. Os envios automáticos continuam funcionando normalmente.</p>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button onClick={onCancel} style={{ padding: "8px 16px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: "pointer" }}>Cancelar</button>
        <button onClick={onConfirm} style={{ padding: "8px 16px", borderRadius: 8, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500 }}>Sair</button>
      </div>
    </Modal>
  );
}
