import { useState } from "react";
import { PRIMARY } from "../data/constants";

export default function Login({ onLogin }) {
  const [isRegister, setIsRegister] = useState(false);

  return (
    <div style={{ minHeight: 500, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 16, padding: 32, width: "100%", maxWidth: 360 }}>
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <div style={{ fontSize: 28, fontWeight: 500, color: "#0F6E56" }}>Nimbus</div>
          <div style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>Ofertas automáticas para WhatsApp</div>
        </div>
        <div style={{ display: "flex", marginBottom: 20, background: "var(--color-background-secondary)", borderRadius: 10, padding: 3 }}>
          {["Entrar", "Cadastrar"].map((t, i) => (
            <button key={t} onClick={() => setIsRegister(i === 1)} style={{ flex: 1, padding: "7px", borderRadius: 8, border: "none", background: isRegister === (i === 1) ? "var(--color-background-primary)" : "transparent", fontSize: 13, cursor: "pointer", fontWeight: isRegister === (i === 1) ? 500 : 400 }}>{t}</button>
          ))}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 16 }}>
          {isRegister && <input placeholder="Nome completo" style={{ padding: "9px 12px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13 }} />}
          <input placeholder="Email" style={{ padding: "9px 12px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13 }} />
          <input type="password" placeholder="Senha" style={{ padding: "9px 12px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13 }} />
        </div>
        <button onClick={onLogin} style={{ width: "100%", padding: 10, borderRadius: 10, background: PRIMARY, color: "#fff", border: "none", fontSize: 14, cursor: "pointer", fontWeight: 500 }}>
          {isRegister ? "Criar conta" : "Entrar"}
        </button>
        {!isRegister && <div style={{ textAlign: "center", marginTop: 12, fontSize: 12 }}><span style={{ cursor: "pointer", color: PRIMARY }}>Esqueci minha senha</span></div>}
      </div>
    </div>
  );
}
