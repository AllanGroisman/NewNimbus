import { useState, useEffect, useRef } from "react";
import { PRIMARY } from "../data/constants";
import { authLogin, authRegister, authGoogle } from "../data/api";

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || "";

export default function Login({ onLogin }) {
  const [isRegister, setIsRegister] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [phone, setPhone] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const googleBtnRef = useRef(null);

  async function handleSubmit(e) {
    e.preventDefault();
    if (loading) return;
    setError(null);
    setLoading(true);
    try {
      const res = isRegister
        ? await authRegister({ name, email, password, phone })
        : await authLogin({ email, password });
      onLogin(res.user);
    } catch (err) {
      setError(err.message || "Falha ao autenticar");
    } finally {
      setLoading(false);
    }
  }

  function switchMode(register) {
    setIsRegister(register);
    setError(null);
  }

  // Google Identity Services — renderiza o botão quando o script carregar.
  // Tenta a cada 200ms por até 5s pra cobrir slow networks.
  useEffect(() => {
    if (!GOOGLE_CLIENT_ID) return;
    let cancelled = false;
    let attempts = 0;

    async function handleCredential(resp) {
      if (!resp?.credential) return;
      setError(null);
      setLoading(true);
      try {
        const r = await authGoogle(resp.credential);
        onLogin(r.user);
      } catch (err) {
        setError(err.message || "Falha no login Google");
      } finally {
        setLoading(false);
      }
    }

    function tryInit() {
      if (cancelled) return;
      const g = window.google?.accounts?.id;
      if (!g || !googleBtnRef.current) {
        if (attempts++ < 25) setTimeout(tryInit, 200);
        return;
      }
      g.initialize({ client_id: GOOGLE_CLIENT_ID, callback: handleCredential });
      g.renderButton(googleBtnRef.current, {
        theme: "outline",
        size: "large",
        width: 296,
        text: isRegister ? "signup_with" : "signin_with",
        shape: "rectangular",
        logo_alignment: "left",
      });
    }
    tryInit();
    return () => { cancelled = true; };
  }, [isRegister, onLogin]);

  const inputStyle = { padding: "9px 12px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13, fontFamily: "inherit" };

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <form onSubmit={handleSubmit} style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 16, padding: 32, width: "100%", maxWidth: 360 }}>
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <div style={{ fontSize: 28, fontWeight: 500, color: "#0F6E56" }}>Nimbus</div>
          <div style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>Ofertas automáticas para WhatsApp</div>
        </div>
        <div style={{ display: "flex", marginBottom: 20, background: "var(--color-background-secondary)", borderRadius: 10, padding: 3 }}>
          {["Entrar", "Cadastrar"].map((t, i) => (
            <button key={t} type="button" onClick={() => switchMode(i === 1)} style={{ flex: 1, padding: "7px", borderRadius: 8, border: "none", background: isRegister === (i === 1) ? "var(--color-background-primary)" : "transparent", fontSize: 13, cursor: "pointer", fontWeight: isRegister === (i === 1) ? 500 : 400 }}>{t}</button>
          ))}
        </div>

        {GOOGLE_CLIENT_ID && (
          <>
            <div ref={googleBtnRef} style={{ display: "flex", justifyContent: "center", marginBottom: 14 }} />
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14, color: "var(--color-text-secondary)", fontSize: 11 }}>
              <div style={{ flex: 1, height: 1, background: "var(--color-border-tertiary)" }} />
              <span>ou</span>
              <div style={{ flex: 1, height: 1, background: "var(--color-border-tertiary)" }} />
            </div>
          </>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 12 }}>
          {isRegister && (
            <input value={name} onChange={e => setName(e.target.value)} placeholder="Nome completo" autoComplete="name" required style={inputStyle} />
          )}
          <input value={email} onChange={e => setEmail(e.target.value)} type="email" placeholder="Email" autoComplete="email" required style={inputStyle} />
          <input value={password} onChange={e => setPassword(e.target.value)} type="password" placeholder="Senha" autoComplete={isRegister ? "new-password" : "current-password"} required minLength={6} style={inputStyle} />
          {isRegister && (
            <input value={phone} onChange={e => setPhone(e.target.value)} placeholder="Telefone (opcional)" autoComplete="tel" style={inputStyle} />
          )}
        </div>
        {error && (
          <div style={{ background: "#FCEBEB", border: "0.5px solid #F7C1C1", color: "#A32D2D", borderRadius: 8, padding: "8px 10px", fontSize: 12, marginBottom: 12 }}>{error}</div>
        )}
        <button type="submit" disabled={loading} style={{ width: "100%", padding: 10, borderRadius: 10, background: PRIMARY, color: "#fff", border: "none", fontSize: 14, cursor: loading ? "wait" : "pointer", fontWeight: 500, opacity: loading ? 0.7 : 1 }}>
          {loading ? "Aguarde..." : (isRegister ? "Criar conta" : "Entrar")}
        </button>
        {!isRegister && <div style={{ textAlign: "center", marginTop: 12, fontSize: 12 }}><span style={{ cursor: "pointer", color: PRIMARY }}>Esqueci minha senha</span></div>}
      </form>
    </div>
  );
}
