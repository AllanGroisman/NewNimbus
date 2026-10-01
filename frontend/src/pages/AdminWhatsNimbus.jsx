import { useState, useEffect, useRef } from "react";
import { PRIMARY } from "../data/constants";
import {
  whatsNimbusStatus,
  whatsNimbusConnect,
  whatsNimbusFinalize,
  whatsNimbusDisconnect,
  whatsNimbusGroups,
  whatsNimbusSend,
  errText,
} from "../data/api";

const cardStyle = { background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 10, padding: "20px 24px", marginBottom: 16 };
const btnPrimary = { background: PRIMARY, color: "#fff", border: "none", borderRadius: 6, padding: "9px 18px", fontSize: 13, fontWeight: 600, cursor: "pointer" };
const btnDanger = { background: "transparent", color: "var(--danger-text)", border: "1px solid var(--danger-text)", borderRadius: 6, padding: "9px 18px", fontSize: 13, fontWeight: 600, cursor: "pointer" };
const fieldStyle = { width: "100%", background: "var(--color-background-primary)", color: "var(--color-text-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 6, padding: "9px 10px", fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" };
const labelStyle = { fontSize: 12, fontWeight: 600, color: "var(--color-text-secondary)", display: "block", marginBottom: 6 };

const STATUS_META = {
  connected:   { color: "#15803D", label: "Conectado" },
  awaiting_qr: { color: "#B45309", label: "Aguardando leitura do QR" },
  connecting:  { color: "#B45309", label: "Conectando..." },
  disconnected:{ color: "var(--danger-text)", label: "Desconectado" },
  logged_out:  { color: "var(--danger-text)", label: "Desvinculado" },
  idle:        { color: "var(--color-text-secondary)", label: "Não configurado" },
};

const BG_STATUS_POLL_MS = 20 * 1000;

export default function PageAdminWhatsNimbus() {
  const [snap, setSnap] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const pollRef = useRef(null);
  const finalizedRef = useRef(false);

  // Envio manual (grupo + texto)
  const [groups, setGroups] = useState([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [groupsError, setGroupsError] = useState(null);
  const [sendJid, setSendJid] = useState("");
  const [sendText, setSendText] = useState("");
  const [sending, setSending] = useState(false);
  const [sendMsg, setSendMsg] = useState(null);

  async function refresh() {
    try {
      const s = await whatsNimbusStatus();
      setSnap(s);
      return s;
    } catch (err) {
      setError(errText(err, "Não foi possível concluir a ação. Tente novamente."));
      return null;
    }
  }

  useEffect(() => {
    (async () => { await refresh(); setLoading(false); })();
    return () => { if (pollRef.current) clearTimeout(pollRef.current); };
  }, []);

  // Polling de fundo: sem isso, se o número cair sozinho (fora do fluxo de QR),
  // o admin só percebe dando F5. Não atropela o polling rápido de startPolling()
  // (pollRef ocupado) nem roda com a aba oculta.
  useEffect(() => {
    let cancelled = false;
    let timer = null;
    const schedule = () => { if (!cancelled) timer = setTimeout(tick, BG_STATUS_POLL_MS); };
    async function tick() {
      if (!cancelled && !document.hidden && !pollRef.current) await refresh();
      schedule();
    }
    schedule();
    const onVisibility = () => { if (!document.hidden && !pollRef.current) refresh(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
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
      setError(errText(err, "Não foi possível concluir a ação. Tente novamente."));
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
      setError(errText(err, "Não foi possível concluir a ação. Tente novamente."));
    } finally {
      setBusy(false);
    }
  }

  // Grupos só existem com a sessão de pé; recarrega quando (re)conecta.
  async function loadGroups() {
    setGroupsLoading(true); setGroupsError(null);
    try {
      const list = await whatsNimbusGroups();
      setGroups(Array.isArray(list) ? list : []);
    } catch (err) {
      setGroups([]);
      setGroupsError(errText(err, "Não foi possível carregar os grupos."));
    } finally {
      setGroupsLoading(false);
    }
  }

  useEffect(() => {
    if (snap?.status === "connected") loadGroups();
    else { setGroups([]); setSendJid(""); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap?.status]);

  async function send() {
    if (!sendJid || !sendText.trim()) return;
    setSending(true); setSendMsg(null);
    try {
      await whatsNimbusSend({ jid: sendJid, text: sendText.trim() });
      setSendText("");
      setSendMsg({ ok: true, text: "Mensagem enviada." });
    } catch (err) {
      setSendMsg({ ok: false, text: errText(err, "Não foi possível enviar a mensagem.") });
    } finally {
      setSending(false);
    }
  }

  if (loading || !snap) {
    return <div style={{ padding: 40, textAlign: "center", color: "var(--color-text-secondary)" }}>Carregando...</div>;
  }

  const meta = STATUS_META[snap.status] || STATUS_META.idle;
  const isConnected = snap.status === "connected";
  const showQr = snap.status === "awaiting_qr" && snap.qr;

  return (
    <div className="unpad-mobile" style={{ padding: "28px 32px", maxWidth: 640 }}>
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 20, fontWeight: 700, color: "var(--color-text-primary)" }}>WhatsNimbus</div>
        <div style={{ fontSize: 13, color: "var(--color-text-secondary)", marginTop: 4 }}>
          O WhatsApp do sistema. É por ele que o Nimbus avisa cada usuário sobre WhatsApp desconectado,
          campanhas pausadas/paradas, buscas de produtos e fila vazia. Conecte um número dedicado aqui.
        </div>
      </div>

      {error && (
        <div style={{ background: "var(--danger-bg)", color: "var(--danger-text)", borderRadius: 8, padding: "10px 14px", marginBottom: 16, fontSize: 13 }}>
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
            <img src={snap.qr} alt="QR Code WhatsNimbus" style={{ width: "min(240px, 100%)", height: "auto", aspectRatio: "1", borderRadius: 8, background: "#fff", padding: 8 }} />
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

      {isConnected && (
        <div style={{ ...cardStyle, marginTop: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: "var(--color-text-primary)" }}>Enviar mensagem</div>
            <button
              onClick={loadGroups}
              disabled={groupsLoading}
              style={{ background: "transparent", border: "none", color: PRIMARY, fontSize: 12, fontWeight: 600, cursor: "pointer" }}
            >
              {groupsLoading ? "Carregando..." : "Atualizar grupos"}
            </button>
          </div>

          {groupsError && (
            <div style={{ background: "var(--danger-bg)", color: "var(--danger-text)", borderRadius: 8, padding: "10px 14px", marginBottom: 12, fontSize: 13 }}>
              {groupsError}
            </div>
          )}

          <div style={{ marginBottom: 12 }}>
            <label style={labelStyle}>Grupo</label>
            <select style={fieldStyle} value={sendJid} onChange={e => setSendJid(e.target.value)} disabled={groupsLoading || sending}>
              <option value="">
                {groupsLoading ? "Carregando grupos..." : (groups.length ? "Selecione um grupo" : "Nenhum grupo encontrado")}
              </option>
              {groups.map(g => (
                <option key={g.jid} value={g.jid}>{g.name || g.jid}{g.members ? ` (${g.members})` : ""}</option>
              ))}
            </select>
          </div>

          <div style={{ marginBottom: 12 }}>
            <label style={labelStyle}>Mensagem</label>
            <textarea
              style={{ ...fieldStyle, minHeight: 100, resize: "vertical" }}
              value={sendText}
              onChange={e => setSendText(e.target.value)}
              placeholder="Escreva a mensagem..."
              disabled={sending}
            />
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button style={{ ...btnPrimary, opacity: (!sendJid || !sendText.trim() || sending) ? 0.5 : 1 }} onClick={send} disabled={!sendJid || !sendText.trim() || sending}>
              {sending ? "Enviando..." : "Enviar"}
            </button>
            {sendMsg && (
              <span style={{ fontSize: 13, color: sendMsg.ok ? "#15803D" : "var(--danger-text)" }}>{sendMsg.text}</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
