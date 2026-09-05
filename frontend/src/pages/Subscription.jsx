import { useState, useEffect } from "react";
import { PRIMARY, PRIMARY_DARK, PRIMARY_LIGHT, popQueryParam } from "../data/constants";
import Modal from "../components/ui/Modal";
import { billingMe, billingCheckout, billingPortal, billingDetails, billingReactivate, billingChangePlan, accountSetPhone, errText} from "../data/api";
import { isValidPhone, maskPhoneInput, toStoredPhone } from "../data/phone";

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
      "1 grupo líder por campanha de repasse",
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
      "3 grupos líderes por campanha de repasse",
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
      "5 grupos líderes por campanha de repasse",
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

// Badge de status de fatura. Estorno vem antes do status do Stripe: uma fatura
// reembolsada continua "paid" pra sempre lá, e mostrar "Paga" pra quem recebeu
// o dinheiro de volta é mentira. Cinza neutro — não é erro, só não vale mais.
function invoiceBadge(inv) {
  const neutro = { color: "var(--color-text-secondary)", bg: "var(--color-background-secondary)", border: "var(--color-border-tertiary)" };
  if (inv?.refundStatus === "full") return { label: "Reembolsada", ...neutro };
  if (inv?.refundStatus === "partial") return { label: "Reembolsada em parte", ...neutro };
  const status = inv?.status;
  if (status === "paid") return { label: "Paga", color: "#3B6D11", bg: "#EAF3DE", border: "#C5DBA7" };
  if (status === "open") return { label: "Em aberto", color: "var(--warn-text)", bg: "var(--warn-bg)", border: "var(--warn-border)" };
  if (status === "void") return { label: "Anulada", color: "var(--color-text-secondary)", bg: "var(--color-background-secondary)", border: "var(--color-border-tertiary)" };
  if (status === "uncollectible") return { label: "Não paga", color: "var(--danger-text)", bg: "var(--danger-bg)", border: "var(--danger-border)" };
  return { label: status || "—", color: "var(--color-text-secondary)", bg: "var(--color-background-secondary)", border: "var(--color-border-tertiary)" };
}

function statusBadge(status, trialDays, cancelAtPeriodEnd) {
  if (cancelAtPeriodEnd) return { label: "Cancelamento agendado", color: "var(--warn-text)", bg: "var(--warn-bg)", border: "var(--warn-border)" };
  if (status === "trialing") return { label: `Trial (${trialDays ?? 0}d restantes)`, color: "#185FA5", bg: "#E6F1FB", border: "#B6D5EF" };
  if (status === "active") return { label: "Ativa", color: "#3B6D11", bg: "#EAF3DE", border: "#C5DBA7" };
  if (status === "past_due") return { label: "Pagamento atrasado", color: "var(--danger-text)", bg: "var(--danger-bg)", border: "var(--danger-border)" };
  if (status === "canceled") return { label: "Cancelada", color: "var(--danger-text)", bg: "var(--danger-bg)", border: "var(--danger-border)" };
  if (status === "incomplete") return { label: "Pagamento incompleto", color: "var(--warn-text)", bg: "var(--warn-bg)", border: "var(--warn-border)" };
  if (status === "unpaid") return { label: "Não paga", color: "var(--danger-text)", bg: "var(--danger-bg)", border: "var(--danger-border)" };
  return { label: "Sem assinatura", color: "var(--color-text-secondary)", bg: "var(--color-background-secondary)", border: "var(--color-border-tertiary)" };
}

export default function PageSubscription({ user, setUser }) {
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null); // planId em checkout, "portal", "cancel" ou "reactivate"
  // Telefone de quem pulou a tela de cadastro do número. A entrada do painel
  // deixa adiar; virar cliente pagante não — o backend recusa o checkout com
  // code "phone_required". O campo abaixo é onde a pessoa resolve isso.
  const [phone, setPhone] = useState("");
  const [phoneSaving, setPhoneSaving] = useState(false);
  const phoneRequired = !!user?.phoneRequired;
  const [error, setError] = useState("");
  // Confirmação de ações que acontecem sem sair da página (hoje: upgrade).
  const [notice, setNotice] = useState("");
  const [showCancel, setShowCancel] = useState(false);
  // Assinatura pedida por quem está em cortesia: { planId, planName, price } —
  // antes de ir pro Stripe a pessoa escolhe se mantém a cortesia ou começa a
  // pagar hoje. `manterCortesia` guarda a escolha enquanto o modal está aberto.
  const [cortesiaCheckout, setCortesiaCheckout] = useState(null);
  const [manterCortesia, setManterCortesia] = useState(true);
  // Detalhes de cobrança (próxima fatura, cartão, histórico) — carrega 1x no
  // mount, separado do status pra não bloquear a página se o Stripe demorar.
  const [details, setDetails] = useState(null);
  // Plano escolhido lá na landing por quem já assinava (/assinatura?plano=pro).
  // Serve só pra destacar o card certo — a troca continua sendo um clique da
  // pessoa, cobrança nenhuma acontece sozinha. Lido uma vez; popQueryParam já
  // limpa a URL, então um F5 não repete o destaque.
  const [wantedPlan] = useState(() => {
    const p = popQueryParam("plano");
    return PLAN_ORDER.includes(p) ? p : null;
  });

  useEffect(() => {
    let cancelled = false;
    async function pull(fresh) {
      try {
        // fresh=true (mount) faz o backend reconciliar com o Stripe ao vivo;
        // o polling lê só o banco (mais leve).
        const data = await billingMe(fresh);
        if (!cancelled) { setMe(data); setError(""); }
      } catch (err) {
        if (!cancelled) setError(errText(err, "Não foi possível concluir a ação na assinatura."));
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

  async function salvarTelefone() {
    setError("");
    if (!isValidPhone(phone)) return setError("Informe um celular válido com DDD");
    setPhoneSaving(true);
    try {
      const r = await accountSetPhone(toStoredPhone(phone));
      setUser?.(r.user);
      setPhone("");
    } catch (err) {
      setError(errText(err, "Não foi possível salvar o telefone"));
    } finally {
      setPhoneSaving(false);
    }
  }

  async function startCheckout(planId, opts) {
    // Antes do window.open: abrir a aba e depois descobrir que falta o telefone
    // deixaria uma aba em branco pendurada.
    if (phoneRequired) {
      setError("Informe seu telefone acima para assinar.");
      return;
    }
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
      setError(errText(err, "Não foi possível concluir a ação na assinatura."));
    } finally {
      setBusy(null);
    }
  }

  // Fecha o modal e segue pro Stripe. Chamado do clique no "Continuar" — tem que
  // continuar sendo um clique de verdade, senão o window.open de startCheckout
  // cai no bloqueador de popup.
  function confirmarCortesiaCheckout() {
    const alvo = cortesiaCheckout;
    setCortesiaCheckout(null);
    startCheckout(alvo.planId, { keepManualTrial: manterCortesia });
  }

  // Upgrade de quem JÁ tem assinatura: troca o plano na assinatura existente e
  // cobra só a diferença proporcional. Sem isto, subir de plano abria um novo
  // checkout — e o cliente terminaria com duas assinaturas ativas.
  async function upgradePlan(planId, planName) {
    setBusy(planId);
    setError("");
    try {
      const updated = await billingChangePlan(planId);
      setMe(prev => ({ ...prev, ...updated }));
      setNotice(`Plano alterado para ${planName}. A diferença proporcional foi cobrada no cartão cadastrado.`);
      billingDetails().then(setDetails).catch(() => {});
    } catch (err) {
      setError(errText(err, "Não foi possível concluir a ação na assinatura."));
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
      setError(errText(err, "Não foi possível concluir a ação na assinatura."));
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
      setError(errText(err, "Não foi possível concluir a ação na assinatura."));
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
        <div style={{ background: "var(--danger-bg)", border: "0.5px solid var(--danger-border)", color: "var(--danger-text)", padding: 10, borderRadius: 8, fontSize: 13 }}>
          {error || "Falha ao carregar status de assinatura."}
        </div>
      </div>
    );
  }

  // Nome de exibição de um plano — mesmo critério do hero: catálogo do Stripe
  // primeiro, PLAN_META como reserva.
  const nomeDoPlano = id => me.plans?.find(p => p.id === id)?.label || PLAN_META[id]?.name || id;
  const currentPlan = me.effectivePlan || "free";
  // Nome do produto no Stripe; PLAN_META (e, no limite, o próprio id) é fallback.
  const currentPlanName = me.plans?.find(p => p.id === currentPlan)?.label
    || PLAN_META[currentPlan]?.name
    || currentPlan;
  const isAdmin = !!me.isAdmin;
  // Cortesia do admin (trial manual) valendo agora — só quando não está dormente
  // por baixo de uma assinatura paga.
  const cortesia = me.manualTrial?.active && !me.manualTrial?.dormant ? me.manualTrial : null;
  // Assinou DURANTE a cortesia: a assinatura já existe, mas a primeira cobrança
  // só roda quando a cortesia acaba (trial_end no Stripe). O status é "trialing"
  // igual ao teste de R$1 — o que separa os dois é a cortesia ainda vigente.
  const inicioAdiado = me.status === "trialing" && me.manualTrial?.active ? me.manualTrial : null;
  // O que a pessoa realmente ASSINA, que não é a mesma coisa que o plano em vigor:
  // `currentPlan` pode ser uma cortesia, e travar o card dela como "Plano atual"
  // impediria justamente que ela assinasse o plano que acabou de testar.
  // Durante a janela adiada o plano contratado ainda NÃO está valendo (quem vale
  // é a cortesia), então ele não pode aparecer como "SEU PLANO" nem travar o card.
  const planoAssinado = inicioAdiado
    ? "free"
    : (me.status === "active" || me.status === "trialing" || me.inGrace)
      ? (me.planId || "free")
      : "free";
  // O plano que passa a valer na data da primeira cobrança.
  const planoContratado = inicioAdiado ? (me.planId || null) : null;
  const hasActiveSub = (me.status === "active" || me.status === "trialing") && me.hasStripeCustomer;
  const badge = cortesia
    ? { label: `Cortesia (${cortesia.daysLeft}d restantes)`, color: "#0C4A6E", bg: "#E0F2FE", border: "#7DD3FC" }
    : inicioAdiado
      ? { label: `${nomeDoPlano(planoContratado)} em ${fmtDate(inicioAdiado.endsAt)}`, color: "#3B6D11", bg: "#EAF3DE", border: "#C5DBA7" }
      : statusBadge(me.status, me.daysLeftInTrial, me.cancelAtPeriodEnd);

  return (
    <div style={{ maxWidth: 920 }}>
      <h2 style={{ fontSize: 18, fontWeight: 500, marginBottom: 4 }}>Assinatura</h2>
      <div style={{ fontSize: 13, color: "var(--color-text-secondary)", marginBottom: 20 }}>
        Gerencie seu plano, pagamento e cancelamento.
      </div>

      {error && (
        <div style={{ background: "var(--danger-bg)", border: "0.5px solid var(--danger-border)", color: "var(--danger-text)", padding: 10, borderRadius: 8, fontSize: 13, marginBottom: 14 }}>
          {error}
        </div>
      )}
      {notice && (
        <div style={{ background: "var(--success-bg)", border: "0.5px solid var(--success-border)", color: "var(--success-text)", padding: 10, borderRadius: 8, fontSize: 13, marginBottom: 14 }}>
          {notice}
        </div>
      )}

      {phoneRequired && (
        <div style={{ background: "var(--warn-bg)", border: "0.5px solid var(--warn-border)", color: "var(--warn-text)", padding: 12, borderRadius: 8, fontSize: 13, marginBottom: 14 }}>
          <div style={{ marginBottom: 8 }}>
            Informe seu celular para assinar — é por ele que o suporte fala com você.
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input
              value={phone}
              onChange={e => setPhone(maskPhoneInput(e.target.value))}
              type="tel"
              inputMode="tel"
              placeholder="(11) 99999-9999"
              autoComplete="tel-national"
              maxLength={15}
              style={{ flex: "1 1 180px", minWidth: 0, padding: "8px 10px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13, fontFamily: "inherit", color: "var(--color-text-primary)" }}
            />
            <button
              type="button"
              onClick={salvarTelefone}
              disabled={phoneSaving}
              style={{ padding: "8px 14px", borderRadius: 8, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, fontWeight: 500, cursor: phoneSaving ? "default" : "pointer", opacity: phoneSaving ? 0.7 : 1 }}
            >
              {phoneSaving ? "Salvando…" : "Salvar"}
            </button>
          </div>
        </div>
      )}

      {/* Veio da landing querendo um plano maior: a tela explica onde confirmar
          em vez de deixar a pessoa procurar o card certo. */}
      {wantedPlan && wantedPlan !== currentPlan && (
        <div style={{ background: PRIMARY_LIGHT, border: `0.5px solid ${PRIMARY}`, color: PRIMARY_DARK, padding: 10, borderRadius: 8, fontSize: 13, marginBottom: 14 }}>
          Você escolheu o plano {me.plans?.find(p => p.id === wantedPlan)?.label || PLAN_META[wantedPlan].name} na
          nossa página. Confirme abaixo — {hasActiveSub ? "você paga só a diferença do que já assina." : "é só escolher e seguir pro pagamento."}
        </div>
      )}

      {!me.stripeEnabled && (
        <div style={{ background: "var(--warn-bg)", border: "0.5px solid var(--warn-border)", color: "var(--warn-text)", padding: 10, borderRadius: 8, fontSize: 13, marginBottom: 14 }}>
          Stripe não está configurado no servidor. Pagamentos desabilitados.
        </div>
      )}

      {isAdmin && (
        <div style={{ background: PRIMARY_LIGHT, border: `0.5px solid ${PRIMARY}`, color: PRIMARY_DARK, padding: 10, borderRadius: 8, fontSize: 13, marginBottom: 14 }}>
          Você é admin — acesso Business permanente (bypass de cobrança).
        </div>
      )}

      {cortesia && (
        <div style={{ background: "#E0F2FE", border: "0.5px solid #7DD3FC", color: "#0C4A6E", padding: "10px 14px", borderRadius: 8, fontSize: 13, marginBottom: 14 }}>
          Cortesia <strong>Nimbus {cortesia.planLabel}</strong> liberada pela equipe até <strong>{fmtDate(cortesia.endsAt)}</strong>
          {" "}— {cortesia.daysLeft} {cortesia.daysLeft === 1 ? "dia restante" : "dias restantes"}. Não há cobrança nenhuma.
          {" "}Se assinar agora, <strong>a primeira cobrança só acontece em {fmtDate(cortesia.endsAt)}</strong> — você não paga
          duas vezes pelos dias que já tem.
        </div>
      )}

      {inicioAdiado && (
        <div style={{ background: "#EAF3DE", border: "0.5px solid #C5DBA7", color: "#3B6D11", padding: "10px 14px", borderRadius: 8, fontSize: 13, marginBottom: 14 }}>
          Assinatura do <strong>{nomeDoPlano(planoContratado)}</strong> confirmada, e nada foi cobrado ainda: você segue
          no <strong>{inicioAdiado.planLabel}</strong> da cortesia até <strong>{fmtDate(inicioAdiado.endsAt)}</strong>.
          Nessa data o {nomeDoPlano(planoContratado)} entra e a primeira cobrança acontece, no cartão que você cadastrou.
        </div>
      )}

      {me.cancelAtPeriodEnd && (
        <div style={{ background: "var(--warn-bg)", border: "0.5px solid var(--warn-border)", color: "var(--warn-text)", padding: "10px 14px", borderRadius: 8, fontSize: 13, marginBottom: 14, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
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
                Nimbus {currentPlan === "free" ? "Free" : currentPlanName}
              </div>
              <span style={{ background: badge.bg, color: badge.color, border: `0.5px solid ${badge.border}`, fontSize: 11, padding: "3px 10px", borderRadius: 6, fontWeight: 500 }}>
                {badge.label}
              </span>
            </div>
            <div style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>
              {inicioAdiado && (
                <>Cortesia até <strong style={{ color: "var(--color-text-primary)" }}>{fmtDate(inicioAdiado.endsAt)}</strong>, quando o {nomeDoPlano(planoContratado)} entra e começa a cobrança. Nada foi cobrado até aqui.</>
              )}
              {!inicioAdiado && me.status === "trialing" && me.currentPeriodEnd && (
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
              {me.status === "canceled" && !cortesia && (
                <>Assinatura encerrada. Escolha um plano abaixo pra reativar.</>
              )}
              {cortesia && (
                <>Cortesia da equipe até <strong style={{ color: "var(--color-text-primary)" }}>{fmtDate(cortesia.endsAt)}</strong>. Depois disso a conta volta pro plano Free — assine antes pra não parar os envios.</>
              )}
              {currentPlan === "free" && !cortesia && me.status !== "trialing" && me.status !== "canceled" && (
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
                {/* O limite conta só o que está ATIVO — o que passou do plano fica
                    pausado (não envia), mas continua guardado. */}
                <UsageRow label="Campanhas ativas" used={me.usage?.activeGroups ?? me.usage?.groups} limit={me.limits?.groups} />
                {me.usage?.pausedGroups > 0 && (
                  <div style={{ fontSize: 11, color: "var(--warn-text)", marginTop: -6 }}>
                    +{me.usage.pausedGroups} campanha{me.usage.pausedGroups === 1 ? "" : "s"} pausada{me.usage.pausedGroups === 1 ? "" : "s"} pelo plano (guardada{me.usage.pausedGroups === 1 ? "" : "s"}, sem enviar)
                  </div>
                )}
                <UsageRow label="Números de WhatsApp ativos" used={me.usage?.activeNumbers ?? me.usage?.numbers} limit={me.limits?.numbers} />
                {me.usage?.pausedNumbers > 0 && (
                  <div style={{ fontSize: 11, color: "var(--warn-text)", marginTop: -6 }}>
                    +{me.usage.pausedNumbers} número{me.usage.pausedNumbers === 1 ? "" : "s"} pausado{me.usage.pausedNumbers === 1 ? "" : "s"} pelo plano (segue{me.usage.pausedNumbers === 1 ? "" : "m"} conectado{me.usage.pausedNumbers === 1 ? "" : "s"})
                  </div>
                )}
                <UsageRow label="Grupos por campanha (máx.)" used={me.usage?.maxWhatsappGroupsPerCampaign} limit={me.limits?.whatsappGroupsPerCampaign} />
                <UsageRow label="Categorias de produtos por campanha (máx.)" used={me.usage?.maxCategoriesPerGroup} limit={me.limits?.categoriesPerGroup} />
                <UsageRow label="Grupos líderes por campanha de repasse (máx.)" used={me.usage?.maxLeadersPerCampaign} limit={me.limits?.leadersPerCampaign} />
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
          // Nome e preço vêm do backend, que os lê do produto no Stripe;
          // PLAN_META é o fallback (e segue dono de tagline/features, que não
          // existem no Stripe).
          const livePlan = me.plans?.find(pl => pl.id === id);
          const price = livePlan?.priceBRL ?? p.price;
          const name = livePlan?.label || p.name;
          const current = planoAssinado === id;
          // Plano que está liberado por cortesia — marcado, mas nunca travado.
          const emCortesia = cortesia?.planId === id;
          // Plano que a pessoa escolheu na landing — o card ganha destaque e um
          // selo, pra ela reconhecer onde confirmar.
          const wanted = wantedPlan === id && !current;
          // Trial de R$1: só no Básico, só pra quem nunca assinou/trialou.
          // Durante a cortesia o teste de R$1 não é oferecido: pagar R$1 por 7 dias
          // de acesso que a pessoa já tem de graça não é oferta, é pegadinha. A
          // elegibilidade continua guardada pra quando a cortesia acabar.
          const trialOffer = id === "basic" && !!me.trialEligible && me.stripeEnabled && !current && !cortesia;
          const recommended = p.recommended && !current;
          const currentIdx = PLAN_ORDER.indexOf(planoAssinado);
          const isUpgrade = currentIdx >= 0 && PLAN_ORDER.indexOf(id) > currentIdx;
          const isDowngrade = currentIdx >= 0 && PLAN_ORDER.indexOf(id) < currentIdx;
          // Com assinatura viva, subir de plano é troca na própria assinatura
          // (cobra só a diferença) — não um checkout novo, que geraria uma
          // segunda assinatura pro mesmo cliente.
          const hasLiveSub = me.status === "active" || me.status === "trialing";
          const inlineUpgrade = isUpgrade && hasLiveSub;
          const ctaLabel = current ? "Plano atual"
            : busy === id ? (inlineUpgrade ? "Alterando…" : "Abrindo Stripe…")
            : trialOffer ? "Testar por R$ 1,00"
            : inlineUpgrade ? "Fazer upgrade"
            : "Assinar";
          const ctaHint = current ? null
            : inlineUpgrade ? "Paga só a diferença"
            : isUpgrade ? "Upgrade"
            : isDowngrade ? "Mudar para este"
            : null;
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
                ...(wanted ? { boxShadow: `0 0 0 4px ${PRIMARY_LIGHT}` } : {}),
              }}
            >
              {wanted && (
                <div style={{ position: "absolute", top: -10, left: "50%", transform: "translateX(-50%)", background: PRIMARY_DARK, color: "#fff", fontSize: 10, padding: "3px 10px", borderRadius: 6, fontWeight: 600, whiteSpace: "nowrap", letterSpacing: 0.3 }}>
                  VOCÊ ESCOLHEU
                </div>
              )}
              {current && (
                <div style={{ position: "absolute", top: -10, left: "50%", transform: "translateX(-50%)", background: PRIMARY, color: "#fff", fontSize: 10, padding: "3px 10px", borderRadius: 6, fontWeight: 600, whiteSpace: "nowrap", letterSpacing: 0.3 }}>
                  SEU PLANO
                </div>
              )}
              {planoContratado === id && (
                <div style={{ position: "absolute", top: -10, left: "50%", transform: "translateX(-50%)", background: "#3B6D11", color: "#fff", fontSize: 10, padding: "3px 10px", borderRadius: 6, fontWeight: 600, whiteSpace: "nowrap", letterSpacing: 0.3 }}>
                  A PARTIR DE {fmtDate(inicioAdiado.endsAt)}
                </div>
              )}
              {emCortesia && !current && !wanted && planoContratado !== id && (
                <div style={{ position: "absolute", top: -10, left: "50%", transform: "translateX(-50%)", background: "#0E7490", color: "#fff", fontSize: 10, padding: "3px 10px", borderRadius: 6, fontWeight: 600, whiteSpace: "nowrap", letterSpacing: 0.3 }}>
                  EM CORTESIA
                </div>
              )}
              {recommended && !trialOffer && !wanted && !emCortesia && (
                <div style={{ position: "absolute", top: -10, left: "50%", transform: "translateX(-50%)", background: PRIMARY, color: "#fff", fontSize: 10, padding: "3px 10px", borderRadius: 6, fontWeight: 600, whiteSpace: "nowrap", letterSpacing: 0.3 }}>
                  MAIS POPULAR
                </div>
              )}
              {trialOffer && !wanted && (
                <div style={{ position: "absolute", top: -10, left: "50%", transform: "translateX(-50%)", background: "#22C55E", color: "#fff", fontSize: 10, padding: "3px 10px", borderRadius: 6, fontWeight: 600, whiteSpace: "nowrap", letterSpacing: 0.3 }}>
                  7 DIAS POR R$1
                </div>
              )}
              <div style={{ fontWeight: 500, fontSize: 15, marginBottom: 2 }}>{name}</div>
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
                onClick={() => {
                  if (current) return;
                  if (inlineUpgrade) return upgradePlan(id, name);
                  // Em cortesia, assinar tem duas saídas possíveis e nenhuma
                  // delas é óbvia — a pessoa escolhe antes de ver o Stripe.
                  if (cortesia) {
                    setManterCortesia(true);
                    setCortesiaCheckout({ planId: id, planName: name, price });
                    return;
                  }
                  startCheckout(id, trialOffer ? { trial: true } : undefined);
                }}
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
              {trialOffer && !wanted && (
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
                    const b = invoiceBadge(inv);
                    return (
                      <tr key={inv.id} style={{ borderTop: "0.5px solid var(--color-border-tertiary)" }}>
                        <td style={{ padding: "9px 8px 9px 0" }}>{fmtDate(inv.date)}</td>
                        <td style={{ padding: "9px 8px 9px 0", fontWeight: 500 }}>
                          {fmtPrice(inv.amountBRL)}
                          {inv.refundStatus === "partial" && (
                            <span style={{ fontWeight: 400, color: "var(--color-text-secondary)", fontSize: 11, marginLeft: 6 }}>
                              −{fmtPrice(inv.refundedBRL)}
                            </span>
                          )}
                        </td>
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
          <div style={{ fontWeight: 500, fontSize: 13, marginBottom: 4, color: hasActiveSub ? "var(--danger-text)" : "var(--color-text-primary)" }}>Cancelar assinatura</div>
          <div style={{ fontSize: 12, color: "var(--color-text-secondary)", lineHeight: 1.5, marginBottom: 12 }}>
            {me.cancelAtPeriodEnd
              ? `Cancelamento já agendado — acesso até ${fmtDate(me.currentPeriodEnd)}. Pode reverter aqui mesmo.`
              : hasActiveSub
                ? "Você continua com acesso até o fim do período já pago. Seus dados ficam guardados enquanto a conta existir, caso decida voltar."
                : "Você não tem uma assinatura ativa pra cancelar."
            }
          </div>
          <button
            onClick={() => setShowCancel(true)}
            disabled={!hasActiveSub || !!busy}
            style={{
              padding: "7px 14px", borderRadius: 8,
              background: hasActiveSub ? "var(--danger-bg)" : "var(--color-background-secondary)",
              color: hasActiveSub ? "var(--danger-text)" : "var(--color-text-secondary)",
              border: `0.5px solid ${hasActiveSub ? "var(--danger-border)" : "var(--color-border-tertiary)"}`,
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
        <FAQ q="Como funciona o teste de 7 dias por R$1?">
          Disponível no plano Básico, para quem nunca assinou. Você paga R$ 1,00 hoje e usa tudo por 7 dias.
          No 16º dia começa a cobrança normal de {fmtPrice(me.plans?.find(p => p.id === "basic")?.priceBRL ?? PLAN_META.basic.price)}/mês —
          cancele antes e não paga mais nada. Vale uma vez por conta.
        </FAQ>
        <FAQ q="O que acontece quando eu cancelo?">
          Você continua com acesso completo até o fim do período já pago — depois disso a conta vira plano Free
          e os envios automáticos param. Nada é apagado: suas campanhas, números e histórico ficam guardados
          enquanto a conta existir — só param de enviar, e voltam assim que você assinar de novo. Se quiser
          apagar seus dados, é só pedir pelo suporte.
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
      {/* Assinar durante a cortesia: as duas saídas, com as datas e os valores já
          calculados. Sem isto o sistema escolhia sozinho — e a escolha errada
          ou cobrava dias já concedidos, ou tirava o plano no meio do prazo. */}
      {cortesiaCheckout && cortesia && (() => {
        const opcao = (valor, titulo, texto) => (
          <button
            onClick={() => setManterCortesia(valor)}
            style={{
              width: "100%", textAlign: "left", padding: 12, borderRadius: 10, cursor: "pointer",
              marginBottom: 8, background: manterCortesia === valor ? PRIMARY_LIGHT : "transparent",
              border: manterCortesia === valor ? `0.5px solid ${PRIMARY}` : "0.5px solid var(--color-border-tertiary)",
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4, color: manterCortesia === valor ? PRIMARY_DARK : "var(--color-text-primary)" }}>
              {titulo}
            </div>
            <div style={{ fontSize: 12, lineHeight: 1.5, color: "var(--color-text-secondary)" }}>{texto}</div>
          </button>
        );
        return (
          <Modal title={`Você está em cortesia até ${fmtDate(cortesia.endsAt)}`} onClose={() => setCortesiaCheckout(null)}>
            <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 14, lineHeight: 1.5 }}>
              Sua equipe liberou o <strong>Nimbus {cortesia.planLabel}</strong> sem cobrança até{" "}
              {fmtDate(cortesia.endsAt)} ({cortesia.daysLeft} {cortesia.daysLeft === 1 ? "dia" : "dias"}).
              Como você está assinando o <strong>{cortesiaCheckout.planName}</strong> antes disso, escolha o que prefere:
            </div>

            {opcao(true, "Manter a cortesia (nada é cobrado agora)",
              `Você continua no ${cortesia.planLabel} até ${fmtDate(cortesia.endsAt)}. Nesse dia o `
              + `${cortesiaCheckout.planName} entra e a primeira cobrança de ${fmtPrice(cortesiaCheckout.price)} acontece `
              + "no cartão que você cadastrar agora.")}

            {opcao(false, `Começar o ${cortesiaCheckout.planName} agora`,
              `Sua cortesia é encerrada hoje, o ${cortesiaCheckout.planName} entra na hora e a cobrança de `
              + `${fmtPrice(cortesiaCheckout.price)} é feita agora. Os dias restantes de cortesia não voltam depois.`)}

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
              <button
                onClick={() => setCortesiaCheckout(null)}
                style={{ padding: "8px 16px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", color: "var(--color-text-primary)", fontSize: 13, cursor: "pointer" }}
              >
                Cancelar
              </button>
              <button
                onClick={confirmarCortesiaCheckout}
                style={{ padding: "8px 16px", borderRadius: 8, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500 }}
              >
                Continuar
              </button>
            </div>
          </Modal>
        );
      })()}

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
                <li>Suas campanhas, grupos e histórico ficam guardados (nada é apagado) — só param de enviar</li>
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
