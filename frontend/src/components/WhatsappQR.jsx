import { useEffect, useRef, useState } from "react";
import { PRIMARY, PRIMARY_DARK } from "../data/constants";
import { startWASession, getWASession, deleteWASession, errText} from "../data/api";
import Spinner from "./ui/Spinner";

// Inicia (ou retoma) a sessão Baileys do `sessionId` no backend e
// faz polling no status. Mostra QR enquanto aguarda scan; chama
// onConnected({ phone, name, jid }) ao conectar.
export default function WhatsappQR({ sessionId, onConnected, onError, autoStart = true }) {
  const [state, setState] = useState({ status: "starting", qr: null, info: null, error: null });
  // Bump força o efeito abaixo a reiniciar (novo startWASession + polling) —
  // usado pelo "cancele e tente novamente" pra pedir um QR fresco.
  const [restartNonce, setRestartNonce] = useState(0);
  const pollRef = useRef(null);
  const stoppedRef = useRef(false);
  // onConnected/onError em refs, atualizadas a cada render: o polling abaixo
  // roda dentro de um único useEffect (deps [sessionId, autoStart]) que não
  // reinicia a cada tecla digitada no apelido do número — sem isso, `tick()`
  // sempre chamaria a versão de `onConnected` capturada no mount, fechada
  // sobre o apelido que existia antes do usuário digitar o dele.
  const onConnectedRef = useRef(onConnected);
  const onErrorRef = useRef(onError);
  useEffect(() => { onConnectedRef.current = onConnected; }, [onConnected]);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);

  useEffect(() => {
    let cancelled = false;
    stoppedRef.current = false;

    async function run() {
      try {
        if (autoStart) await startWASession(sessionId);
      } catch (err) {
        if (cancelled) return;
        setState(s => ({ ...s, status: "error", error: errText(err, "Não foi possível conectar o WhatsApp.") }));
        onErrorRef.current?.(err);
        return;
      }

      const tick = async () => {
        if (stoppedRef.current || cancelled) return;
        try {
          const s = await getWASession(sessionId);
          if (cancelled) return;
          setState({ status: s.status, qr: s.qr, info: s.info, error: s.lastError });
          if (s.status === "connected" && s.info) {
            stoppedRef.current = true;
            onConnectedRef.current?.(s.info);
            return;
          }
        } catch (err) {
          if (!cancelled) setState(s => ({ ...s, error: errText(err, "Não foi possível conectar o WhatsApp.") }));
        }
        pollRef.current = setTimeout(tick, 1500);
      };
      tick();
    }

    run();
    return () => {
      cancelled = true;
      stoppedRef.current = true;
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [sessionId, autoStart, restartNonce]);

  // "cancele e tente novamente": apaga a sessão atual (QR expirado/travado) e
  // reinicia do zero via restartNonce, pedindo um QR novo ao backend.
  const cancelAndCleanup = async () => {
    stoppedRef.current = true;
    if (pollRef.current) clearTimeout(pollRef.current);
    setState({ status: "starting", qr: null, info: null, error: null });
    try { await deleteWASession(sessionId); } catch {}
    setRestartNonce(n => n + 1);
  };

  return (
    <div>
      <div style={{ background: "var(--color-background-secondary)", borderRadius: 12, padding: 20, textAlign: "center", marginBottom: 14, minHeight: 280 }}>
        {state.status === "starting" || (state.status === "connecting" && !state.qr) ? (
          <div style={{ padding: "60px 0", color: "var(--color-text-secondary)", display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
            <Spinner size={30} />
            <div style={{ fontSize: 13 }}>Conectando... sincronizando suas conversas</div>
          </div>
        ) : state.status === "awaiting_qr" && state.qr ? (
          <>
            <img src={state.qr} alt="QR Code WhatsApp" style={{ width: 240, height: 240, borderRadius: 8, background: "#fff", padding: 8 }} />
            <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 12, lineHeight: 1.5, textAlign: "left", maxWidth: 280, margin: "12px auto 0" }}>
              1. Abra o WhatsApp no celular<br />
              2. <strong>Menu</strong> &rarr; <strong>Dispositivos vinculados</strong><br />
              3. Toque em <strong>Vincular dispositivo</strong><br />
              4. Aponte a câmera para este QR Code
            </div>
          </>
        ) : state.status === "connected" ? (
          <div style={{ padding: "60px 0" }}>
            <div style={{ fontSize: 36, marginBottom: 10 }}>✓</div>
            <div style={{ fontSize: 14, fontWeight: 500, color: PRIMARY_DARK }}>Conectado!</div>
            {state.info?.name && <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 4 }}>{state.info.name}</div>}
            {state.info?.phone && <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>+{state.info.phone}</div>}
          </div>
        ) : state.status === "error" || (state.error && (state.status === "disconnected" || state.status === "logged_out")) ? (
          <div style={{ padding: "60px 20px", color: "var(--danger-text)" }}>
            <div style={{ fontSize: 28, marginBottom: 10 }}>⚠</div>
            <div style={{ fontSize: 13, fontWeight: 500 }}>Erro de conexão</div>
            <div style={{ fontSize: 12, marginTop: 6 }}>{state.error}</div>
          </div>
        ) : (
          <div style={{ padding: "60px 0", color: "var(--color-text-secondary)", fontSize: 13 }}>
            Status: {state.status}
          </div>
        )}
      </div>
      {state.status !== "connected" && (
        <div style={{ fontSize: 11, color: "var(--color-text-secondary)", textAlign: "center" }}>
          O QR expira em ~30s. Se não funcionar, <button onClick={cancelAndCleanup} style={{ background: "transparent", border: "none", color: PRIMARY, cursor: "pointer", fontSize: 11, padding: 0 }}>cancele e tente novamente</button>.
        </div>
      )}
    </div>
  );
}
