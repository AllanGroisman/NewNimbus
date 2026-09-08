import { useEffect, useRef, useState } from "react";
import { PRIMARY, PRIMARY_DARK } from "../data/constants";
import { startWASession, getWASession, deleteWASession, requestWAPairingCode, listWASessions, errText } from "../data/api";
import { maskWhatsappPhoneInput, toWhatsappPhone, formatWhatsappPhone } from "../data/phone";
import Spinner from "./ui/Spinner";

// Inicia (ou retoma) a sessão Baileys do `sessionId` no backend e
// faz polling no status. Chama onConnected({ phone, name, jid }) ao conectar.
//
// Dois modos de vincular, sobre a MESMA sessão e o MESMO socket:
//   - "qr":   mostra o QR pra câmera do celular (padrão, fluxo de sempre).
//   - "code": o usuário digita o telefone, recebe 8 caracteres e os digita no
//             celular (Dispositivos vinculados › Vincular com número de telefone).
// Pedir um código reabre o socket no backend (o `browser` do pareamento precisa
// ser diferente — ver PAIRING_BROWSER em whatsapp/local.js), mas isso é invisível
// aqui: o polling, o branch "conectado" e o onConnected são os mesmos nos dois.
const inputStyle = {
  padding: "9px 12px", borderRadius: 8, marginTop: 6,
  border: "0.5px solid var(--color-border-tertiary)",
  background: "var(--color-background-secondary)",
  fontSize: 13, fontFamily: "inherit", color: "var(--color-text-primary)",
  width: "100%", boxSizing: "border-box",
};

function modeButtonStyle(active) {
  return {
    flex: 1, padding: "7px 10px", borderRadius: 8, fontSize: 12, cursor: "pointer",
    fontWeight: active ? 500 : 400,
    background: active ? PRIMARY : "transparent",
    color: active ? "#fff" : "var(--color-text-secondary)",
    border: active ? "none" : "0.5px solid var(--color-border-tertiary)",
  };
}

// 92 → "1:32". Só pra contagem regressiva do código.
function mmss(seconds) {
  const s = Math.max(0, seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export default function WhatsappQR({ sessionId, onConnected, onError, autoStart = true, defaultPhone = "", knownNumberIds = [] }) {
  const [state, setState] = useState({ status: "starting", qr: null, info: null, error: null });
  const [mode, setMode] = useState("qr");
  // phase: form (pedindo o telefone) → loading → code (mostrando) → expired.
  const [pair, setPair] = useState({
    phase: "form", phone: maskWhatsappPhoneInput(defaultPhone || ""),
    code: null, formatted: null, expiresAt: null, error: null,
  });
  const [remaining, setRemaining] = useState(null);
  const [copied, setCopied] = useState(false);
  // Bump força o efeito abaixo a reiniciar (novo startWASession + polling) —
  // usado pelo "cancele e tente novamente" pra pedir um QR fresco.
  const [restartNonce, setRestartNonce] = useState(0);
  const pollRef = useRef(null);
  const stoppedRef = useRef(false);
  // Enquanto uma operação apaga e recria a sessão (gerar novo código), o GET
  // responde 404 por alguns instantes. Sem esta trava o polling pintaria um erro
  // de conexão no meio de uma ação que está dando certo.
  const busyRef = useRef(false);
  const phoneRef = useRef(null);
  // onConnected/onError em refs, atualizadas a cada render: o polling abaixo
  // roda dentro de um único useEffect (deps [sessionId, autoStart]) que não
  // reinicia a cada tecla digitada no apelido do número — sem isso, `tick()`
  // sempre chamaria a versão de `onConnected` capturada no mount, fechada
  // sobre o apelido que existia antes do usuário digitar o dele.
  const onConnectedRef = useRef(onConnected);
  const onErrorRef = useRef(onError);
  useEffect(() => { onConnectedRef.current = onConnected; }, [onConnected]);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);
  // Ids já no painel, em ref pela mesma razão das callbacks: o polling vive num
  // useEffect que não reinicia a cada render.
  const knownIdsRef = useRef(knownNumberIds);
  useEffect(() => { knownIdsRef.current = knownNumberIds; }, [knownNumberIds]);
  // Dispara um tick imediato (usado pelo visibilitychange). Preenchido pelo efeito.
  const tickNowRef = useRef(null);

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

      // A sessão provisória some quando o backend a renomeia pro id-telefone. O
      // backend deixa um alias no lugar (10 min), mas se até ele expirou o GET dá
      // 404 e ficaríamos polando um id morto pra sempre. Neste caso perguntamos a
      // lista de sessões: uma sessão conectada que o painel ainda não conhece é,
      // necessariamente, a que acabamos de vincular.
      const recoverFrom404 = async () => {
        const rows = await listWASessions();
        const known = new Set((knownIdsRef.current || []).map(String));
        return (rows || []).find(
          r => r.status === "connected" && r.info?.phone && !known.has(String(r.numberId)),
        ) || null;
      };

      const tick = async () => {
        if (stoppedRef.current || cancelled) return;
        if (pollRef.current) { clearTimeout(pollRef.current); pollRef.current = null; }
        if (busyRef.current) {
          pollRef.current = setTimeout(tick, 1500);
          return;
        }
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
          if (cancelled) return;
          if (err?.status === 404) {
            try {
              const found = await recoverFrom404();
              if (cancelled) return;
              if (found) {
                setState({ status: "connected", qr: null, info: found.info, error: null });
                stoppedRef.current = true;
                onConnectedRef.current?.(found.info);
                return;
              }
            } catch { /* segue pro erro genérico abaixo */ }
          }
          setState(s => ({ ...s, error: errText(err, "Não foi possível conectar o WhatsApp.") }));
        }
        pollRef.current = setTimeout(tick, 1500);
      };
      tickNowRef.current = tick;
      tick();
    }

    run();
    return () => {
      cancelled = true;
      stoppedRef.current = true;
      tickNowRef.current = null;
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [sessionId, autoStart, restartNonce]);

  // Vincular pelo código de 8 dígitos obriga a sair do navegador pra digitar no
  // celular, e o navegador do celular congela o polling da aba em segundo plano —
  // foi assim que a confirmação de "conectado" era perdida. Ao voltar, consulta na
  // hora em vez de esperar o próximo intervalo de 1,5s.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (stoppedRef.current || busyRef.current) return;
      tickNowRef.current?.();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  // Contagem regressiva do código. O prazo que mostramos é menor que a vida real
  // do socket de propósito (ver PAIRING_CODE_TTL_MS no backend): queremos
  // oferecer "gerar novo código" ANTES do servidor derrubar a sessão sozinho.
  useEffect(() => {
    if (pair.phase !== "code" || !pair.expiresAt) { setRemaining(null); return; }
    const compute = () => {
      const left = Math.round((pair.expiresAt - Date.now()) / 1000);
      setRemaining(left);
      if (left <= 0) setPair(p => (p.phase === "code" ? { ...p, phase: "expired" } : p));
    };
    compute();
    const id = setInterval(compute, 1000);
    return () => clearInterval(id);
  }, [pair.phase, pair.expiresAt]);

  const askCode = async (phoneDigits) => {
    busyRef.current = true;
    // O pedido reabre o socket no backend, então o estado publicado de antes deixa de
    // valer. Zerar aqui é o que impede um código NOVO de nascer marcado como morto
    // (codeDead) por causa do erro que derrubou o anterior — o polling está pausado e
    // só traria o estado fresco depois.
    setState(s => ({ ...s, status: "connecting", qr: null, error: null }));
    setPair(p => ({ ...p, phase: "loading", code: null, formatted: null, expiresAt: null, error: null }));
    setCopied(false);
    try {
      const r = await requestWAPairingCode(sessionId, phoneDigits);
      setPair(p => ({ ...p, phase: "code", code: r.code, formatted: r.formatted, expiresAt: r.expiresAt, error: null }));
    } catch (err) {
      setPair(p => ({ ...p, phase: "form", error: errText(err, "Não foi possível gerar o código. Tente de novo.") }));
    } finally {
      busyRef.current = false;
    }
  };

  const submitPhone = (e) => {
    e?.preventDefault();
    const stored = toWhatsappPhone(pair.phone);
    if (!stored) {
      setPair(p => ({ ...p, error: "Informe um celular válido com DDD." }));
      return;
    }
    askCode(stored);
  };

  // Gerar outro código: é só pedir de novo. Quem garante que o pedido parte de uma
  // credencial limpa é o backend (ver a auth de pareamento incompleta em
  // whatsapp/local.js) — antes daquilo esta função apagava a sessão pelo DELETE, o
  // que abria uma janela de 404 no polling e, numa sessão que tinha ACABADO de
  // parear, chamaria sock.logout() e desvincularia o aparelho.
  const regenerate = async () => {
    const stored = toWhatsappPhone(pair.phone);
    if (!stored) { setPair(p => ({ ...p, phase: "form", error: "Informe um celular válido com DDD." })); return; }
    await askCode(stored);
  };

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(pair.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard bloqueado: o código está na tela, dá pra digitar */ }
  };

  // "cancele e tente novamente": apaga a sessão atual (QR expirado/travado) e
  // reinicia do zero via restartNonce, pedindo um QR novo ao backend.
  const cancelAndCleanup = async () => {
    stoppedRef.current = true;
    if (pollRef.current) clearTimeout(pollRef.current);
    setState({ status: "starting", qr: null, info: null, error: null });
    setPair(p => ({ ...p, phase: "form", code: null, formatted: null, expiresAt: null, error: null }));
    try { await deleteWASession(sessionId); } catch {}
    setRestartNonce(n => n + 1);
  };

  const switchMode = (next) => {
    setMode(next);
    // O Modal foca o primeiro input no mount, quando o campo de telefone ainda
    // nem existe (o modo padrão é QR). Focamos aqui pra quem escolhe o código
    // poder já digitar.
    if (next === "code") setTimeout(() => phoneRef.current?.focus(), 0);
  };

  const connected = state.status === "connected";
  const failed = state.status === "error" || (state.error && (state.status === "disconnected" || state.status === "logged_out"));
  // Sessão caiu com um código na tela. O backend já manda o texto certo pra este
  // caso ("O código não foi usado a tempo. Gere um novo.", "Confira o número..." —
  // ver classifyClose), então mostramos a mensagem DENTRO do painel do código, com o
  // botão de gerar outro. O painel genérico "Erro de conexão" seria um beco sem
  // saída: ele esconde os botões de modo e o único caminho de volta é o link de
  // cancelar lá embaixo.
  const codeDead = failed && mode === "code" && (pair.phase === "code" || pair.phase === "expired");
  // Código morto (expirado no relógio ou derrubado junto com a sessão).
  const codeOver = pair.phase === "expired" || codeDead;

  return (
    <div>
      {!connected && (!failed || codeDead) && (
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <button type="button" onClick={() => switchMode("qr")} style={modeButtonStyle(mode === "qr")}>QR Code</button>
          <button type="button" onClick={() => switchMode("code")} style={modeButtonStyle(mode === "code")}>Código de 8 dígitos</button>
        </div>
      )}

      <div style={{ background: "var(--color-background-secondary)", borderRadius: 12, padding: 20, textAlign: "center", marginBottom: 14, minHeight: 280 }}>
        {connected ? (
          <div style={{ padding: "60px 0" }}>
            <div style={{ fontSize: 36, marginBottom: 10 }}>✓</div>
            <div style={{ fontSize: 14, fontWeight: 500, color: PRIMARY_DARK }}>Conectado!</div>
            {state.info?.name && <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 4 }}>{state.info.name}</div>}
            {state.info?.phone && <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>+{state.info.phone}</div>}
          </div>
        ) : failed && !codeDead ? (
          <div style={{ padding: "60px 20px", color: "var(--danger-text)" }}>
            <div style={{ fontSize: 28, marginBottom: 10 }}>⚠</div>
            <div style={{ fontSize: 13, fontWeight: 500 }}>Erro de conexão</div>
            <div style={{ fontSize: 12, marginTop: 6 }}>{state.error}</div>
          </div>
        ) : mode === "code" ? (
          pair.phase === "loading" ? (
            <div style={{ padding: "60px 0", color: "var(--color-text-secondary)", display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
              <Spinner size={30} />
              <div style={{ fontSize: 13 }}>Gerando o código...</div>
            </div>
          ) : pair.phase === "code" || pair.phase === "expired" ? (
            <div style={{ padding: "24px 0" }}>
              <div style={{
                fontSize: 34, fontWeight: 600, letterSpacing: 3,
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                color: codeOver ? "var(--color-text-secondary)" : "var(--color-text-primary)",
                opacity: codeOver ? 0.5 : 1,
              }}>
                {pair.formatted}
              </div>
              {!codeOver ? (
                <>
                  <div style={{ marginTop: 8, display: "flex", gap: 10, justifyContent: "center", alignItems: "center" }}>
                    <button type="button" onClick={copyCode} style={{ background: "transparent", border: "none", color: PRIMARY, cursor: "pointer", fontSize: 12, padding: 0 }}>
                      {copied ? "Copiado!" : "Copiar código"}
                    </button>
                    {remaining !== null && (
                      <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>Expira em {mmss(remaining)}</span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 6 }}>
                    Código para <strong>{formatWhatsappPhone(pair.phone)}</strong>
                  </div>
                  <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 14, lineHeight: 1.5, textAlign: "left", maxWidth: 300, margin: "14px auto 0" }}>
                    1. Abra o WhatsApp no celular<br />
                    2. <strong>Menu</strong> &rarr; <strong>Dispositivos vinculados</strong><br />
                    3. Toque em <strong>Vincular dispositivo</strong><br />
                    4. Toque em <strong>Vincular com número de telefone</strong><br />
                    5. Digite o código acima
                  </div>
                </>
              ) : (
                <div style={{ marginTop: 14 }}>
                  <div style={{ fontSize: 12, color: codeDead ? "var(--danger-text)" : "var(--color-text-secondary)", marginBottom: 10 }}>
                    {codeDead ? (state.error || "A conexão caiu antes de o código ser usado.") : "O código expirou."}
                  </div>
                  <button type="button" onClick={regenerate} style={{ padding: "7px 14px", borderRadius: 8, background: PRIMARY, color: "#fff", border: "none", fontSize: 12, fontWeight: 500, cursor: "pointer" }}>
                    Gerar novo código
                  </button>
                </div>
              )}
            </div>
          ) : (
            <form onSubmit={submitPhone} style={{ padding: "40px 4px", textAlign: "left", maxWidth: 300, margin: "0 auto" }}>
              <label style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "block" }}>
                Celular (com DDD)
                <input
                  ref={phoneRef}
                  value={pair.phone}
                  onChange={e => setPair(p => ({ ...p, phone: maskWhatsappPhoneInput(e.target.value), error: null }))}
                  inputMode="tel"
                  placeholder="(11) 99999-9999"
                  autoComplete="tel-national"
                  maxLength={15}
                  style={inputStyle}
                />
              </label>
              {pair.error && (
                <div role="alert" style={{ fontSize: 12, color: "var(--danger-text)", marginTop: 8 }}>{pair.error}</div>
              )}
              <button type="submit" style={{ marginTop: 12, width: "100%", padding: "9px 14px", borderRadius: 8, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, fontWeight: 500, cursor: "pointer" }}>
                Gerar código
              </button>
              <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 10, lineHeight: 1.5 }}>
                Digite o número como você o informa no WhatsApp, com DDD. Contas
                antigas de 8 dígitos também valem. O código é gerado sem o WhatsApp
                avisar se o número está errado — confira antes de digitar no celular.
              </div>
            </form>
          )
        ) : state.status === "starting" || (state.status === "connecting" && !state.qr) ? (
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
        ) : (
          <div style={{ padding: "60px 0", color: "var(--color-text-secondary)", fontSize: 13 }}>
            Status: {state.status}
          </div>
        )}
      </div>
      {!connected && (
        <div style={{ fontSize: 11, color: "var(--color-text-secondary)", textAlign: "center" }}>
          {mode === "qr" ? "O QR expira em ~30s. " : "O código vale por ~2 minutos. "}
          Se não funcionar, <button onClick={cancelAndCleanup} style={{ background: "transparent", border: "none", color: PRIMARY, cursor: "pointer", fontSize: 11, padding: 0 }}>cancele e tente novamente</button>.
        </div>
      )}
    </div>
  );
}
