import { useState } from "react";
import { PRIMARY, PRIMARY_LIGHT } from "../data/constants";
import Badge from "../components/ui/Badge";
import Modal from "../components/ui/Modal";
import FakeQRCode from "../components/FakeQRCode";

export default function PageWhatsApp({ numbers, setNumbers, groups }) {
  const [showQR, setShowQR] = useState(null);
  const [newLabel, setNewLabel] = useState("");
  const [confirmDisconnect, setConfirmDisconnect] = useState(null);

  const disconnect = (id) => {
    setNumbers(ns => ns.map(n => n.id === id ? { ...n, status: "disconnected", lastActivity: "agora" } : n));
    setConfirmDisconnect(null);
  };

  const reconnect = (id) => {
    setShowQR(id);
    setTimeout(() => {
      setNumbers(ns => ns.map(n => n.id === id ? { ...n, status: "connected", lastActivity: "agora" } : n));
      setShowQR(null);
    }, 4000);
  };

  const addNumber = () => {
    const newId = Date.now();
    setNumbers(ns => [...ns, { id: newId, phone: "Aguardando...", label: newLabel || "Novo número", status: "connected", lastActivity: "agora", groupsCount: 0 }]);
    setShowQR(null);
    setNewLabel("");
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20, flexWrap: "wrap", gap: 10 }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 500 }}>WhatsApp</h2>
          <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 4 }}>{numbers.filter(n => n.status === "connected").length} de {numbers.length} números conectados</div>
        </div>
        <button onClick={() => setShowQR("new")} style={{ padding: "7px 14px", borderRadius: 8, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500 }}>+ Adicionar número</button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 24 }}>
        {numbers.map(n => (
          <div key={n.id} style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: "14px 16px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: n.status === "connected" ? PRIMARY : "#E24B4A" }} />
                  <span style={{ fontWeight: 500 }}>{n.label}</span>
                </div>
                <div style={{ fontSize: 13, color: "var(--color-text-secondary)", marginBottom: 6 }}>{n.phone}</div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <Badge color={n.status === "connected" ? "green" : "red"}>{n.status === "connected" ? "Conectado" : "Desconectado"}</Badge>
                  <Badge color="gray">{n.groupsCount} grupo{n.groupsCount !== 1 ? "s" : ""}</Badge>
                  <Badge color="gray">Atividade: {n.lastActivity}</Badge>
                </div>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                {n.status === "connected"
                  ? <button onClick={() => setConfirmDisconnect(n.id)} style={{ padding: "6px 14px", borderRadius: 8, border: "0.5px solid #F7C1C1", background: "#FCEBEB", color: "#A32D2D", fontSize: 12, cursor: "pointer" }}>Desconectar</button>
                  : <button onClick={() => reconnect(n.id)} style={{ padding: "6px 14px", borderRadius: 8, background: PRIMARY, color: "#fff", border: "none", fontSize: 12, cursor: "pointer", fontWeight: 500 }}>Reconectar</button>
                }
              </div>
            </div>
          </div>
        ))}
      </div>

      <h3 style={{ fontSize: 14, fontWeight: 500, marginBottom: 12 }}>Grupos por número</h3>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {numbers.map(n => {
          const grps = groups.filter(g => g.numberId === n.id);
          return (
            <div key={n.id} style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: "12px 14px" }}>
              <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8 }}>{n.label} &mdash; {grps.length} grupo{grps.length !== 1 ? "s" : ""}</div>
              {grps.length === 0
                ? <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>Nenhum grupo vinculado</div>
                : <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>{grps.map(g => <Badge key={g.id} color={g.category === "gamer" ? "blue" : "teal"}>{g.name}</Badge>)}</div>
              }
            </div>
          );
        })}
      </div>

      {showQR && (
        <Modal title={showQR === "new" ? "Adicionar novo número" : "Reconectar número"} onClose={() => setShowQR(null)}>
          {showQR === "new" && (
            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Apelido (opcional)</label>
              <input value={newLabel} onChange={e => setNewLabel(e.target.value)} placeholder="Ex: Principal, Trabalho..." style={{ width: "100%", padding: "9px 12px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13, boxSizing: "border-box" }} />
            </div>
          )}
          <div style={{ background: "var(--color-background-secondary)", borderRadius: 12, padding: 20, textAlign: "center", marginBottom: 14 }}>
            <FakeQRCode />
            <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 12, lineHeight: 1.5 }}>
              1. Abra o WhatsApp no celular<br />
              2. Toque em <strong>Menu</strong> &rarr; <strong>Dispositivos vinculados</strong><br />
              3. Toque em <strong>Vincular dispositivo</strong><br />
              4. Aponte a câmera para este QR Code
            </div>
          </div>
          {showQR === "new"
            ? <button onClick={addNumber} style={{ width: "100%", padding: "9px", borderRadius: 8, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500 }}>Simular conexão</button>
            : <div style={{ textAlign: "center", fontSize: 12, color: "var(--color-text-secondary)" }}>Aguardando leitura do QR Code...</div>
          }
        </Modal>
      )}

      {confirmDisconnect && (
        <Modal title="Desconectar número?" onClose={() => setConfirmDisconnect(null)}>
          <p style={{ fontSize: 13, marginBottom: 16, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
            Ao desconectar, os envios deste número serão interrompidos até que você reconecte novamente via QR Code. Grupos vinculados ficarão pausados.
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={() => setConfirmDisconnect(null)} style={{ padding: "8px 16px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: "pointer" }}>Cancelar</button>
            <button onClick={() => disconnect(confirmDisconnect)} style={{ padding: "8px 16px", borderRadius: 8, background: "#E24B4A", color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500 }}>Desconectar</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
