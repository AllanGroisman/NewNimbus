import { useState, useRef, useEffect } from "react";
import { PRIMARY, PRIMARY_DARK } from "../data/constants";
import Badge from "../components/ui/Badge";
import Modal from "../components/ui/Modal";
import WhatsappQR from "../components/WhatsappQR";
import { deleteWASession, startWASession } from "../data/api";

export default function PageWhatsApp({
  numbers, setNumbers,
  whatsappGroups = [],
}) {
  const [showQR, setShowQR] = useState(null); // sessionId em conexão | "new" | null
  const [newLabel, setNewLabel] = useState("");
  const [confirmDisconnect, setConfirmDisconnect] = useState(null);
  const [pendingNumberId, setPendingNumberId] = useState(null);
  const [pendingLabel, setPendingLabel] = useState("");

  // Edição inline do apelido — { id, value } enquanto editando.
  const [editingLabel, setEditingLabel] = useState(null);
  const editInputRef = useRef(null);
  useEffect(() => {
    if (editingLabel && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingLabel?.id]);

  // Desconecta (logout no Baileys e remove auth_state). O número some da lista.
  const disconnect = async (id) => {
    try { await deleteWASession(id); } catch {}
    setNumbers(ns => ns.filter(n => n.id !== id));
    setConfirmDisconnect(null);
  };

  // Reabre o QR para um número que perdeu sessão
  const reconnect = async (id) => {
    setPendingNumberId(id);
    setShowQR(id);
    try { await startWASession(id); } catch (err) { console.error(err); }
  };

  // Inicia o fluxo de adicionar um número novo
  const startAddNumber = () => {
    const newId = String(Date.now());
    setPendingNumberId(newId);
    setPendingLabel(newLabel || "Novo número");
    setShowQR("new");
  };

  // Callback chamado pelo WhatsappQR quando a conexão é estabelecida
  const handleConnected = (info) => {
    if (showQR === "new") {
      setNumbers(ns => [...ns, {
        id: pendingNumberId,
        phone: info.phone ? `+${info.phone}` : "?",
        label: pendingLabel,
        status: "connected",
        lastActivity: "agora",
        waName: info.name || null,
      }]);
    } else {
      setNumbers(ns => ns.map(n => n.id === showQR ? { ...n, status: "connected", lastActivity: "agora", phone: info.phone ? `+${info.phone}` : n.phone } : n));
    }
    setShowQR(null);
    setNewLabel("");
    setPendingNumberId(null);
    setPendingLabel("");
  };

  // Cancela o fluxo de QR (apaga sessão pendente do backend)
  const cancelQR = async () => {
    if (showQR === "new" && pendingNumberId) {
      try { await deleteWASession(pendingNumberId); } catch {}
    }
    setShowQR(null);
    setPendingNumberId(null);
    setPendingLabel("");
  };

  // Commit do apelido editado — só persiste se houver valor não-vazio
  const commitEditingLabel = () => {
    if (!editingLabel) return;
    const next = String(editingLabel.value || "").trim();
    if (next) {
      setNumbers(ns => ns.map(n => n.id === editingLabel.id ? { ...n, label: next } : n));
    }
    setEditingLabel(null);
  };

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20, flexWrap: "wrap", gap: 10 }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 500 }}>WhatsApp</h2>
          <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 4 }}>
            {numbers.filter(n => n.status === "connected").length}/{numbers.length} número{numbers.length !== 1 ? "s" : ""} conectado{numbers.filter(n => n.status === "connected").length !== 1 ? "s" : ""} · gerencie os números aqui; grupos vão na aba de cada campanha.
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={startAddNumber} style={{ padding: "7px 14px", borderRadius: 8, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500 }}>+ Adicionar número</button>
        </div>
      </div>

      {/* Números */}
      <h3 style={{ fontSize: 14, fontWeight: 500, marginBottom: 10 }}>Números conectados</h3>
      {numbers.length === 0 && (
        <div style={{ textAlign: "center", padding: "30px 20px", background: "var(--color-background-secondary)", borderRadius: 12, border: "0.5px dashed var(--color-border-secondary)", marginBottom: 26 }}>
          <div style={{ fontSize: 24, marginBottom: 8 }}>📱</div>
          <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 4 }}>Conecte seu primeiro número</div>
          <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 12 }}>Adicione um número do WhatsApp pra começar a vincular grupos nas campanhas.</div>
          <button onClick={startAddNumber} style={{ padding: "8px 18px", borderRadius: 8, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500 }}>+ Adicionar número</button>
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {numbers.map(n => {
          const wgCount = whatsappGroups.filter(w => w.numberId === n.id).length;
          const isEditing = editingLabel?.id === n.id;
          return (
            <div key={n.id} style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: "14px 16px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: n.status === "connected" ? PRIMARY : "#E24B4A", flexShrink: 0 }} />
                    {isEditing ? (
                      <input
                        ref={editInputRef}
                        value={editingLabel.value}
                        onChange={e => setEditingLabel(s => ({ ...s, value: e.target.value }))}
                        onBlur={commitEditingLabel}
                        onKeyDown={e => {
                          if (e.key === "Enter") commitEditingLabel();
                          else if (e.key === "Escape") setEditingLabel(null);
                        }}
                        placeholder="Apelido"
                        style={{ padding: "3px 8px", borderRadius: 6, border: `0.5px solid ${PRIMARY}`, background: "var(--color-background-secondary)", fontSize: 13, fontWeight: 500, minWidth: 140 }}
                      />
                    ) : (
                      <>
                        <span style={{ fontWeight: 500 }}>{n.label}</span>
                        <button
                          onClick={() => setEditingLabel({ id: n.id, value: n.label })}
                          title="Editar apelido"
                          style={{ background: "transparent", border: "none", cursor: "pointer", padding: "2px 4px", color: "var(--color-text-secondary)", fontSize: 12, borderRadius: 4 }}
                        >✎</button>
                      </>
                    )}
                  </div>
                  <div style={{ fontSize: 13, color: "var(--color-text-secondary)", marginBottom: 6 }}>{n.phone}</div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <Badge color={n.status === "connected" ? "green" : "red"}>{n.status === "connected" ? "Conectado" : "Desconectado"}</Badge>
                    {wgCount > 0 && <Badge color="gray">Em uso por {wgCount} grupo{wgCount !== 1 ? "s" : ""}</Badge>}
                    {n.lastActivity && <Badge color="gray">Atividade: {n.lastActivity}</Badge>}
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
          );
        })}
      </div>

      {numbers.length > 0 && (
        <div style={{ marginTop: 18, fontSize: 11, color: "var(--color-text-secondary)", padding: "8px 12px", background: "var(--color-background-secondary)", borderRadius: 8, lineHeight: 1.5 }}>
          💡 Para criar, vincular ou importar grupos do WhatsApp, vá na campanha desejada e use a aba <strong style={{ color: PRIMARY_DARK }}>Grupos</strong>.
        </div>
      )}

      {/* Modal QR (adicionar/reconectar número) — usa Baileys real */}
      {showQR && pendingNumberId && (
        <Modal title={showQR === "new" ? "Adicionar novo número" : "Reconectar número"} onClose={cancelQR}>
          {showQR === "new" && (
            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Apelido</label>
              <input value={pendingLabel} onChange={e => setPendingLabel(e.target.value)} placeholder="Ex: Principal, Trabalho..." style={{ width: "100%", padding: "9px 12px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13, boxSizing: "border-box" }} />
            </div>
          )}
          <WhatsappQR sessionId={pendingNumberId} onConnected={handleConnected} />
        </Modal>
      )}

      {/* Modal desconectar número */}
      {confirmDisconnect && (
        <Modal title="Desconectar número?" onClose={() => setConfirmDisconnect(null)} danger>
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
