import { useEffect, useRef, useState } from "react";
import { PRIMARY } from "../data/constants";
import AuthCard, { Alert } from "../components/ui/AuthCard";
import { accountConfirmEmailChange, errText} from "../data/api";

// Destino do link "confirmar novo email". Roda solta, antes de qualquer gate do
// painel: a pessoa pode abrir o email em outro navegador, ou estar logada aqui
// com o email antigo. Confirmar derruba as sessões abertas no servidor — por
// isso a tela termina sempre no login, agora com o endereço novo.
export default function ConfirmarNovoEmail({ token, onDone }) {
  const [state, setState] = useState({ status: "loading" });
  // StrictMode monta duas vezes em dev, e o token é de uso único: a segunda
  // chamada voltaria "link já usado" por cima do sucesso da primeira.
  const enviado = useRef(false);

  useEffect(() => {
    if (enviado.current) return;
    enviado.current = true;
    accountConfirmEmailChange(token)
      .then(r => setState({ status: "ok", email: r.user?.email }))
      .catch(err => setState({ status: "erro", text: errText(err, "Não foi possível confirmar o email") }));
  }, [token]);

  return (
    <AuthCard subtitle="Troca de email">
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {state.status === "loading" && (
          <div style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>Confirmando…</div>
        )}

        {state.status === "ok" && (
          <>
            <Alert kind="success">Pronto! Sua conta agora usa <strong>{state.email}</strong>.</Alert>
            <div style={{ fontSize: 12, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
              Por segurança, encerramos as sessões abertas. Entre de novo usando o
              email novo — a senha continua a mesma.
            </div>
          </>
        )}

        {state.status === "erro" && (
          <>
            <Alert kind="error">{state.text}</Alert>
            <div style={{ fontSize: 12, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
              Seu email não foi alterado. Entre na conta e peça a troca de novo em
              Configurações › Conta.
            </div>
          </>
        )}

        {state.status !== "loading" && (
          <button
            onClick={onDone}
            style={{ width: "100%", padding: 11, borderRadius: 10, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, fontWeight: 500, cursor: "pointer" }}
          >
            Ir para o login
          </button>
        )}
      </div>
    </AuthCard>
  );
}
