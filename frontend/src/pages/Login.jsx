import { useState, useEffect, useRef } from "react";
import { PRIMARY, popQueryParam } from "../data/constants";
import Logo from "../components/ui/Logo";
import { passwordChecks, passwordOk, MIN_PASSWORD } from "../data/password";
import { isValidPhone, maskPhoneInput, toStoredPhone } from "../data/phone";

import {
  authLogin, authRegister, authGoogle,
  authVerifyEmail, authResendVerification,
  authForgotPassword, authResetPassword,
  authRegistrationStatus,
  errText,
} from "../data/api";

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || "";

// Limites devem bater com backend/auth/pg.js (MAX_NAME_LEN, etc).
const LIMITS = {
  name: 100,
  email: 254,
  password: 128,
};
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function Login({ onLogin }) {
  // mode: "login" | "register" | "forgot" | "registered" | "verifying" | "reset"
  const [mode, setMode] = useState("login");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [info, setInfo] = useState(null);
  const [infoMessage, setInfoMessage] = useState(null);
  const [resetToken, setResetToken] = useState(null);
  const [resendCooldown, setResendCooldown] = useState(0); // segundos restantes
  const [signupOpen, setSignupOpen] = useState(true); // beta fechado esconde cadastro
  const googleBtnRef = useRef(null);

  // Descobre se o cadastro está aberto (beta fechado). Em erro, mantém aberto.
  useEffect(() => {
    let alive = true;
    authRegistrationStatus()
      .then(r => {
        if (!alive) return;
        setSignupOpen(!r.blocked);
        // Se caiu na aba de cadastro mas está fechado, volta pro login.
        if (r.blocked) setMode(m => (m === "register" ? "login" : m));
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  // Countdown do cooldown de reenvio
  useEffect(() => {
    if (resendCooldown <= 0) return;
    const t = setTimeout(() => setResendCooldown(s => s - 1), 1000);
    return () => clearTimeout(t);
  }, [resendCooldown]);

  // Captura ?verify=token / ?reset=token na primeira carga.
  useEffect(() => {
    const verify = popQueryParam("verify");
    if (verify) {
      setMode("verifying");
      setLoading(true);
      authVerifyEmail(verify)
        .then(r => {
          if (r.user) onLogin(r.user);
        })
        .catch(err => {
          setError(errText(err, "Falha ao verificar email"));
          setMode("login");
        })
        .finally(() => setLoading(false));
      return;
    }
    const reset = popQueryParam("reset");
    if (reset) {
      setResetToken(reset);
      setMode("reset");
      setPassword("");
      setPassword2("");
    }
  }, [onLogin]);

  function switchMode(m) {
    setMode(m);
    setError(null);
    setInfo(null);
    setPassword("");
    setPassword2("");
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (loading) return;
    setError(null);
    setInfo(null);

    try {
      if (mode === "register") {
        const cleanName = name.trim();
        const cleanEmail = email.trim().toLowerCase();
        if (!cleanName) return setError("Nome obrigatório");
        if (cleanName.length > LIMITS.name) return setError(`Nome muito longo (máx ${LIMITS.name})`);
        if (!EMAIL_RE.test(cleanEmail)) return setError("Email inválido");
        if (cleanEmail.length > LIMITS.email) return setError(`Email muito longo (máx ${LIMITS.email})`);
        if (!isValidPhone(phone)) return setError("Informe um celular válido com DDD");
        if (!passwordOk(password)) return setError("Senha não atende aos requisitos");
        if (password !== password2) return setError("As senhas não coincidem");
        setLoading(true);
        await authRegister({ name: cleanName, email: cleanEmail, password, phone: toStoredPhone(phone) });
        setMode("registered");
        setInfo(cleanEmail);
      } else if (mode === "login") {
        const cleanEmail = email.trim().toLowerCase();
        if (!EMAIL_RE.test(cleanEmail)) return setError("Email inválido");
        if (!password) return setError("Informe sua senha");
        setLoading(true);
        const res = await authLogin({ email: cleanEmail, password });
        onLogin(res.user);
      } else if (mode === "forgot") {
        const cleanEmail = email.trim().toLowerCase();
        if (!EMAIL_RE.test(cleanEmail)) return setError("Email inválido");
        setLoading(true);
        await authForgotPassword(cleanEmail);
        setInfo("Se houver uma conta com este email, enviamos um link de reset. Verifique sua caixa de entrada.");
      } else if (mode === "reset") {
        if (!passwordOk(password)) return setError("Senha não atende aos requisitos");
        if (password !== password2) return setError("As senhas não coincidem");
        setLoading(true);
        const res = await authResetPassword(resetToken, password);
        if (res.user) onLogin(res.user);
      }
    } catch (err) {
      if (err.code === "email_not_verified") {
        setError(errText(err, "Não foi possível entrar. Tente novamente."));
        setMode("registered");
        setInfo(email.trim().toLowerCase());
      } else {
        setError(errText(err, "Falha ao processar"));
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleResend() {
    if (!info || resendCooldown > 0) return;
    setLoading(true);
    setError(null);
    try {
      await authResendVerification(info);
      setInfoMessage("Email reenviado. Verifique sua caixa de entrada (e o spam).");
      setResendCooldown(120);
    } catch (err) {
      if (err.code === "resend_cooldown" && err.retryAfterSeconds) {
        setResendCooldown(err.retryAfterSeconds);
        setError(null);
      } else {
        setError(errText(err, "Falha ao reenviar"));
      }
    } finally {
      setLoading(false);
    }
  }

  // Google Identity Services — só faz sentido em login/register.
  useEffect(() => {
    if (!GOOGLE_CLIENT_ID) return;
    if (mode !== "login" && mode !== "register") return;
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
        setError(errText(err, "Falha no login Google"));
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
        text: mode === "register" ? "signup_with" : "signin_with",
        shape: "rectangular",
        logo_alignment: "left",
      });
    }
    tryInit();
    return () => { cancelled = true; };
  }, [mode, onLogin]);

  const inputStyle = {
    padding: "9px 12px",
    borderRadius: 8,
    border: "0.5px solid var(--color-border-tertiary)",
    background: "var(--color-background-secondary)",
    fontSize: 13,
    fontFamily: "inherit",
    color: "var(--color-text-primary)",
  };

  // Indicador visual da senha — checklist.
  const checks = passwordChecks(password);
  const checksMatch = password.length > 0 && password === password2;
  const showPwChecks = (mode === "register" || mode === "reset") && password.length > 0;

  const CheckLine = ({ ok, label }) => (
    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: ok ? "#22C55E" : "var(--color-text-secondary)" }}>
      <span style={{ width: 12, textAlign: "center" }}>{ok ? "✓" : "○"}</span>
      <span>{label}</span>
    </div>
  );

  // Conteúdo principal por modo
  let body;
  if (mode === "verifying") {
    body = (
      <div style={{ textAlign: "center", padding: "12px 0" }}>
        <div style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>Verificando seu email…</div>
      </div>
    );
  } else if (mode === "registered") {
    body = (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ background: "var(--success-bg)", border: "0.5px solid var(--success-border)", color: "var(--success-text)", borderRadius: 8, padding: "10px 12px", fontSize: 12 }}>
          Enviamos um link de confirmação para <strong>{info}</strong>.
          <br />Clique no link para ativar sua conta.
        </div>
        {infoMessage && (
          <div style={{ background: "var(--success-bg)", border: "0.5px solid var(--success-border)", color: "var(--success-text)", borderRadius: 8, padding: "8px 10px", fontSize: 12 }}>{infoMessage}</div>
        )}
        {error && (
          <div style={{ background: "var(--danger-bg)", border: "0.5px solid var(--danger-border)", color: "var(--danger-text)", borderRadius: 8, padding: "8px 10px", fontSize: 12 }}>{error}</div>
        )}
        <button type="button" onClick={handleResend} disabled={loading || resendCooldown > 0} style={{ width: "100%", padding: 10, borderRadius: 10, background: "transparent", color: resendCooldown > 0 ? "var(--color-text-secondary)" : PRIMARY, border: `0.5px solid ${resendCooldown > 0 ? "var(--color-border-tertiary)" : PRIMARY}`, fontSize: 13, cursor: (loading || resendCooldown > 0) ? "default" : "pointer", fontWeight: 500 }}>
          {loading ? "Reenviando…" : resendCooldown > 0 ? `Reenviar em ${resendCooldown}s` : "Reenviar email de verificação"}
        </button>
        <button type="button" onClick={() => switchMode("login")} style={{ background: "transparent", border: "none", cursor: "pointer", fontSize: 12, color: "var(--color-text-secondary)" }}>
          Voltar para o login
        </button>
      </div>
    );
  } else {
    body = (
      <form onSubmit={handleSubmit}>
        {(mode === "login" || mode === "register") && GOOGLE_CLIENT_ID && (
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
          {mode === "register" && (
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Nome completo"
              autoComplete="name"
              required
              maxLength={LIMITS.name}
              style={inputStyle}
            />
          )}
          {mode === "register" && (
            <input
              value={phone}
              onChange={e => setPhone(maskPhoneInput(e.target.value))}
              type="tel"
              inputMode="tel"
              placeholder="WhatsApp (com DDD)"
              autoComplete="tel-national"
              required
              maxLength={15}
              style={inputStyle}
            />
          )}
          {mode !== "reset" && (
            <input
              value={email}
              onChange={e => setEmail(e.target.value)}
              type="email"
              placeholder="Email"
              autoComplete="email"
              required
              maxLength={LIMITS.email}
              style={inputStyle}
            />
          )}
          {mode !== "forgot" && (
            <input
              value={password}
              onChange={e => setPassword(e.target.value)}
              type="password"
              placeholder={mode === "reset" ? "Nova senha" : "Senha"}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              required
              minLength={mode === "login" ? 1 : MIN_PASSWORD}
              maxLength={LIMITS.password}
              style={inputStyle}
            />
          )}
          {(mode === "register" || mode === "reset") && (
            <input
              value={password2}
              onChange={e => setPassword2(e.target.value)}
              type="password"
              placeholder="Confirmar senha"
              autoComplete="new-password"
              required
              minLength={MIN_PASSWORD}
              maxLength={LIMITS.password}
              style={inputStyle}
            />
          )}
        </div>

        {showPwChecks && (
          <div style={{ background: "var(--color-background-secondary)", borderRadius: 8, padding: "8px 10px", marginBottom: 12, display: "flex", flexDirection: "column", gap: 3 }}>
            <CheckLine ok={checks.length} label={`Ao menos ${MIN_PASSWORD} caracteres`} />
            <CheckLine ok={checks.upper} label="Uma letra maiúscula" />
            <CheckLine ok={checks.lower} label="Uma letra minúscula" />
            <CheckLine ok={checks.number} label="Um número" />
            {password2.length > 0 && <CheckLine ok={checksMatch} label="Senhas coincidem" />}
          </div>
        )}

        {error && (
          <div style={{ background: "var(--danger-bg)", border: "0.5px solid var(--danger-border)", color: "var(--danger-text)", borderRadius: 8, padding: "8px 10px", fontSize: 12, marginBottom: 12 }}>{error}</div>
        )}
        {info && mode === "forgot" && (
          <div style={{ background: "var(--success-bg)", border: "0.5px solid var(--success-border)", color: "var(--success-text)", borderRadius: 8, padding: "8px 10px", fontSize: 12, marginBottom: 12 }}>{info}</div>
        )}

        <button type="submit" disabled={loading} style={{ width: "100%", padding: 10, borderRadius: 10, background: PRIMARY, color: "#fff", border: "none", fontSize: 14, cursor: loading ? "wait" : "pointer", fontWeight: 500, opacity: loading ? 0.7 : 1 }}>
          {loading ? "Aguarde..." : (
            mode === "register" ? "Criar conta"
            : mode === "forgot" ? "Enviar link de reset"
            : mode === "reset" ? "Redefinir senha"
            : "Entrar"
          )}
        </button>

        {mode === "login" && (
          <div style={{ textAlign: "center", marginTop: 12, fontSize: 12 }}>
            <span onClick={() => switchMode("forgot")} style={{ cursor: "pointer", color: PRIMARY }}>Esqueci minha senha</span>
          </div>
        )}
        {mode === "forgot" && (
          <div style={{ textAlign: "center", marginTop: 12, fontSize: 12 }}>
            <span onClick={() => switchMode("login")} style={{ cursor: "pointer", color: "var(--color-text-secondary)" }}>Voltar para o login</span>
          </div>
        )}
        {mode === "reset" && (
          <div style={{ textAlign: "center", marginTop: 12, fontSize: 12 }}>
            <span onClick={() => switchMode("login")} style={{ cursor: "pointer", color: "var(--color-text-secondary)" }}>Voltar para o login</span>
          </div>
        )}
      </form>
    );
  }

  // Tabs Entrar/Cadastrar só aparecem em login/register — e some quando o
  // cadastro está fechado (beta), deixando só o login.
  const showTabs = (mode === "login" || mode === "register") && signupOpen;

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 16, padding: 32, width: "100%", maxWidth: 360 }}>
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, fontSize: 28, fontWeight: 500, color: "var(--color-brand)" }}>
            <Logo size={34} />
            <span>Nimbus</span>
          </div>
          <div style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>
            {mode === "forgot" ? "Recuperar acesso"
              : mode === "reset" ? "Defina sua nova senha"
              : mode === "registered" ? "Confirme seu email"
              : "Ofertas automáticas para WhatsApp"}
          </div>
        </div>

        {showTabs && (
          <div style={{ display: "flex", marginBottom: 20, background: "var(--color-background-secondary)", borderRadius: 10, padding: 3 }}>
            {["login", "register"].map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => switchMode(m)}
                style={{
                  flex: 1, padding: "7px", borderRadius: 8, border: "none",
                  background: mode === m ? "var(--color-background-primary)" : "transparent",
                  fontSize: 13, cursor: "pointer", fontWeight: mode === m ? 500 : 400,
                  color: "var(--color-text-primary)",
                }}
              >{m === "login" ? "Entrar" : "Cadastrar"}</button>
            ))}
          </div>
        )}

        {!signupOpen && mode === "login" && (
          <div style={{ textAlign: "center", marginBottom: 16, fontSize: 12, color: "var(--color-text-secondary)" }}>
            Cadastros temporariamente fechados (beta).
          </div>
        )}

        {body}
      </div>
    </div>
  );
}
