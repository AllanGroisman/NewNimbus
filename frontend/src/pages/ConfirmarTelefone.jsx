import { useState } from "react";
import { PRIMARY } from "../data/constants";
import AuthCard, { Alert } from "../components/ui/AuthCard";
import { accountSetPhone, errText} from "../data/api";
import { isValidPhone, maskPhoneInput, toStoredPhone } from "../data/phone";

// Telefone é obrigatório desde o cadastro. Quem entrou antes da regra — conta
// antiga, conta criada pelo Google (o Google não devolve telefone), conta
// provisionada por um pagamento sem o número — passa por aqui na entrada.
//
// Diferente do CPF (ConfirmarCpf.jsx), esta tela DEIXA PULAR: sem `onSkip` o
// botão "Agora não" não aparece, e é assim que a mesma tela serve nos pontos
// onde o número é inegociável. O pulo vale só pela sessão do navegador (ver
// App.jsx) — na entrada seguinte a tela volta.
export default function ConfirmarTelefone({ user, onDone, onSkip, onLogout }) {
  const [phone, setPhone] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setError(null);
    if (!isValidPhone(phone)) return setError("Informe um celular válido com DDD");

    setLoading(true);
    try {
      const r = await accountSetPhone(toStoredPhone(phone));
      onDone(r.user);
    } catch (err) {
      setError(errText(err, "Não foi possível salvar o telefone"));
      setLoading(false);
    }
  }

  return (
    <AuthCard subtitle="Confirme seu telefone">
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ fontSize: 13, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
          Toda conta da Nimbus tem um celular cadastrado — é por ele que o
          suporte fala com você. Informe o seu para continuar.
        </div>
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
          Conta: <strong style={{ color: "var(--color-text-primary)" }}>{user?.email}</strong>
        </div>

        <label style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
          Celular (com DDD)
          <input
            value={phone}
            onChange={e => setPhone(maskPhoneInput(e.target.value))}
            inputMode="tel"
            placeholder="(11) 99999-9999"
            autoComplete="tel-national"
            autoFocus
            required
            maxLength={15}
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
        {onSkip && (
          <button
            type="button"
            onClick={() => onSkip()}
            style={{ width: "100%", padding: 10, borderRadius: 10, background: "transparent", border: "0.5px solid var(--color-border-secondary)", fontSize: 13, cursor: "pointer", color: "var(--color-text-secondary)" }}
          >
            Agora não
          </button>
        )}
        {onLogout && (
          <button
            type="button"
            onClick={() => onLogout()}
            style={{ background: "transparent", border: "none", cursor: "pointer", fontSize: 12, color: "var(--color-text-secondary)" }}
          >
            Sair
          </button>
        )}
      </form>
    </AuthCard>
  );
}
