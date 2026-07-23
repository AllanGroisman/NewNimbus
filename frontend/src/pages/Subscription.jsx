import { useState, useEffect } from "react";
import { PRIMARY, PRIMARY_DARK, PRIMARY_LIGHT } from "../data/constants";
import Modal from "../components/ui/Modal";
import { billingMe, billingCheckout, billingPortal, billingDetails, billingReactivate } from "../data/api";

const BILLING_POLL_MS = 20 * 1000;

const PLAN_META = {
  basic: {
    name: "Básico",
    tagline: "Pra começar com 1 número",
    price: 69.90,
    features: [
      "1 número de WhatsApp",
      "1 campanha",
      "3 grupos por campanha",
      "2 categorias de produtos",
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
      "Todas as categorias de produtos",
    ],
  },
  business: {
    name: "Business",
    tagline: "Para operações grandes",
    price: 149.90,
    features: [
      "5 números de WhatsApp",
      "Campanhas ilimitadas",
      "Grupos ilimitados por campanha",
      "Todas as categorias de produtos",
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

// Nome amigável da bandeira do cartão (Stripe manda em minúsculas).
const CARD_BRANDS = { visa: "Visa", mastercard: "Mastercard", amex: "Amex", elo: "Elo", hipercard: "Hipercard" };
function cardBrandLabel(brand) {
  return CARD_BRANDS[brand] || (brand ? brand.charAt(0).toUpperCase() + brand.slice(1) : "Cartão");
}

// Badge de status de fatura do Stripe (paid/open/void/uncollectible/draft).
function invoiceBadge(status) {
  if (status === "paid") return { label: "Paga", color: "#3B6D11", bg: "#EAF3DE", border: "#C5DBA7" };
  if (status === "open") return { label: "Em aberto", color: "#854F0B", bg: "#FFF7E0", border: "#F0D58A" };
  if (status === "void") return { label: "Anulada", color: "var(--color-text-secondary)", bg: "var(--color-background-secondary)", border: "var(--color-border-tertiary)" };
  if (status === "uncollectible") return { label: "Não paga", color: "#A32D2D", bg: "#FCEBEB", border: "#F7C1C1" };
  return { label: status || "—", color: "var(--color-text-secondary)", bg: "var(--color-background-secondary)", border: "var(--color-border-tertiary)" };
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
  const [busy, setBusy] = useState(null); // planId em checkout, "portal", "cancel" ou "reactivate"
  const [error, setError] = useState("");
  const [showCancel, setShowCancel] = useState(false);
  // Detalhes de cobrança (próxima fatura, cartão, histórico) — carrega 1x no
  // mount, separado do status pra não bloquear a página se o Stripe demorar.
  const [details, setDetails] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function pull(fresh) {
      try {
        // fresh=true (mount) faz o backend reconciliar com o Stripe ao vivo;
        // o polling lê só o banco (mais leve).
        const data = await billingMe(fresh);
        if (!cancelled) { setMe(data); setError(""); }
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    async function pullDetails() {
      try {
        const data = await billingDetails();
        if (!cancelled) setDetails(data);
      } catch {
        // Não bloqueia a página — seções de detalhe mostram fallback.
        if (!cancelled) setDetails(null);
      }
    }
    pull(true);
    pullDetails();
    // Polling leve — o plano pode mudar em segundo plano (webhook do Stripe
    // processando após o checkout, ou um admin alterando o plano manualmente),
    // e sem isso o usuário só via a mudança dando F5. Pausa com a aba oculta.
    let timer = setInterval(() => { if (!document.hidden) pull(); }, BILLING_POLL_MS);
    // Ao voltar pra esta aba (ex.: depois de mexer no Stripe em outra aba),
    // reconcilia com o Stripe (fresh — o backend tem throttle de 60s) e
    // recarrega os detalhes (cartão/próxima fatura podem ter mudado).
    const onVisibility = () => { if (!document.hidden) { pull(true); pullDetails(); } };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  async function startCheckout(planId, opts) {
    setBusy(planId);
    setError("");
    // Abre a aba em branco AINDA no clique (síncrono) — se abrisse depois do
    // await, o bloqueador de popup do navegador impediria a aba nova.
    const win = window.open("", "_blank");
    try {
      const { url } = await billingCheckout(planId, opts);
      if (win) win.location = url;
      else window.location.assign(url); // popup bloqueado → segue na mesma aba
    } catch (err) {
      if (win) win.close();
      setError(err.message);
    } finally {
      setBusy(null);
    }
  }

  // Desfaz cancelamento agendado direto na página (sem passar pelo portal).
  async function reactivate() {
    setBusy("reactivate");
    setError("");
    try {
      const updated = await billingReactivate();
      // Merge — a resposta não traz `usage`, então preserva o que já temos.
      setMe(prev => ({ ...prev, ...updated }));
      // Recarrega detalhes — a próxima fatura volta a existir após reativar.
      billingDetails().then(setDetails).catch(() => {});
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  }

  async function openPortal(action) {
    setBusy(action || "portal");
    setError("");
    // Mesmo padrão do checkout — abre a aba antes do await pra não ser bloqueada.
    const win = window.open("", "_blank");
    try {
      const { url } = await billingPortal();
      if (win) win.location = url;
      else window.location.assign(url); // popup bloqueado → segue na mesma aba
    } catch (err) {
      if (win) win.close();
      setError(err.message);
    } finally {
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
        <div style={{ background: "#FFF7E0", border: "0.5px solid #F0D58A", color: "#7A5800", padding: "10px 14px", borderRadius: 8, fontSize: 13, marginBottom: 14, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <span>
            Sua assinatura termina em <strong>{me.daysUntilPeriodEnd ?? "—"} {me.daysUntilPeriodEnd === 1 ? "dia" : "dias"}</strong> ({fmtDate(me.currentPeriodEnd)}). Até lá, tudo continua funcionando.
          </span>
          <button
            onClick={reactivate}
            disabled={!!busy}
            style={{ padding: "7px 14px", borderRadius: 8, background: "#22C55E", color: "#fff", border: "none", fontSize: 12, fontWeight: 500, cursor: busy ? "wait" : "pointer", opacity: busy ? 0.6 : 1, whiteSpace: "nowrap" }}
          >
            {busy === "reactivate" ? "Reativando…" : "Reativar assinatura"}
          </button>
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

      {/* ─── SEU PLANO EM USO ─── */}
      {currentPlan !== "free" && (
        <>
          <h3 style={{ fontSize: 14, fontWeight: 500, marginBottom: 12 }}>Seu plano em uso</h3>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12, marginBottom: 28 }}>
            {/* Benefícios × uso */}
            <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 10, padding: 14 }}>
              <div style={{ fontWeight: 500, fontSize: 13, marginBottom: 10 }}>Benefícios e uso</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                <UsageRow label="Campanhas" used={me.usage?.groups} limit={me.limits?.groups} />
                <UsageRow label="Números de WhatsApp" used={me.usage?.numbers} limit={me.limits?.numbers} />
                <UsageRow label="Grupos por campanha (máx.)" used={me.usage?.maxWhatsappGroupsPerCampaign} limit={me.limits?.whatsappGroupsPerCampaign} />
                <UsageRow label="Categorias de produtos por campanha (máx.)" used={me.usage?.maxCategoriesPerGroup} limit={me.limits?.categoriesPerGroup} />
              </div>
            </div>

            {/* Próxima fatura */}
            <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 10, padding: 14 }}>
              <div style={{ fontWeight: 500, fontSize: 13, marginBottom: 10 }}>Próxima cobrança</div>
              {details === null ? (
                <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>Carregando…</div>
              ) : details.upcomingInvoice ? (
                <>
                  <div style={{ fontSize: 22, fontWeight: 500, marginBottom: 4 }}>{fmtPrice(details.upcomingInvoice.amountBRL)}</div>
                  <div style={{ fontSize: 12, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
                    {me.status === "trialing"
                      ? <>Primeira cobrança após o trial, em <strong style={{ color: "var(--color-text-primary)" }}>{fmtDate(details.upcomingInvoice.nextPaymentAttempt || me.currentPeriodEnd)}</strong>.</>
                      : <>Cobrança automática em <strong style={{ color: "var(--color-text-primary)" }}>{fmtDate(details.upcomingInvoice.nextPaymentAttempt || me.currentPeriodEnd)}</strong>.</>}
                  </div>
                </>
              ) : (
                <div style={{ fontSize: 12, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
                  {me.cancelAtPeriodEnd
                    ? "Sem cobrança futura — cancelamento agendado."
                    : "Sem cobrança futura agendada."}
                </div>
              )}
            </div>

            {/* Cartão cadastrado */}
            <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 10, padding: 14 }}>
              <div style={{ fontWeight: 500, fontSize: 13, marginBottom: 10 }}>Forma de pagamento</div>
              {details === null ? (
                <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>Carregando…</div>
              ) : details.paymentMethod ? (
                <div style={{ fontSize: 13, marginBottom: 12 }}>
                  {cardBrandLabel(details.paymentMethod.brand)} •••• {details.paymentMethod.last4}
                  <span style={{ color: "var(--color-text-secondary)", fontSize: 12 }}> · expira {String(details.paymentMethod.expMonth).padStart(2, "0")}/{String(details.paymentMethod.expYear).slice(-2)}</span>
                </div>
              ) : (
                <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 12 }}>Nenhum cartão salvo.</div>
              )}
              {me.hasStripeCustomer && (
                <button
                  onClick={() => openPortal("card")}
                  disabled={!!busy}
                  style={{ padding: "7px 14px", borderRadius: 8, background: "transparent", color: "var(--color-text-primary)", border: "0.5px solid var(--color-border-secondary)", fontSize: 12, cursor: busy ? "wait" : "pointer", fontWeight: 500 }}
                >
                  {busy === "card" ? "Abrindo…" : "Trocar cartão"}
                </button>
              )}
            </div>
          </div>
        </>
      )}

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
          // Preço vem do backend (fonte única em limits.js); PLAN_META é fallback.
          const price = me.plans?.find(pl => pl.id === id)?.priceBRL ?? p.price;
          const current = currentPlan === id;
          // Trial de R$1: só no Básico, só pra quem nunca assinou/trialou.
          const trialOffer = id === "basic" && !!me.trialEligible && me.stripeEnabled && !current;
          const recommended = p.recommended && !current;
          const currentIdx = PLAN_ORDER.indexOf(currentPlan);
          const isUpgrade = currentIdx >= 0 && PLAN_ORDER.indexOf(id) > currentIdx;
          const isDowngrade = currentIdx >= 0 && PLAN_ORDER.indexOf(id) < currentIdx;
          const ctaLabel = current ? "Plano atual"
            : busy === id ? "Abrindo Stripe…"
            : trialOffer ? "Testar por R$ 1,00"
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
                // Plano atual fica esmaecido — não dá pra "mudar" pra ele mesmo.
                opacity: current ? 0.55 : 1,
              }}
            >
              {current && (
                <div style={{ position: "absolute", top: -10, left: "50%", transform: "translateX(-50%)", background: PRIMARY, color: "#fff", fontSize: 10, padding: "3px 10px", borderRadius: 6, fontWeight: 600, whiteSpace: "nowrap", letterSpacing: 0.3 }}>
                  SEU PLANO
                </div>
              )}
              {recommended && !trialOffer && (
                <div style={{ position: "absolute", top: -10, left: "50%", transform: "translateX(-50%)", background: PRIMARY, color: "#fff", fontSize: 10, padding: "3px 10px", borderRadius: 6, fontWeight: 600, whiteSpace: "nowrap", letterSpacing: 0.3 }}>
                  MAIS POPULAR
                </div>
              )}
              {trialOffer && (
                <div style={{ position: "absolute", top: -10, left: "50%", transform: "translateX(-50%)", background: "#22C55E", color: "#fff", fontSize: 10, padding: "3px 10px", borderRadius: 6, fontWeight: 600, whiteSpace: "nowrap", letterSpacing: 0.3 }}>
                  15 DIAS POR R$1
                </div>
              )}
              <div style={{ fontWeight: 500, fontSize: 15, marginBottom: 2 }}>{p.name}</div>
              <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 12 }}>{p.tagline}</div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 4, marginBottom: 6 }}>
                <span style={{ fontSize: 24, fontWeight: 500, color: "var(--color-text-primary)" }}>{fmtPrice(price)}</span>
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
                onClick={() => !current && startCheckout(id, trialOffer ? { trial: true } : undefined)}
                disabled={current || !!busy || !me.stripeEnabled}
                style={{
                  width: "100%", padding: "9px", borderRadius: 8,
                  background: current
                    ? "var(--color-background-secondary)"
                    : (recommended || trialOffer ? PRIMARY : "transparent"),
                  color: current
                    ? "var(--color-text-secondary)"
                    : (recommended || trialOffer ? "#fff" : PRIMARY_DARK),
                  border: current
                    ? "0.5px solid var(--color-border-tertiary)"
                    : (recommended || trialOffer ? "none" : `0.5px solid ${PRIMARY}`),
                  fontSize: 13, fontWeight: 500,
                  cursor: current || !!busy || !me.stripeEnabled ? "not-allowed" : "pointer",
                  opacity: !me.stripeEnabled && !current ? 0.5 : 1,
                }}
              >
                {ctaLabel}
              </button>
              {trialOffer && (
                <button
                  onClick={() => startCheckout(id)}
                  disabled={!!busy}
                  style={{ marginTop: 8, background: "none", border: "none", padding: 0, fontSize: 11, color: "var(--color-text-secondary)", textDecoration: "underline", cursor: busy ? "wait" : "pointer" }}
                >
                  ou assinar direto por {fmtPrice(price)}/mês
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* ─── HISTÓRICO DE FATURAS ─── */}
      {me.hasStripeCustomer && (
        <>
          <h3 style={{ fontSize: 14, fontWeight: 500, marginBottom: 12 }}>Histórico de faturas</h3>
          <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 10, padding: "4px 14px", marginBottom: 28, overflowX: "auto" }}>
            {details === null ? (
              <div style={{ fontSize: 12, color: "var(--color-text-secondary)", padding: "12px 0" }}>Carregando…</div>
            ) : (details.invoices?.length || 0) === 0 ? (
              <div style={{ fontSize: 12, color: "var(--color-text-secondary)", padding: "12px 0" }}>Nenhuma fatura ainda.</div>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ textAlign: "left", color: "var(--color-text-secondary)" }}>
                    <th style={{ padding: "10px 8px 8px 0", fontWeight: 500 }}>Data</th>
                    <th style={{ padding: "10px 8px 8px 0", fontWeight: 500 }}>Valor</th>
                    <th style={{ padding: "10px 8px 8px 0", fontWeight: 500 }}>Status</th>
                    <th style={{ padding: "10px 0 8px", fontWeight: 500 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {details.invoices.map(inv => {
                    const b = invoiceBadge(inv.status);
                    return (
                      <tr key={inv.id} style={{ borderTop: "0.5px solid var(--color-border-tertiary)" }}>
                        <td style={{ padding: "9px 8px 9px 0" }}>{fmtDate(inv.date)}</td>
                        <td style={{ padding: "9px 8px 9px 0", fontWeight: 500 }}>{fmtPrice(inv.amountBRL)}</td>
                        <td style={{ padding: "9px 8px 9px 0" }}>
                          <span style={{ background: b.bg, color: b.color, border: `0.5px solid ${b.border}`, fontSize: 11, padding: "2px 8px", borderRadius: 6, fontWeight: 500 }}>{b.label}</span>
                        </td>
                        <td style={{ padding: "9px 0", textAlign: "right", whiteSpace: "nowrap" }}>
                          {inv.hostedUrl && (
                            <a href={inv.hostedUrl} target="_blank" rel="noreferrer" style={{ color: PRIMARY_DARK, marginRight: 10 }}>Abrir</a>
                          )}
                          {inv.pdfUrl && (
                            <a href={inv.pdfUrl} target="_blank" rel="noreferrer" style={{ color: PRIMARY_DARK }}>PDF</a>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

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
              ? `Cancelamento já agendado — acesso até ${fmtDate(me.currentPeriodEnd)}. Pode reverter aqui mesmo.`
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
        <FAQ q="Como funciona o teste de 15 dias por R$1?">
          Disponível no plano Básico, para quem nunca assinou. Você paga R$ 1,00 hoje e usa tudo por 15 dias.
          No 16º dia começa a cobrança normal de {fmtPrice(me.plans?.find(p => p.id === "basic")?.priceBRL ?? PLAN_META.basic.price)}/mês —
          cancele antes e não paga mais nada. Vale uma vez por conta.
        </FAQ>
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
              O cancelamento agendado será desfeito e a renovação volta a acontecer
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
              onClick={() => {
                setShowCancel(false);
                // Reativar acontece direto na página; cancelar de fato vai pro portal.
                if (me.cancelAtPeriodEnd) reactivate();
                else openPortal("cancel");
              }}
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

// Linha "usado/limite" com barrinha de progresso. Limites ≥99 são tratados
// como ilimitados (convenção de limits.js: 99/999 = sem limite prático).
function UsageRow({ label, used, limit }) {
  const unlimited = typeof limit === "number" && limit >= 99;
  const u = typeof used === "number" ? used : null;
  const pct = unlimited || !limit || u === null ? 0 : Math.min(100, Math.round((u / limit) * 100));
  const full = !unlimited && limit > 0 && u !== null && u >= limit;
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 3 }}>
        <span style={{ color: "var(--color-text-secondary)" }}>{label}</span>
        <span style={{ fontWeight: 500 }}>
          {u === null ? "—" : u}/{unlimited ? "Ilimitado" : limit}
        </span>
      </div>
      {!unlimited && (
        <div style={{ height: 4, borderRadius: 2, background: "var(--color-background-secondary)", overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${pct}%`, borderRadius: 2, background: full ? "#E9A23B" : PRIMARY, transition: "width .3s" }} />
        </div>
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
