import { useState, useEffect } from "react";
import { PRIMARY } from "../data/constants";
import AuthCard, { Alert } from "../components/ui/AuthCard";
import { publicPlans, publicCheckout, errText} from "../data/api";
import { isValidCpf, maskCpfInput, normalizeCpf } from "../data/cpf";

// Ponte entre a landing page e o Stripe.
//
// A landing manda para /assinar?plano=pro (ou ?plano=basic&teste=1). Aqui a
// pessoa informa e-mail e CPF e segue pro pagamento — não é cadastro: a conta
// nasce depois, do pagamento aprovado (backend/billing/provision.js).
//
// Os dois campos são pedidos ANTES do Stripe porque é a única forma de avisar
// quem já assina; o Checkout só coletaria o e-mail depois de cobrar. O CPF é o
// que garante uma conta por pessoa — sem ele, bastaria trocar de e-mail pra
// repetir o teste de R$ 1,00. Se a landing já souber o e-mail e mandar em
// ?email=, esta tela só pré-preenche o campo; o CPF sempre é digitado aqui.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PLAN_IDS = ["basic", "pro", "business"];
// Respostas em que insistir no pagamento não resolve — a saída é entrar na
// conta (e, quando existe, subir de plano por lá).
const BLOCK_CODES = ["blocked", "upgrade_requires_login", "cpf_taken", "cpf_mismatch"];

const brl = (v) => (v == null ? null : `R$ ${v.toFixed(2).replace(".", ",")}`);

export default function Assinar({ onGoToLogin }) {
  const qs = new URLSearchParams(window.location.search);
  const planId = PLAN_IDS.includes(qs.get("plano")) ? qs.get("plano") : "basic";
  const wantsTrial = qs.get("teste") === "1" && planId === "basic";
  const cancelado = qs.get("cancelado") === "1";
  const emailFromUrl = (qs.get("email") || "").trim().toLowerCase();

  const [plans, setPlans] = useState(null);
  const [email, setEmail] = useState(emailFromUrl);
  const [cpf, setCpf] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  // Bloqueio/upgrade: a saída é entrar na conta, não pagar de novo.
  const [blocked, setBlocked] = useState(null);

  useEffect(() => {
    publicPlans().then(r => setPlans(r.plans || [])).catch(() => setPlans([]));
  }, []);

  const plan = plans?.find(p => p.id === planId);
  const planLabel = plan?.label || { basic: "Básico", pro: "Pro", business: "Business" }[planId];

  async function start(rawEmail, rawCpf) {
    const cleanEmail = String(rawEmail || "").trim().toLowerCase();
    const cleanCpf = normalizeCpf(rawCpf);
    setError(null);
    setBlocked(null);
    if (!EMAIL_RE.test(cleanEmail)) return setError("Informe um e-mail válido");
    if (!isValidCpf(cleanCpf)) return setError("Informe um CPF válido");

    setLoading(true);
    try {
      const { url } = await publicCheckout({
        planId, email: cleanEmail, cpf: cleanCpf, trial: wantsTrial,
      });
      window.location.assign(url);
    } catch (err) {
      // Bloqueio: a saída não é pagar de novo. O corpo do 409 traz os planos
      // maiores que o atual e para onde mandar a pessoa (backend/server.js →
      // buildBlockedPayload) — é o que a tela renderiza abaixo.
      if (BLOCK_CODES.includes(err.code)) {
        setBlocked({
          code: err.code,
          message: errText(err, "Não foi possível concluir. Tente novamente."),
          upgrades: err.body?.upgrades || [],
          targetPlan: err.body?.targetPlan || null,
        });
      } else {
        setError(errText(err, "Não foi possível abrir o pagamento"));
      }
      setLoading(false);
    }
  }

  const inputStyle = {
    padding: "9px 12px", borderRadius: 8,
    border: "0.5px solid var(--color-border-tertiary)",
    background: "var(--color-background-secondary)",
    fontSize: 13, fontFamily: "inherit", color: "var(--color-text-primary)",
    width: "100%",
  };

  return (
    <AuthCard subtitle="Ofertas automáticas para WhatsApp">
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 10, padding: "14px 16px" }}>
          <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
            {wantsTrial ? "Você escolheu" : "Plano escolhido"}
          </div>
          <div style={{ fontSize: 18, fontWeight: 500, color: "var(--color-text-primary)" }}>
            {wantsTrial ? `${planLabel} — 15 dias por R$ 1,00` : `Plano ${planLabel}`}
          </div>
          {plan?.priceBRL != null && (
            <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 2 }}>
              {wantsTrial
                ? `Depois dos 15 dias, ${brl(plan.priceBRL)} por mês. Cancele quando quiser.`
                : `${brl(plan.priceBRL)} por mês. Cancele quando quiser.`}
            </div>
          )}
        </div>

        {cancelado && (
          <Alert kind="info">Pagamento não concluído. Você pode tentar de novo quando quiser.</Alert>
        )}

        {blocked ? (
          <>
            <Alert kind="info">{blocked.message}</Alert>

            {/* Tentou um plano maior do que o que já assina: caminho direto pra
                troca, que cobra só a diferença em vez de abrir outra assinatura. */}
            {blocked.targetPlan && (
              <>
                <button
                  type="button"
                  onClick={() => window.location.assign(blocked.targetPlan.url)}
                  style={{ width: "100%", padding: 11, borderRadius: 10, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, fontWeight: 500, cursor: "pointer" }}
                >
                  Quero assinar o {blocked.targetPlan.label} mesmo assim
                </button>
                <div style={{ fontSize: 11, color: "var(--color-text-secondary)", textAlign: "center", marginTop: -4 }}>
                  Você entra na sua conta e confirma a troca — paga só a diferença.
                </div>
              </>
            )}

            {/* Demais planos maiores que o atual. Vazio = já está no maior. */}
            {(blocked.upgrades || [])
              .filter(p => p.id !== blocked.targetPlan?.id)
              .map(p => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => window.location.assign(p.url)}
                  style={{ width: "100%", padding: 11, borderRadius: 10, background: "transparent", color: "var(--color-text-primary)", border: `1px solid ${PRIMARY}`, fontSize: 13, fontWeight: 500, cursor: "pointer", display: "flex", justifyContent: "space-between" }}
                >
                  <span>{p.label}</span>
                  {p.priceBRL != null && <span style={{ fontWeight: 400 }}>{brl(p.priceBRL)}/mês</span>}
                </button>
              ))}

            <button
              type="button"
              onClick={onGoToLogin}
              style={{
                width: "100%", padding: 11, borderRadius: 10, fontSize: 13, fontWeight: 500, cursor: "pointer",
                // Com opção de upgrade na tela, entrar é a saída secundária.
                ...(blocked.targetPlan || (blocked.upgrades || []).length
                  ? { background: "transparent", color: "var(--color-text-secondary)", border: "0.5px solid var(--color-border-tertiary)" }
                  : { background: PRIMARY, color: "#fff", border: "none" }),
              }}
            >
              Entrar na minha conta
            </button>
            <button
              type="button"
              onClick={() => { setBlocked(null); setEmail(""); setCpf(""); }}
              style={{ background: "transparent", border: "none", cursor: "pointer", fontSize: 12, color: "var(--color-text-secondary)" }}
            >
              Tentar com outros dados
            </button>
          </>
        ) : (
          <form onSubmit={(e) => { e.preventDefault(); if (!loading) start(email, cpf); }} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <label style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
              Seu e-mail
              <input
                value={email}
                onChange={e => setEmail(e.target.value)}
                type="email"
                placeholder="voce@email.com"
                autoComplete="email"
                autoFocus
                required
                maxLength={254}
                style={{ ...inputStyle, marginTop: 6 }}
              />
            </label>
            <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: -2 }}>
              É com este e-mail que sua conta será criada depois do pagamento.
            </div>

            <label style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
              Seu CPF
              <input
                value={cpf}
                onChange={e => setCpf(maskCpfInput(e.target.value))}
                inputMode="numeric"
                placeholder="000.000.000-00"
                autoComplete="off"
                required
                maxLength={14}
                style={{ ...inputStyle, marginTop: 6 }}
              />
            </label>
            <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: -2 }}>
              Cada CPF pode ter uma conta. Serve para identificar sua assinatura.
            </div>

            {error && <Alert kind="error">{error}</Alert>}

            <button
              type="submit"
              disabled={loading}
              style={{ width: "100%", padding: 11, borderRadius: 10, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, fontWeight: 500, cursor: loading ? "default" : "pointer", opacity: loading ? 0.7 : 1 }}
            >
              {loading ? "Abrindo pagamento…" : "Ir para o pagamento"}
            </button>
            <div style={{ textAlign: "center", fontSize: 11, color: "var(--color-text-secondary)" }}>
              Pagamento processado pelo Stripe. Nós não guardamos seu cartão.
            </div>
            <button
              type="button"
              onClick={onGoToLogin}
              style={{ background: "transparent", border: "none", cursor: "pointer", fontSize: 12, color: "var(--color-text-secondary)" }}
            >
              Já tenho conta — entrar
            </button>
          </form>
        )}
      </div>
    </AuthCard>
  );
}
