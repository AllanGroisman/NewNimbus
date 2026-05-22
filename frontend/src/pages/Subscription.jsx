import { useState, useEffect } from "react";
import { PRIMARY, PRIMARY_DARK, PRIMARY_LIGHT } from "../data/constants";
import Modal from "../components/ui/Modal";
import { billingMe, billingCheckout, billingPortal } from "../data/api";

const PLAN_META = {
  basic: {
    name: "Básico",
    tagline: "Pra começar com 1 número",
    price: 69.90,
    features: [
      "1 número de WhatsApp",
      "1 campanha",
      "3 grupos por campanha",
      "2 categorias",
      "Scraping manual",
    ],
  },
  pro: {
    name: "Pro",
    tagline: "Para quem leva a sério",
    price: 99.90,
    recommended: true,
    features: [
      "3 números de WhatsApp",
      "5 campanhas",
      "15 grupos por campanha",
      "Todas as categorias",
      "Scraping automático",
      "Dashboard por grupo",
      "Filtros avançados",
    ],
  },
  business: {
    name: "Business",
    tagline: "Para operações grandes",
    price: 149.90,
    features: [
      "5 números de WhatsApp",
      "Campanhas ilimitadas",
      "Grupos ilimitados",
      "Scraping automático",
      "Relatórios avançados",
      "Suporte prioritário",
    ],
  },
};

const PLAN_ORDER = ["basic", "pro", "business"];

function fmtPrice(brl) {
  return `R$ ${brl.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDate(iso) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleDateString("pt-BR"); }
  catch { return String(iso); }
}

function statusBadge(status, trialDays, cancelAtPeriodEnd) {
  if (cancelAtPeriodEnd) return { label: "Cancelamento agendado", color: "#854F0B", bg: "#FFF7E0", border: "#F0D58A" };
  if (status === "trialing") return { label: `Trial (${trialDays ?? 0}d restantes)`, color: "#185FA5", bg: "#E6F1FB", border: "#B6D5EF" };
  if (status === "active") return { label: "Ativa", color: "#3B6D11", bg: "#EAF3DE", border: "#C5DBA7" };
  if (status === "past_due") return { label: "Pagamento atrasado", color: "#A32D2D", bg: "#FCEBEB", border: "#F7C1C1" };
  if (status === "canceled") return { label: "Cancelada", color: "#A32D2D", bg: "#FCEBEB", border: "#F7C1C1" };
  if (status === "incomplete") return { label: "Pagamento incompleto", color: "#854F0B", bg: "#FFF7E0", border: "#F0D58A" };
  if (status === "unpaid") return { label: "Não paga", color: "#A32D2D", bg: "#FCEBEB", border: "#F7C1C1" };
  return { label: "Sem assinatura", color: "var(--color-text-secondary)", bg: "var(--color-background-secondary)", border: "var(--color-border-tertiary)" };
}

export default function PageSubscription() {
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null); // planId em checkout, "portal", ou "cancel"
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

  async function openPortal(action) {
    setBusy(action || "portal");
    setError("");
    try {
      const { url } = await billingPortal();
      window.location.assign(url);
    } catch (err) {
      setError(err.message);
      setBusy(null);
    }
  }

  if (loading) {
    return <div style={{ padding: 20, color: "var(--color-text-secondary)" }}>Carregando assinatura…</div>;
  }
  if (!me) {
    return (
      <div style={{ padding: 20 }}>
        <h2 style={{ fontSize: 18, fontWeight: 500, marginBottom: 16 }}>Assinatura</h2>
        <div style={{ background: "#FCEBEB", border: "0.5px solid #F7C1C1", color: "#A32D2D", padding: 10, borderRadius: 8, fontSize: 13 }}>
          {error || "Falha ao carregar status de assinatura."}
        </div>
      </div>
    );
  }

  const currentPlan = me.effectivePlan || "free";
  const isAdmin = !!me.isAdmin;
  const hasActiveSub = (me.status === "active" || me.status === "trialing") && me.hasStripeCustomer;
  const badge = statusBadge(me.status, me.daysLeftInTrial, me.cancelAtPeriodEnd);

  return (
    <div style={{ maxWidth: 920 }}>
      <h2 style={{ fontSize: 18, fontWeight: 500, marginBottom: 4 }}>Assinatura</h2>
      <div style={{ fontSize: 13, color: "var(--color-text-secondary)", marginBottom: 20 }}>
        Gerencie seu plano, pagamento e cancelamento.
      </div>

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

      {me.cancelAtPeriodEnd && (
        <div style={{ background: "#FFF7E0", border: "0.5px solid #F0D58A", color: "#7A5800", padding: "10px 14px", borderRadius: 8, fontSize: 13, marginBottom: 14 }}>
          Seu cancelamento está agendado — acesso até <strong>{fmtDate(me.currentPeriodEnd)}</strong>. Pode reverter no portal a qualquer momento antes dessa data.
        </div>
      )}

      {/* ─── HERO: plano atual ─── */}
      <div style={{ background: "var(--color-background-primary)", border: `0.5px solid var(--color-border-tertiary)`, borderRadius: 14, padding: 20, marginBottom: 28, position: "relative", overflow: "hidden" }}>
        <div style={{ position: "absolute", top: 0, right: 0, bottom: 0, width: 4, background: PRIMARY }} />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 16 }}>
          <div style={{ minWidth: 220 }}>
            <div style={{ fontSize: 11, color: "var(--color-text-secondary)", fontWeight: 500, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>Plano atual</div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 8, flexWrap: "wrap" }}>
              <div style={{ fontSize: 26, fontWeight: 500 }}>
                Nimbus {currentPlan === "free" ? "Free" : (PLAN_META[currentPlan]?.name || currentPlan)}
              </div>
              <span style={{ background: badge.bg, color: badge.color, border: `0.5px solid ${badge.border}`, fontSize: 11, padding: "3px 10px", borderRadius: 6, fontWeight: 500 }}>
                {badge.label}
              </span>
            </div>
            <div style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>
              {me.status === "trialing" && me.currentPeriodEnd && (
                <>Trial acaba em <strong style={{ color: "var(--color-text-primary)" }}>{fmtDate(me.currentPeriodEnd)}</strong>. Adicione um cartão antes pra continuar sem interrupção.</>
              )}
              {me.status === "active" && me.currentPeriodEnd && !me.cancelAtPeriodEnd && (
                <>Renovação automática em <strong style={{ color: "var(--color-text-primary)" }}>{fmtDate(me.currentPeriodEnd)}</strong>.</>
              )}
              {me.status === "active" && me.cancelAtPeriodEnd && (
                <>Acesso até <strong style={{ color: "var(--color-text-primary)" }}>{fmtDate(me.currentPeriodEnd)}</strong> — depois disso a conta vira plano Free.</>
              )}
              {me.status === "past_due" && (
                <>Falha no pagamento — atualize o cartão pra evitar suspensão dos envios.</>
              )}
              {me.status === "canceled" && (
                <>Assinatura encerrada. Escolha um plano abaixo pra reativar.</>
              )}
              {currentPlan === "free" && me.status !== "trialing" && me.status !== "canceled" && (
                <>Sem plano ativo. Escolha um abaixo pra começar.</>
              )}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {me.hasStripeCustomer && (
              <button onClick={() => openPortal("portal")} disabled={!!busy} style={{ padding: "8px 16px", borderRadius: 8, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: busy ? "wait" : "pointer", fontWeight: 500, opacity: busy ? 0.6 : 1 }}>
                {busy === "portal" ? "Abrindo…" : "Gerenciar pagamento"}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ─── PLANOS ─── */}
      <h3 style={{ fontSize: 14, fontWeight: 500, marginBottom: 4 }}>
        {hasActiveSub ? "Mudar de plano" : "Escolha seu plano"}
      </h3>
      <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 14 }}>
        Todos os planos são cobrados mensalmente. Cancele quando quiser.
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14, marginBottom: 28 }}>
        {PLAN_ORDER.map(id => {
          const p = PLAN_META[id];
          const current = currentPlan === id;
          const recommended = p.recommended && !current;
          const currentIdx = PLAN_ORDER.indexOf(currentPlan);
          const isUpgrade = currentIdx >= 0 && PLAN_ORDER.indexOf(id) > currentIdx;
          const isDowngrade = currentIdx >= 0 && PLAN_ORDER.indexOf(id) < currentIdx;
          const ctaLabel = current ? "Plano atual"
            : busy === id ? "Abrindo Stripe…"
            : "Assinar";
          const ctaHint = current ? null : isUpgrade ? "Upgrade" : isDowngrade ? "Mudar para este" : null;
          return (
            <div
              key={id}
              style={{
                background: "var(--color-background-primary)",
                border: current
                  ? `2px solid ${PRIMARY}`
                  : recommended
                    ? `2px solid ${PRIMARY}`
                    : "0.5px solid var(--color-border-tertiary)",
                borderRadius: 12, padding: 18, position: "relative",
                display: "flex", flexDirection: "column",
              }}
            >
              {current && (
                <div style={{ position: "absolute", top: -10, left: "50%", transform: "translateX(-50%)", background: PRIMARY, color: "#fff", fontSize: 10, padding: "3px 10px", borderRadius: 6, fontWeight: 600, whiteSpace: "nowrap", letterSpacing: 0.3 }}>
                  SEU PLANO
                </div>
              )}
              {recommended && (
                <div style={{ position: "absolute", top: -10, left: "50%", transform: "translateX(-50%)", background: PRIMARY, color: "#fff", fontSize: 10, padding: "3px 10px", borderRadius: 6, fontWeight: 600, whiteSpace: "nowrap", letterSpacing: 0.3 }}>
                  MAIS POPULAR
                </div>
              )}
              <div style={{ fontWeight: 500, fontSize: 15, marginBottom: 2 }}>{p.name}</div>
              <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 12 }}>{p.tagline}</div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 4, marginBottom: 6 }}>
                <span style={{ fontSize: 24, fontWeight: 500, color: "var(--color-text-primary)" }}>{fmtPrice(p.price)}</span>
                <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>/mês</span>
              </div>
              {ctaHint && (
                <div style={{ fontSize: 10, color: PRIMARY_DARK, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 10 }}>
                  {ctaHint}
                </div>
              )}
              {!ctaHint && <div style={{ marginBottom: 10 }} />}
              <ul style={{ paddingLeft: 0, margin: "0 0 16px", listStyle: "none", display: "flex", flexDirection: "column", gap: 7, flex: 1 }}>
                {p.features.map(f => (
                  <li key={f} style={{ fontSize: 12, color: "var(--color-text-primary)", display: "flex", gap: 8, alignItems: "flex-start" }}>
                    <span style={{ color: "#22C55E", fontWeight: 700, flexShrink: 0, lineHeight: 1.4 }}>✓</span>
                    <span style={{ lineHeight: 1.4 }}>{f}</span>
                  </li>
                ))}
              </ul>
              <button
                onClick={() => !current && startCheckout(id)}
                disabled={current || !!busy || !me.stripeEnabled}
                style={{
                  width: "100%", padding: "9px", borderRadius: 8,
                  background: current
                    ? "var(--color-background-secondary)"
                    : (recommended ? PRIMARY : "transparent"),
                  color: current
                    ? "var(--color-text-secondary)"
                    : (recommended ? "#fff" : PRIMARY_DARK),
                  border: current
                    ? "0.5px solid var(--color-border-tertiary)"
                    : (recommended ? "none" : `0.5px solid ${PRIMARY}`),
                  fontSize: 13, fontWeight: 500,
                  cursor: current || !!busy || !me.stripeEnabled ? "not-allowed" : "pointer",
                  opacity: !me.stripeEnabled && !current ? 0.5 : 1,
                }}
              >
                {ctaLabel}
              </button>
            </div>
          );
        })}
      </div>

      {/* ─── GERENCIAR / CANCELAR ─── */}
      <h3 style={{ fontSize: 14, fontWeight: 500, marginBottom: 12 }}>Gerenciar assinatura</h3>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12, marginBottom: 28 }}>
        <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 10, padding: 14 }}>
          <div style={{ fontWeight: 500, fontSize: 13, marginBottom: 4 }}>Cartão e faturas</div>
          <div style={{ fontSize: 12, color: "var(--color-text-secondary)", lineHeight: 1.5, marginBottom: 12 }}>
            Atualize o cartão, baixe faturas e veja o histórico de cobranças pelo portal seguro da Stripe.
          </div>
          <button
            onClick={() => openPortal("portal")}
            disabled={!me.hasStripeCustomer || !!busy}
            style={{ padding: "7px 14px", borderRadius: 8, background: "transparent", color: "var(--color-text-primary)", border: "0.5px solid var(--color-border-secondary)", fontSize: 12, cursor: !me.hasStripeCustomer || !!busy ? "not-allowed" : "pointer", fontWeight: 500, opacity: !me.hasStripeCustomer ? 0.5 : 1 }}
          >
            {busy === "portal" ? "Abrindo…" : "Abrir portal"}
          </button>
          {!me.hasStripeCustomer && (
            <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 8, fontStyle: "italic" }}>
              Disponível após o primeiro pagamento.
            </div>
          )}
        </div>

        <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 10, padding: 14 }}>
          <div style={{ fontWeight: 500, fontSize: 13, marginBottom: 4, color: hasActiveSub ? "#A32D2D" : "var(--color-text-primary)" }}>Cancelar assinatura</div>
          <div style={{ fontSize: 12, color: "var(--color-text-secondary)", lineHeight: 1.5, marginBottom: 12 }}>
            {me.cancelAtPeriodEnd
              ? `Cancelamento já agendado — acesso até ${fmtDate(me.currentPeriodEnd)}. Pode reverter no portal.`
              : hasActiveSub
                ? "Você continua com acesso até o fim do período já pago. Os dados ficam guardados caso decida voltar."
                : "Você não tem uma assinatura ativa pra cancelar."
            }
          </div>
          <button
            onClick={() => setShowCancel(true)}
            disabled={!hasActiveSub || !!busy}
            style={{
              padding: "7px 14px", borderRadius: 8,
              background: hasActiveSub ? "#FCEBEB" : "var(--color-background-secondary)",
              color: hasActiveSub ? "#A32D2D" : "var(--color-text-secondary)",
              border: `0.5px solid ${hasActiveSub ? "#F7C1C1" : "var(--color-border-tertiary)"}`,
              fontSize: 12,
              cursor: !hasActiveSub || !!busy ? "not-allowed" : "pointer",
              fontWeight: 500,
              opacity: hasActiveSub ? 1 : 0.5,
            }}
          >
            {me.cancelAtPeriodEnd ? "Reverter cancelamento" : "Cancelar assinatura"}
          </button>
        </div>
      </div>

      {/* ─── FAQ ─── */}
      <h3 style={{ fontSize: 14, fontWeight: 500, marginBottom: 12 }}>Perguntas frequentes</h3>
      <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 10, padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
        <FAQ q="O que acontece quando eu cancelo?">
          Você continua com acesso completo até o fim do período já pago — depois disso a conta vira plano Free
          e os envios automáticos param. Seus dados (campanhas, grupos, histórico) ficam guardados por 30 dias
          caso queira voltar.
        </FAQ>
        <FAQ q="Posso trocar de plano?">
          Sim. Upgrades entram em vigor na hora (cobrança proporcional). Downgrades passam a valer na próxima
          renovação — você não perde o que já pagou.
        </FAQ>
        <FAQ q="Como atualizo meu cartão?">
          Pelo portal da Stripe — clique em <em>"Abrir portal"</em> acima. Lá você troca o cartão, baixa faturas
          e gerencia o cancelamento.
        </FAQ>
        <FAQ q="E se o pagamento falhar?">
          A Stripe tenta de novo automaticamente por alguns dias. Você recebe email avisando e a assinatura
          fica em <em>"Pagamento atrasado"</em>. Os envios continuam por uma janela curta — atualize o cartão
          pra evitar suspensão.
        </FAQ>
      </div>

      <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 18, textAlign: "center" }}>
        Pagamentos processados pela <strong style={{ color: "var(--color-text-primary)" }}>Stripe</strong> · Cartão, faturas e cancelamento gerenciados no portal oficial.
      </div>

      {/* ─── MODAL DE CANCELAMENTO ─── */}
      {showCancel && (
        <Modal title={me.cancelAtPeriodEnd ? "Reativar assinatura?" : "Cancelar assinatura?"} onClose={() => setShowCancel(false)} danger={!me.cancelAtPeriodEnd}>
          {me.cancelAtPeriodEnd ? (
            <p style={{ fontSize: 13, marginBottom: 16, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
              O cancelamento agendado vai ser desfeito no portal da Stripe. A renovação volta a acontecer
              normalmente em <strong style={{ color: "var(--color-text-primary)" }}>{fmtDate(me.currentPeriodEnd)}</strong>.
            </p>
          ) : (
            <>
              <p style={{ fontSize: 13, marginBottom: 12, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
                Você continua com acesso completo até <strong style={{ color: "var(--color-text-primary)" }}>{fmtDate(me.currentPeriodEnd)}</strong> — depois disso:
              </p>
              <ul style={{ paddingLeft: 18, margin: "0 0 14px", color: "var(--color-text-secondary)", fontSize: 13, lineHeight: 1.6 }}>
                <li>Os envios automáticos serão interrompidos</li>
                <li>A conta vira plano Free (sem acesso a recursos pagos)</li>
                <li>Suas campanhas, grupos e histórico ficam guardados por 30 dias</li>
                <li>Você pode reativar a qualquer momento</li>
              </ul>
              <div style={{ background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 8, padding: "8px 12px", marginBottom: 16, fontSize: 12, color: "var(--color-text-secondary)" }}>
                O cancelamento é finalizado no portal seguro da Stripe — você confirma lá.
              </div>
            </>
          )}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
            <button onClick={() => setShowCancel(false)} style={{ padding: "8px 16px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", color: "var(--color-text-primary)", fontSize: 13, cursor: "pointer" }}>
              {me.cancelAtPeriodEnd ? "Voltar" : "Manter assinatura"}
            </button>
            <button
              onClick={() => { setShowCancel(false); openPortal("cancel"); }}
              style={{
                padding: "8px 16px", borderRadius: 8,
                background: me.cancelAtPeriodEnd ? "#22C55E" : "#E24B4A",
                color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500,
              }}
            >
              {me.cancelAtPeriodEnd ? "Sim, reativar" : "Continuar no portal"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// Pergunta+resposta colapsável da FAQ. Native <details> mantém o markup simples
// e funciona com keyboard/screen reader sem JS extra.
function FAQ({ q, children }) {
  return (
    <details style={{ borderBottom: "0.5px solid var(--color-border-tertiary)", paddingBottom: 12 }}>
      <summary style={{ cursor: "pointer", fontWeight: 500, fontSize: 13, padding: "2px 0", color: "var(--color-text-primary)", listStyle: "none", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span>{q}</span>
        <span style={{ fontSize: 16, color: "var(--color-text-secondary)", fontWeight: 400 }}>+</span>
      </summary>
      <div style={{ fontSize: 12, color: "var(--color-text-secondary)", lineHeight: 1.6, marginTop: 8 }}>
        {children}
      </div>
    </details>
  );
}
