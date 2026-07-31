import { useState, useEffect, useRef } from "react";
import { PRIMARY } from "../data/constants";
import AuthCard, { Alert } from "../components/ui/AuthCard";
import { passwordChecks, passwordOk, MIN_PASSWORD, MAX_PASSWORD } from "../data/password";
import { publicClaim, authSetInitialPassword, setToken } from "../data/api";

// Volta do Stripe de quem assinou pela landing.
//
// O Stripe devolve em /bem-vindo?session_id=cs_…; o backend troca essa sessão
// paga por um JWT (a conta foi criada pelo pagamento), então a pessoa já chega
// logada e só escolhe a senha. Se algo falhar aqui, ninguém fica sem acesso: um
// e-mail de boas-vindas com link de definição de senha também foi enviado.
//
// O session_id é apagado da URL assim que resgatado — o resgate é de uso único.

export default function BemVindo({ onLogin }) {
  // step: "claiming" | "password" | "error"
  const [step, setStep] = useState("claiming");
  const [user, setUser] = useState(null);
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [error, setError] = useState(null);
  const [fatal, setFatal] = useState(null);
  const [saving, setSaving] = useState(false);
  const ranRef = useRef(false);

  useEffect(() => {
    // StrictMode monta duas vezes em dev — e o resgate é de uso único, então a
    // segunda chamada tomaria 410 e mostraria erro numa conta perfeitamente ok.
    if (ranRef.current) return;
    ranRef.current = true;

    const qs = new URLSearchParams(window.location.search);
    const sessionId = qs.get("session_id");
    // Tira o id da URL na hora: ele dá acesso à conta até ser resgatado.
    qs.delete("session_id");
    const rest = qs.toString();
    window.history.replaceState({}, "", window.location.pathname + (rest ? `?${rest}` : ""));

    if (!sessionId) {
      setFatal("Link inválido. Se você acabou de pagar, verifique seu e-mail para criar a senha e entrar.");
      setStep("error");
      return;
    }

    publicClaim(sessionId)
      .then(r => {
        // Conta que já existia com senha própria não é logada pelo pagamento —
        // o backend recusa de propósito. Aqui só confirmamos e mandamos entrar.
        if (r.requiresLogin) {
          setFatal(r.message);
          setStep("error");
          return;
        }
        setToken(r.token);
        setUser(r.user);
        if (r.needsPassword) setStep("password");
        else onLogin(r.user);
      })
      .catch(err => {
        setFatal(err.message || "Não foi possível concluir seu acesso.");
        setStep("error");
      });
  }, [onLogin]);

  async function handleSubmit(e) {
    e.preventDefault();
    if (saving) return;
    setError(null);
    if (!passwordOk(password)) return setError("A senha não atende aos requisitos");
    if (password !== password2) return setError("As senhas não coincidem");
    setSaving(true);
    try {
      const r = await authSetInitialPassword(password);
      onLogin(r.user || user);
    } catch (err) {
      setError(err.message || "Falha ao salvar a senha");
      setSaving(false);
    }
  }

  const inputStyle = {
    padding: "9px 12px", borderRadius: 8,
    border: "0.5px solid var(--color-border-tertiary)",
    background: "var(--color-background-secondary)",
    fontSize: 13, fontFamily: "inherit", color: "var(--color-text-primary)",
    width: "100%",
  };

  if (step === "claiming") {
    return (
      <AuthCard subtitle="Confirmando seu pagamento">
        <div style={{ textAlign: "center", padding: "12px 0", fontSize: 13, color: "var(--color-text-secondary)" }}>
          Só um instante…
        </div>
      </AuthCard>
    );
  }

  if (step === "error") {
    return (
      <AuthCard subtitle="Quase lá">
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Alert kind="info">{fatal}</Alert>
          <button
            type="button"
            onClick={() => window.location.assign("/")}
            style={{ width: "100%", padding: 11, borderRadius: 10, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, fontWeight: 500, cursor: "pointer" }}
          >
            Ir para a tela de entrada
          </button>
        </div>
      </AuthCard>
    );
  }

  const checks = passwordChecks(password);
  const CheckLine = ({ ok, label }) => (
    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: ok ? "#22C55E" : "var(--color-text-secondary)" }}>
      <span style={{ width: 12, textAlign: "center" }}>{ok ? "✓" : "○"}</span>
      <span>{label}</span>
    </div>
  );

  return (
    <AuthCard subtitle="Pagamento confirmado">
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Alert kind="success">
          Sua assinatura está ativa e sua conta foi criada com o e-mail{" "}
          <strong>{user?.email}</strong>. Escolha uma senha para entrar.
        </Alert>

        <input
          value={password}
          onChange={e => setPassword(e.target.value)}
          type="password"
          placeholder="Sua senha"
          autoComplete="new-password"
          autoFocus
          required
          minLength={MIN_PASSWORD}
          maxLength={MAX_PASSWORD}
          style={inputStyle}
        />
        <input
          value={password2}
          onChange={e => setPassword2(e.target.value)}
          type="password"
          placeholder="Repita a senha"
          autoComplete="new-password"
          required
          minLength={MIN_PASSWORD}
          maxLength={MAX_PASSWORD}
          style={inputStyle}
        />

        {password.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            <CheckLine ok={checks.length} label={`Ao menos ${MIN_PASSWORD} caracteres`} />
            <CheckLine ok={checks.lower} label="Uma letra minúscula" />
            <CheckLine ok={checks.upper} label="Uma letra maiúscula" />
            <CheckLine ok={checks.number} label="Um número" />
            <CheckLine ok={password.length > 0 && password === password2} label="As senhas coincidem" />
          </div>
        )}

        {error && <Alert kind="error">{error}</Alert>}

        <button
          type="submit"
          disabled={saving}
          style={{ width: "100%", padding: 11, borderRadius: 10, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, fontWeight: 500, cursor: saving ? "default" : "pointer", opacity: saving ? 0.7 : 1 }}
        >
          {saving ? "Salvando…" : "Criar senha e entrar"}
        </button>

        <button
          type="button"
          onClick={() => onLogin(user)}
          style={{ background: "transparent", border: "none", cursor: "pointer", fontSize: 12, color: "var(--color-text-secondary)" }}
        >
          Fazer isso depois — enviamos um link por e-mail
        </button>
      </form>
    </AuthCard>
  );
}
