import { useState } from "react";
import { PRIMARY } from "../data/constants";
import AuthCard, { Alert } from "../components/ui/AuthCard";
import { accountSetCpf, errText} from "../data/api";
import { isValidCpf, maskCpfInput, normalizeCpf } from "../data/cpf";

// Uma conta = um CPF. Quem assina pela landing informa o documento antes de
// pagar; as contas criadas antes dessa regra passam por aqui na primeira
// entrada. É uma tela só, e depois dela o painel abre normalmente.
export default function ConfirmarCpf({ user, onDone, onLogout }) {
  const [cpf, setCpf] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setError(null);
    const clean = normalizeCpf(cpf);
    if (!isValidCpf(clean)) return setError("Informe um CPF válido");

    setLoading(true);
    try {
      const r = await accountSetCpf(clean);
      onDone(r.user);
    } catch (err) {
      setError(errText(err, "Não foi possível salvar o CPF"));
      setLoading(false);
    }
  }

  return (
    <AuthCard subtitle="Confirme seu CPF">
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ fontSize: 13, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
          Cada conta da Nimbus tem um CPF. Informe o seu para continuar usando o
          sistema — é rápido e só precisa ser feito uma vez.
        </div>
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
          Conta: <strong style={{ color: "var(--color-text-primary)" }}>{user?.email}</strong>
        </div>

        <label style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
          CPF
          <input
            value={cpf}
            onChange={e => setCpf(maskCpfInput(e.target.value))}
            inputMode="numeric"
            placeholder="000.000.000-00"
            autoComplete="off"
            autoFocus
            required
            maxLength={14}
            style={{
              padding: "9px 12px", borderRadius: 8, marginTop: 6,
              border: "0.5px solid var(--color-border-tertiary)",
              background: "var(--color-background-secondary)",
              fontSize: 13, fontFamily: "inherit", color: "var(--color-text-primary)",
              width: "100%",
            }}
          />
        </label>

        {error && <Alert kind="error">{error}</Alert>}

        <button
          type="submit"
          disabled={loading}
          style={{ width: "100%", padding: 11, borderRadius: 10, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, fontWeight: 500, cursor: loading ? "default" : "pointer", opacity: loading ? 0.7 : 1 }}
        >
          {loading ? "Salvando…" : "Salvar e continuar"}
        </button>
        <button
          type="button"
          onClick={() => onLogout?.()}
          style={{ background: "transparent", border: "none", cursor: "pointer", fontSize: 12, color: "var(--color-text-secondary)" }}
        >
          Sair
        </button>
      </form>
    </AuthCard>
  );
}
