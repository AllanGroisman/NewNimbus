import { useState, useEffect, useRef } from "react";
import { PRIMARY, PRIMARY_DARK } from "../data/constants";
import {
  whatsNimbusStatus,
  whatsNimbusConnect,
  whatsNimbusFinalize,
  whatsNimbusDisconnect,
} from "../data/api";

const cardStyle = { background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 10, padding: "20px 24px", marginBottom: 16 };
const btnPrimary = { background: PRIMARY, color: "#fff", border: "none", borderRadius: 6, padding: "9px 18px", fontSize: 13, fontWeight: 600, cursor: "pointer" };
const btnDanger = { background: "transparent", color: "#A32D2D", border: "1px solid #A32D2D", borderRadius: 6, padding: "9px 18px", fontSize: 13, fontWeight: 600, cursor: "pointer" };

const STATUS_META = {
  connected:   { color: "#15803D", label: "Conectado" },
  awaiting_qr: { color: "#B45309", label: "Aguardando leitura do QR" },
  connecting:  { color: "#B45309", label: "Conectando..." },
  disconnected:{ color: "#A32D2D", label: "Desconectado" },
  logged_out:  { color: "#A32D2D", label: "Desvinculado" },
  idle:        { color: "var(--color-text-secondary)", label: "Não configurado" },
};

export default function PageAdminWhatsNimbus() {
  const [snap, setSnap] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const pollRef = useRef(null);
  const finalizedRef = useRef(false);

  async function refresh() {
    try {
      const s = await whatsNimbusStatus();
      setSnap(s);
      return s;
    } catch (err) {
      setError(err.message);
      return null;
    }
  }

  useEffect(() => {
    (async () => { await refresh(); setLoading(false); })();
    return () => { if (pollRef.current) clearTimeout(pollRef.current); };
  }, []);

  function stopPolling() {
    if (pollRef.current) { clearTimeout(pollRef.current); pollRef.current = null; }
  }

  // Polling durante a conexão: quando conecta, fixa o número canônico (finalize).
  function startPolling() {
    stopPolling();
    const tick = async () => {
      const s = await refresh();
      if (!s) { pollRef.current = setTimeout(tick, 1500); return; }
      if (s.status === "connected" && s.info?.phone) {
        if (!finalizedRef.current) {
          finalizedRef.current = true;
          try { await whatsNimbusFinalize({ phone: s.info.phone, name: s.info.name }); } catch { /* ignore */ }
          await refresh();
        }
        stopPolling();
        return;
      }
      pollRef.current = setTimeout(tick, 1500);
    };
    pollRef.current = setTimeout(tick, 1500);
  }

  async function connect() {
    setBusy(true); setError(null); finalizedRef.current = false;
    try {
      const s = await whatsNimbusConnect();
      setSnap(s);
      startPolling();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true); setError(null); stopPolling();
    try {
      const s = await whatsNimbusDisconnect();
      setSnap(s);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (loading || !snap) {
    return <div style={{ padding: 40, textAlign: "center", color: "var(--color-text-secondary)" }}>Carregando...</div>;
  }

  const meta = STATUS_META[snap.status] || STATUS_META.idle;
  const isConnected = snap.status === "connected";
  const showQr = snap.status === "awaiting_qr" && snap.qr;

  return (
    <div style={{ padding: "28px 32px", maxWidth: 640 }}>
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 20, fontWeight: 700, color: "var(--color-text-primary)" }}>WhatsNimbus</div>
        <div style={{ fontSize: 13, color: "var(--color-text-secondary)", marginTop: 4 }}>
          O WhatsApp do sistema. É por ele que o Nimbus avisa cada usuário sobre WhatsApp desconectado,
          campanhas pausadas/paradas, buscas de produtos e fila vazia. Conecte um número dedicado aqui.
        </div>
      </div>

      {error && (
        <div style={{ background: "#FEE2E2", color: "#991B1B", borderRadius: 8, padding: "10px 14px", marginBottom: 16, fontSize: 13 }}>
          {error}
        </div>
      )}

      <div style={cardStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: "var(--color-text-primary)" }}>Conexão</div>
          <div style={{ fontSize: 13, fontWeight: 600, color: meta.color }}>● {meta.label}</div>
        </div>

        {isConnected ? (
          <div style={{ fontSize: 13, color: "var(--color-text-secondary)", marginTop: 6 }}>
            {snap.info?.name && <div>Nome: <strong>{snap.info.name}</strong></div>}
            {(snap.phone || snap.info?.phone) && <div>Telefone: <strong>+{snap.phone || snap.info?.phone}</strong></div>}
          </div>
        ) : showQr ? (
          <div style={{ textAlign: "center", marginTop: 12 }}>
            <img src={snap.qr} alt="QR Code WhatsNimbus" style={{ width: 240, height: 240, borderRadius: 8, background: "#fff", padding: 8 }} />
            <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 12, lineHeight: 1.5, textAlign: "left", maxWidth: 280, margin: "12px auto 0" }}>
              1. Abra o WhatsApp no celular<br />
              2. <strong>Menu</strong> &rarr; <strong>Dispositivos vinculados</strong><br />
              3. Toque em <strong>Vincular dispositivo</strong><br />
              4. Aponte a câmera para este QR Code
            </div>
          </div>
        ) : (snap.status === "connecting") ? (
          <div style={{ padding: "24px 0", textAlign: "center", color: "var(--color-text-secondary)" }}>
            <div style={{ fontSize: 24, marginBottom: 8 }}>⟳</div>
            <div style={{ fontSize: 13 }}>Iniciando conexão... aguarde o QR Code.</div>
          </div>
        ) : (
          <div style={{ fontSize: 13, color: "var(--color-text-secondary)", marginTop: 6 }}>
            Nenhum número conectado. Clique em <strong>Conectar</strong> para vincular o WhatsApp do sistema.
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 10 }}>
        {!isConnected && (
          <button style={btnPrimary} onClick={connect} disabled={busy}>
            {busy ? "Aguarde..." : (snap.numberId ? "Reconectar" : "Conectar")}
          </button>
        )}
        {(snap.numberId || isConnected) && (
          <button style={btnDanger} onClick={disconnect} disabled={busy}>
            {busy ? "Aguarde..." : "Desconectar"}
          </button>
        )}
      </div>
    </div>
  );
}
