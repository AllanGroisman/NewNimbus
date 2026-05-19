import { useState, useEffect } from "react";
import { PRIMARY, PRIMARY_DARK, PRIMARY_LIGHT } from "../data/constants";
import Modal from "../components/ui/Modal";
import { billingMe, billingCheckout, billingPortal } from "../data/api";

const PLAN_FEATURES = {
  basic:    ["1 número WhatsApp", "3 grupos", "2 categorias", "Scraping manual", "Suporte por email"],
  pro:      ["3 números WhatsApp", "15 grupos", "Todas as categorias", "Scraping automático", "Dashboard por grupo", "Filtros avançados", "Suporte via WhatsApp"],
  business: ["Ilimitado", "Grupos ilimitados", "API de integração", "Painel multi-usuário", "Relatórios avançados", "SLA garantido", "Gerente dedicado"],
};

const PLAN_PRICE_BRL = { basic: 49, pro: 99, business: 199 };

function fmtDate(iso) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleDateString("pt-BR"); }
  catch { return String(iso); }
}

function statusLabel(status, trialDays) {
  if (status === "trialing") return `Trial (${trialDays ?? 0}d restantes)`;
  if (status === "active") return "Ativa";
  if (status === "past_due") return "Pagamento atrasado";
  if (status === "canceled") return "Cancelada";
  if (status === "incomplete") return "Incompleta";
  if (status === "unpaid") return "Não paga";
  return "Sem assinatura";
}

export default function PageSubscription() {
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null); // planId em checkout, ou "portal"
  const [error, setError] = useState("");
  const [showCancel, setShowCancel] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await billingMe();
        if (!cancelled) { setMe(data); setError(""); }
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function startCheckout(planId) {
    setBusy(planId);
    setError("");
    try {
      const { url } = await billingCheckout(planId);
      window.location.assign(url);
    } catch (err) {
      setError(err.message);
      setBusy(null);
    }
  }

  async function openPortal() {
    setBusy("portal");
    setError("");
    try {
      const { url } = await billingPortal();
      window.location.assign(url);
    } catch (err) {
      setError(err.message);
      setBusy(null);
    }
  }

  if (loading || !me) {
    return <div style={{ padding: 20, color: "var(--color-text-secondary)" }}>Carregando assinatura…</div>;
  }

  const currentPlan = me.effectivePlan || "free";
  const isAdmin = !!me.isAdmin;

  const plans = ["basic", "pro", "business"].map(id => ({
    id,
    name: id === "basic" ? "Básico" : id === "pro" ? "Pro" : "Business",
    price: `R$ ${PLAN_PRICE_BRL[id]}`,
    features: PLAN_FEATURES[id],
    current: currentPlan === id,
  }));

  return (
    <div>
      <h2 style={{ fontSize: 18, fontWeight: 500, marginBottom: 16 }}>Assinatura</h2>

      {error && (
        <div style={{ background: "#FCEBEB", border: "0.5px solid #F7C1C1", color: "#A32D2D", padding: 10, borderRadius: 8, fontSize: 13, marginBottom: 14 }}>
          {error}
        </div>
      )}

      {!me.stripeEnabled && (
        <div style={{ background: "#FFF7E0", border: "0.5px solid #F0D58A", color: "#7A5800", padding: 10, borderRadius: 8, fontSize: 13, marginBottom: 14 }}>
          Stripe não está configurado no servidor. Pagamentos desabilitados.
        </div>
      )}

      {isAdmin && (
        <div style={{ background: PRIMARY_LIGHT, border: `0.5px solid ${PRIMARY}`, color: PRIMARY_DARK, padding: 10, borderRadius: 8, fontSize: 13, marginBottom: 14 }}>
          Você é admin — acesso Business permanente (bypass de cobrança).
        </div>
      )}

      <div style={{ background: PRIMARY_LIGHT, border: `0.5px solid ${PRIMARY}`, borderRadius: 12, padding: 16, marginBottom: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 10 }}>
          <div>
            <div style={{ fontSize: 12, color: PRIMARY_DARK, fontWeight: 500, marginBottom: 4 }}>PLANO ATUAL</div>
            <div style={{ fontSize: 20, fontWeight: 500, color: PRIMARY_DARK }}>
              Nimbus {currentPlan.charAt(0).toUpperCase() + currentPlan.slice(1)}
            </div>
            <div style={{ fontSize: 13, color: PRIMARY_DARK, marginTop: 4 }}>
              {statusLabel(me.status, me.daysLeftInTrial)}
              {me.currentPeriodEnd && ` · ${me.cancelAtPeriodEnd ? "Acesso até" : "Renova em"} ${fmtDate(me.currentPeriodEnd)}`}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {me.hasStripeCustomer && (
              <button onClick={openPortal} disabled={!!busy} style={{ padding: "7px 14px", borderRadius: 8, background: "#fff", color: PRIMARY_DARK, border: `0.5px solid ${PRIMARY}`, fontSize: 13, cursor: busy ? "wait" : "pointer", fontWeight: 500, opacity: busy ? 0.6 : 1 }}>
                {busy === "portal" ? "Abrindo…" : "Gerenciar pagamento"}
              </button>
            )}
            {(me.status === "active" || me.status === "trialing") && me.hasStripeCustomer && (
              <button onClick={() => setShowCancel(true)} disabled={!!busy} style={{ padding: "7px 14px", borderRadius: 8, border: "0.5px solid #F7C1C1", background: "#FCEBEB", color: "#A32D2D", fontSize: 13, cursor: "pointer" }}>
                Cancelar assinatura
              </button>
            )}
          </div>
        </div>
      </div>

      <h3 style={{ fontSize: 14, fontWeight: 500, marginBottom: 12 }}>Planos disponíveis</h3>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12, marginBottom: 24 }}>
        {plans.map(p => (
          <div key={p.id} style={{ background: "var(--color-background-primary)", border: p.current ? `2px solid ${PRIMARY}` : "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16, position: "relative" }}>
            {p.current && <div style={{ position: "absolute", top: -10, left: "50%", transform: "translateX(-50%)", background: PRIMARY, color: "#fff", fontSize: 11, padding: "2px 10px", borderRadius: 6, fontWeight: 500, whiteSpace: "nowrap" }}>Plano atual</div>}
            <div style={{ fontWeight: 500, marginBottom: 4 }}>{p.name}</div>
            <div style={{ fontSize: 22, fontWeight: 500, color: PRIMARY_DARK, marginBottom: 12 }}>{p.price}<span style={{ fontSize: 13, fontWeight: 400, color: "var(--color-text-secondary)" }}>/mês</span></div>
            <ul style={{ paddingLeft: 0, margin: "0 0 14px", listStyle: "none", display: "flex", flexDirection: "column", gap: 6 }}>
              {p.features.map(f => <li key={f} style={{ fontSize: 12, color: "var(--color-text-secondary)", display: "flex", gap: 6 }}><span style={{ color: PRIMARY, fontWeight: 700 }}>{"✓"}</span>{f}</li>)}
            </ul>
            <button
              onClick={() => !p.current && startCheckout(p.id)}
              disabled={p.current || !!busy || !me.stripeEnabled}
              style={{
                width: "100%", padding: "7px", borderRadius: 8,
                background: p.current ? PRIMARY_LIGHT : (busy === p.id ? "var(--color-background-secondary)" : "transparent"),
                color: p.current ? PRIMARY_DARK : "var(--color-text-primary)",
                border: p.current ? "none" : "0.5px solid var(--color-border-secondary)",
                fontSize: 13, fontWeight: 500,
                cursor: p.current || !!busy || !me.stripeEnabled ? "not-allowed" : "pointer",
                opacity: !me.stripeEnabled && !p.current ? 0.5 : 1,
              }}
            >
              {p.current ? "Plano ativo" : busy === p.id ? "Abrindo Stripe…" : "Assinar"}
            </button>
          </div>
        ))}
      </div>

      <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: 16, marginBottom: 24 }}>
        <div style={{ fontSize: 13, color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
          Pagamentos processados pela <strong style={{ color: "var(--color-text-primary)" }}>Stripe</strong>. Cartão, faturas e cancelamento são gerenciados pelo portal oficial — clique em <em>"Gerenciar pagamento"</em> acima para abrir.
        </div>
      </div>

      {showCancel && (
        <Modal title="Cancelar assinatura?" onClose={() => setShowCancel(false)} danger>
          <p style={{ fontSize: 13, marginBottom: 12, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
            O cancelamento é feito pelo portal da Stripe. Você continuará com acesso até <strong style={{ color: "var(--color-text-primary)" }}>{fmtDate(me.currentPeriodEnd)}</strong>. Após essa data, os envios automáticos serão interrompidos e seus dados serão mantidos por 30 dias.
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={() => setShowCancel(false)} style={{ padding: "8px 16px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", fontSize: 13, cursor: "pointer" }}>Manter</button>
            <button onClick={() => { setShowCancel(false); openPortal(); }} style={{ padding: "8px 16px", borderRadius: 8, background: "#E24B4A", color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500 }}>Abrir portal Stripe</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
