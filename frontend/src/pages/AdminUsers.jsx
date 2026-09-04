// Admin › Usuários.
//
// O selo verde desta tela dizia só "Ativo", e ninguém sabia ativo de quê: ele
// significava apenas "não suspenso e com e-mail verificado" — nada sobre estar
// pagando, sobre as campanhas rodarem ou sobre haver número conectado. Os
// números da linha ("3 campanhas", "2 números") vinham de um count cru, então
// contavam campanha pausada e número que nunca conectou.
//
// Agora são três perguntas separadas, cada uma com seu selo (conta, assinatura,
// operação), e a linha expande com a ficha completa do usuário.

import { useState, useEffect, useCallback } from "react";
import { PRIMARY, PRIMARY_DARK, PRIMARY_LIGHT } from "../data/constants";
import Badge from "../components/ui/Badge";
import Modal from "../components/ui/Modal";
import StatCard from "../components/ui/StatCard";
import AlertBanner from "../components/ui/AlertBanner";
import {
  adminListUsers,
  adminDeleteUser,
  adminSetUserPassword,
  adminSetUserRole,
  adminVerifyUserEmail,
  adminSetUserSuspended,
  adminResendUserVerification,
  adminUserDetail,
  adminGrantManualTrial,
  adminRevokeManualTrial,
  adminGetRegistration,
  adminSetRegistration,
  errText,
} from "../data/api";

const USERS_POLL_MS = 20 * 1000;

const PLAN_LABEL = { free: "Free", basic: "Basic", pro: "Pro", business: "Business" };

// Status da assinatura → o que o admin precisa ler de relance. O rótulo diz o
// estado real do Stripe; nenhum deles se chama "ativo" solto.
const SUB_STATUS = {
  active:     { label: "Pagando",    color: "green" },
  trialing:   { label: "Trial",      color: "blue" },
  past_due:   { label: "Em atraso",  color: "amber" },
  unpaid:     { label: "Em atraso",  color: "amber" },
  incomplete: { label: "Incompleta", color: "amber" },
  canceled:   { label: "Cancelada",  color: "gray" },
  inactive:   { label: "Sem plano",  color: "gray" },
};

// As chaves têm que ser os status que o backend de fato emite (whatsapp/local.js:
// connected | connecting | awaiting_qr | disconnected | logged_out) mais o
// "offline" que a API injeta quando não há sessão viva. As antigas "qr" e
// "reconnecting" não existiam e caíam cruas no fallback.
const SESSION_STATUS = {
  connected:    { label: "conectado",     color: "green" },
  connecting:   { label: "conectando",    color: "amber" },
  awaiting_qr:  { label: "aguardando QR", color: "amber" },
  disconnected: { label: "desconectado",  color: "gray" },
  logged_out:   { label: "precisa relogar", color: "red" },
  offline:      { label: "desconectado",  color: "gray" },
};

// Uma assinatura conta como paga quando o Stripe diz active/trialing. past_due
// fica de fora de propósito: está em carência, e misturar os dois esconderia
// justamente quem precisa de atenção.
const PAGANDO = new Set(["active", "trialing"]);
const ATRASADO = new Set(["past_due", "unpaid"]);

// Trial manual (cortesia): planos que o admin pode liberar à mão e as durações
// mais usadas. O campo de dias continua livre — os botões são só atalho.
const TRIAL_PLANOS = [
  { id: "basic",    label: "Básico" },
  { id: "pro",      label: "Pro" },
  { id: "business", label: "Business" },
];
const TRIAL_DIAS = [7, 14, 30, 60];

const dt = iso => (iso ? new Date(iso).toLocaleDateString("pt-BR") : null);
const dtHora = iso =>
  iso ? new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : null;

function diasAte(iso) {
  if (!iso) return null;
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000);
}

// ─── Selos ────────────────────────────────────────────────────────────────

function ContaBadge({ user }) {
  if (user.suspended) return <Badge color="red">Suspenso</Badge>;
  // "yellow" não existe na paleta do Badge — caía em cinza sem ninguém notar.
  if (!user.emailVerified) return <Badge color="amber">Email pendente</Badge>;
  return <Badge color="green">Conta OK</Badge>;
}

function AssinaturaBadge({ sub }) {
  if (!sub) return <Badge color="gray">Sem plano</Badge>;
  if (sub.crossMode) return <Badge color="rose">Stripe {sub.crossMode}</Badge>;
  const s = SUB_STATUS[sub.status] || { label: sub.status, color: "gray" };
  const plano = PLAN_LABEL[sub.planId] || sub.planId;
  // O plano só entra no rótulo quando ele de fato vale agora: um "pro" cancelado
  // como selo verde de Pro era a leitura errada mais fácil desta tela.
  const vale = PAGANDO.has(sub.status) || ATRASADO.has(sub.status);
  return <Badge color={s.color}>{vale ? `${s.label} · ${plano}` : s.label}</Badge>;
}

// Selo próprio, e não um caso dentro do AssinaturaBadge: os dois convivem. Uma
// conta pode estar "Pagando · Básico" E ter uma cortesia guardada — que nesse caso
// está dormente (a assinatura paga vence) e reassume se a assinatura cair.
function CortesiaBadge({ sub }) {
  if (!sub?.manualTrialActive) return null;
  const plano = PLAN_LABEL[sub.manualTrialPlanId] || sub.manualTrialPlanId;
  // Assinou durante a cortesia e escolheu manter: a assinatura existe (status
  // trialing), mas quem vale até a primeira cobrança é a cortesia. Dizer
  // "dormente" aqui seria o oposto do que está acontecendo.
  if (sub.status === "trialing") {
    return <Badge color="cyan">Cortesia {plano} · {sub.manualTrialDaysLeft}d → {PLAN_LABEL[sub.planId] || sub.planId}</Badge>;
  }
  // Assinatura paga em vigor: a cortesia está guardada, e reassume se ela cair.
  if (PAGANDO.has(sub.status)) return <Badge color="gray">Cortesia {plano} (dormente)</Badge>;
  return <Badge color="cyan">Cortesia {plano} · {sub.manualTrialDaysLeft}d</Badge>;
}

function OperacaoBadges({ counts }) {
  if (!counts) return null;
  const { groups = 0, activeGroups = 0, numbers = 0, connectedNumbers = 0 } = counts;
  return (
    <>
      {groups > 0 && (
        <Badge color={activeGroups > 0 ? "teal" : "gray"}>
          {activeGroups}/{groups} campanhas ativas
        </Badge>
      )}
      {numbers > 0 && (
        <Badge color={connectedNumbers > 0 ? "teal" : "amber"}>
          {connectedNumbers > 0 ? `${connectedNumbers} conectado${connectedNumbers !== 1 ? "s" : ""}` : "nenhum conectado"}
        </Badge>
      )}
    </>
  );
}

// Os números do usuário direto na linha, cada um com seu status: a contagem de
// `OperacaoBadges` diz quantos conectaram, não quais — e era só pra ver "qual
// número" que se abria a ficha de um usuário por vez.
// O status vira texto colorido, não Badge: são as cores do Badge traduzidas pras
// vars do tema, porque aqui a cor pinta a própria linha de info secundária.
const COR_STATUS = {
  green: "var(--success-text)",
  amber: "var(--warn-text)",
  red:   "var(--danger-text)",
  gray:  "var(--color-text-secondary)",
};

function NumerosDaLinha({ numbers }) {
  if (!numbers?.length) return null;
  return (
    <span style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
      <span>📲</span>
      {numbers.map((n, i) => {
        const st = n.stuck ? { label: "travado", color: "red" } : SESSION_STATUS[n.status] || { label: n.status, color: "gray" };
        const cor = COR_STATUS[st.color] || COR_STATUS.gray;
        return (
          <span key={n.id}>
            {i > 0 && <span style={{ marginRight: 6 }}>·</span>}
            {n.label && n.phone ? `${n.label} · ${n.phone}` : (n.label || n.phone || n.id)}{" "}
            <span style={{ color: cor }}>({st.label})</span>
          </span>
        );
      })}
    </span>
  );
}

// ─── Blocos do painel expandido ───────────────────────────────────────────

const bloco = {
  background: "var(--color-background-primary)",
  border: "0.5px solid var(--color-border-tertiary)",
  borderRadius: 10,
  padding: 12,
};
const blocoTitulo = {
  fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5,
  color: "var(--color-text-secondary)", marginBottom: 8,
};
const linha = { fontSize: 12, display: "flex", justifyContent: "space-between", gap: 10, padding: "3px 0" };
const rotulo = { color: "var(--color-text-secondary)" };
const vazio = { fontSize: 12, color: "var(--color-text-secondary)", fontStyle: "italic" };

function Campo({ label, children }) {
  if (children === null || children === undefined || children === "") return null;
  return <div style={linha}><span style={rotulo}>{label}</span><span style={{ textAlign: "right" }}>{children}</span></div>;
}

function BlocoAssinatura({ sub }) {
  return (
    <div style={bloco}>
      <div style={blocoTitulo}>Assinatura</div>
      {!sub ? (
        <div style={vazio}>Nunca assinou — nenhuma linha de assinatura existe.</div>
      ) : (
        <>
          {sub.crossMode && (
            <AlertBanner
              tone="warn"
              message={`Esta assinatura nasceu no modo "${sub.crossMode}" do Stripe, que não é o modo ativo. O resto do sistema trata esta conta como free até o modo voltar.`}
              style={{ marginBottom: 8 }}
            />
          )}
          <Campo label="Plano contratado">{PLAN_LABEL[sub.planId] || sub.planId}</Campo>
          <Campo label="Plano em vigor">{PLAN_LABEL[sub.effectivePlanId] || sub.effectivePlanId}</Campo>
          <Campo label="Status Stripe">{sub.status}</Campo>
          <Campo label="Período até">{dt(sub.currentPeriodEnd)}</Campo>
          {sub.cancelAtPeriodEnd && <Campo label="Cancelamento">agendado para o fim do período</Campo>}
          {sub.graceEndsAt && (
            <Campo label="Carência">
              <span style={{ color: "var(--warn-text)" }}>
                até {dt(sub.graceEndsAt)} ({diasAte(sub.graceEndsAt)}d)
              </span>
            </Campo>
          )}
          <Campo label="Em atraso desde">{dt(sub.pastDueSince)}</Campo>
          <Campo label="Trial usado em">{dt(sub.trialUsedAt)}</Campo>
          {sub.manualTrialPlanId && (
            <>
              <Campo label="Cortesia (trial manual)">
                {PLAN_LABEL[sub.manualTrialPlanId] || sub.manualTrialPlanId}
                {sub.manualTrialActive ? ` · ${sub.manualTrialDaysLeft}d restantes` : " · encerrada"}
              </Campo>
              {sub.manualTrialActive && sub.status === "trialing" && (
                <Campo label="Contratado durante a cortesia">
                  {PLAN_LABEL[sub.planId] || sub.planId} entra em {dt(sub.manualTrialEndsAt)}, com a 1ª cobrança
                </Campo>
              )}
              <Campo label="Cortesia de">{dt(sub.manualTrialStartedAt)}</Campo>
              <Campo label="Cortesia até">{dt(sub.manualTrialEndsAt)}</Campo>
              <Campo label="Observação">{sub.manualTrialNote}</Campo>
            </>
          )}
          <Campo label="Origem">{sub.signupSource}</Campo>
          <Campo label="Modo Stripe">{sub.stripeMode}</Campo>
        </>
      )}
    </div>
  );
}

function BlocoNumeros({ numbers }) {
  return (
    <div style={bloco}>
      <div style={blocoTitulo}>Números do WhatsApp</div>
      {!numbers?.length ? (
        <div style={vazio}>Nenhum número cadastrado.</div>
      ) : numbers.map(n => {
        const st = n.stuck ? { label: "travado", color: "red" } : (SESSION_STATUS[n.status] || { label: n.status, color: "gray" });
        return (
          <div key={n.id} style={{ padding: "5px 0", borderTop: "0.5px solid var(--color-border-tertiary)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ fontSize: 12 }}>{n.label || n.phone || n.id}</span>
              <span style={{ display: "flex", gap: 4 }}>
                {n.planPaused && <Badge color="gray">pausado pelo plano</Badge>}
                <Badge color={st.color}>{st.label}</Badge>
              </span>
            </div>
            {n.phone && n.label && <div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>{n.phone}</div>}
            {n.lastError && <div style={{ fontSize: 11, color: "var(--danger-text)", marginTop: 2 }}>{n.lastError}</div>}
          </div>
        );
      })}
    </div>
  );
}

function BlocoCampanhas({ groups }) {
  return (
    <div style={bloco}>
      <div style={blocoTitulo}>Campanhas</div>
      {!groups?.length ? (
        <div style={vazio}>Nenhuma campanha criada.</div>
      ) : groups.map(g => (
        <div key={g.id} style={{ padding: "6px 0", borderTop: "0.5px solid var(--color-border-tertiary)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 3 }}>
            <span style={{ fontSize: 12, fontWeight: 500 }}>{g.name}</span>
            <span style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              <Badge color={g.kind === "repasse" ? "indigo" : "gray"}>{g.kind === "repasse" ? "Repasse" : "Scraping"}</Badge>
              {g.active
                ? <Badge color="green">Ativa</Badge>
                : g.planPaused
                  ? <Badge color="amber">Pausada pelo plano</Badge>
                  : <Badge color="gray">Pausada pelo usuário</Badge>}
            </span>
          </div>
          <div style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "flex", gap: 10, flexWrap: "wrap" }}>
            <span>{g.whatsappGroups} grupo{g.whatsappGroups !== 1 ? "s" : ""}</span>
            {g.kind === "repasse" && <span>{g.leaders} líder{g.leaders !== 1 ? "es" : ""}</span>}
            <span>hoje {g.sentToday}</span>
            <span>semana {g.sentWeek}</span>
            {g.queue > 0 && <span>fila {g.queue}</span>}
            {g.pending > 0 && <span style={{ color: "var(--warn-text)" }}>revisão {g.pending}</span>}
            {g.lastSend && g.lastSend !== "—" && <span>último {dtHora(g.lastSend) || g.lastSend}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

function BlocoSaude({ repasse, emails, affiliate }) {
  const outcomes = repasse?.byOutcome || {};
  return (
    <div style={bloco}>
      <div style={blocoTitulo}>Repasse, afiliados e e-mails</div>

      {repasse ? (
        <>
          <div style={{ fontSize: 12, marginBottom: 4 }}>
            {repasse.total} link{repasse.total !== 1 ? "s" : ""} capturado{repasse.total !== 1 ? "s" : ""} em 7 dias
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
            {Object.entries(outcomes).map(([k, v]) => (
              <Badge key={k} color={k === "queued" || k === "pending" ? "teal" : "gray"}>{k} {v}</Badge>
            ))}
          </div>
          {repasse.byErrorKind?.length > 0 && (
            <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 8 }}>
              Principais motivos: {repasse.byErrorKind.slice(0, 3).map(k => `${k.kind} (${k.count})`).join(", ")}
            </div>
          )}
        </>
      ) : (
        <div style={{ ...vazio, marginBottom: 8 }}>Sem campanha de repasse.</div>
      )}

      {affiliate && (
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 8 }}>
          {["ml", "amazon", "shopee"].map(loja => {
            const a = affiliate[loja];
            if (!a) return null;
            return (
              <Badge key={loja} color={!a.configured ? "gray" : a.healthy === false ? "red" : "green"}>
                {loja} {a.configured ? (a.healthy === false ? "com falha" : "ok") : "não configurado"}
              </Badge>
            );
          })}
        </div>
      )}

      <div style={{ ...blocoTitulo, marginTop: 4, marginBottom: 4 }}>Últimos e-mails</div>
      {!emails?.length ? (
        <div style={vazio}>Nenhum e-mail enviado.</div>
      ) : emails.slice(0, 8).map(e => (
        <div key={e.id} style={{ ...linha, padding: "2px 0" }}>
          <span style={rotulo}>{e.kind}</span>
          <span style={{ color: e.status === "sent" ? "var(--color-text-primary)" : "var(--danger-text)" }}>
            {e.status === "sent" ? dtHora(e.sentAt || e.createdAt) : e.status}
          </span>
        </div>
      ))}
    </div>
  );
}

function PainelDetalhe({ dados, carregando, erro, onRetry }) {
  if (erro) return <AlertBanner tone="error" message={erro} onRetry={onRetry} />;
  if (carregando || !dados) {
    return <div style={{ fontSize: 12, color: "var(--color-text-secondary)", padding: 4 }}>Carregando…</div>;
  }
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 10 }}>
      <BlocoAssinatura sub={dados.subscription} />
      <BlocoNumeros numbers={dados.numbers} />
      <BlocoCampanhas groups={dados.groups} />
      <BlocoSaude repasse={dados.repasse} emails={dados.emails} affiliate={dados.affiliate} />
    </div>
  );
}

// ─── Página ───────────────────────────────────────────────────────────────

export default function PageAdminUsers({ currentUser }) {
  const [users, setUsers]           = useState([]);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState(null);
  const [search, setSearch]         = useState("");
  const [filter, setFilter]         = useState("all"); // all | paying | canceled | canceling | manual-trial | unverified | suspended | admin

  // Bloqueio de cadastro (beta fechado). null = ainda carregando.
  const [regBlocked, setRegBlocked] = useState(null);
  const [regBusy, setRegBusy]       = useState(false);

  // Linha expandida + cache das fichas já buscadas. A ficha junta 6 consultas,
  // então é carregada uma vez por usuário e não entra no polling da lista.
  const [aberto, setAberto]         = useState(null);   // userId
  const [detalhe, setDetalhe]       = useState({});     // userId → bundle
  const [detalheBusy, setDetalheBusy] = useState({});
  const [detalheErro, setDetalheErro] = useState({});

  // Modais
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [pwdUser, setPwdUser]             = useState(null);
  const [newPwd, setNewPwd]               = useState("");
  const [pwdError, setPwdError]           = useState(null);
  const [savingPwd, setSavingPwd]         = useState(false);
  const [trialUser, setTrialUser]         = useState(null);
  const [trialPlan, setTrialPlan]         = useState("pro");
  const [trialDays, setTrialDays]         = useState("30");
  const [trialNote, setTrialNote]         = useState("");
  const [trialError, setTrialError]       = useState(null);
  const [savingTrial, setSavingTrial]     = useState(false);

  // Ações inline com loading por usuário
  const [busy, setBusy] = useState({}); // userId → true

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [r, reg] = await Promise.all([adminListUsers(), adminGetRegistration()]);
      setUsers(r.users || []);
      setRegBlocked(!!reg.blocked);
    } catch (err) {
      setError(errText(err, "Não foi possível concluir a ação. Tente novamente."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Polling de fundo, sem o spinner de tela cheia — pra ver cadastros/mudanças
  // feitas por outro admin sem precisar de F5. Pausa com a aba oculta.
  useEffect(() => {
    let cancelled = false;
    let timer = null;
    async function tick() {
      if (!cancelled && !document.hidden) {
        try {
          const [r, reg] = await Promise.all([adminListUsers(), adminGetRegistration()]);
          if (!cancelled) { setUsers(r.users || []); setRegBlocked(!!reg.blocked); }
        } catch { /* mantém a última lista conhecida */ }
      }
      if (!cancelled) timer = setTimeout(tick, USERS_POLL_MS);
    }
    timer = setTimeout(tick, USERS_POLL_MS);
    const onVisibility = () => { if (!document.hidden) { clearTimeout(timer); tick(); } };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const carregarDetalhe = useCallback(async (userId) => {
    setDetalheBusy(b => ({ ...b, [userId]: true }));
    setDetalheErro(e => ({ ...e, [userId]: null }));
    try {
      const d = await adminUserDetail(userId);
      setDetalhe(m => ({ ...m, [userId]: d }));
    } catch (err) {
      setDetalheErro(e => ({ ...e, [userId]: errText(err, "Não foi possível carregar a ficha deste usuário.") }));
    } finally {
      setDetalheBusy(b => ({ ...b, [userId]: false }));
    }
  }, []);

  function toggleAberto(userId) {
    if (aberto === userId) { setAberto(null); return; }
    setAberto(userId);
    if (!detalhe[userId]) carregarDetalhe(userId);
  }

  async function toggleRegistration() {
    const next = !regBlocked;
    setRegBusy(true);
    setError(null);
    try {
      const r = await adminSetRegistration(next);
      setRegBlocked(!!r.blocked);
    } catch (err) {
      setError(errText(err, "Não foi possível concluir a ação. Tente novamente."));
    } finally {
      setRegBusy(false);
    }
  }

  async function withBusy(userId, fn) {
    setBusy(b => ({ ...b, [userId]: true }));
    try {
      await fn();
      // A ficha em cache ficou velha (suspender/verificar/trocar cargo mudam o
      // que ela mostra) — descarta e recarrega se a linha ainda estiver aberta.
      setDetalhe(m => { const rest = { ...m }; delete rest[userId]; return rest; });
      await refresh();
      if (aberto === userId) await carregarDetalhe(userId);
    }
    catch (err) { setError(errText(err, "Não foi possível concluir a ação. Tente novamente.")); }
    finally { setBusy(b => ({ ...b, [userId]: false })); }
  }

  async function handleDelete() {
    if (!confirmDelete) return;
    const id = confirmDelete.id;
    await withBusy(id, () => adminDeleteUser(id));
    if (aberto === id) setAberto(null);
    setConfirmDelete(null);
  }

  function abrirTrial(u) {
    setTrialUser(u);
    setTrialPlan(u.subscription?.manualTrialPlanId || "pro");
    setTrialDays("30");
    setTrialNote("");
    setTrialError(null);
  }

  async function handleGrantTrial() {
    setTrialError(null);
    const dias = Number(trialDays);
    if (!Number.isInteger(dias) || dias < 1 || dias > 365) {
      setTrialError("Informe uma duração de 1 a 365 dias.");
      return;
    }
    const id = trialUser.id;
    setSavingTrial(true);
    try {
      await adminGrantManualTrial(id, { planId: trialPlan, days: dias, note: trialNote.trim() || undefined });
      setTrialUser(null);
      // Reaproveita o refresh de sempre (lista + ficha aberta) sem outra chamada.
      await withBusy(id, async () => {});
    } catch (err) {
      setTrialError(errText(err, "Não foi possível conceder o trial. Tente novamente."));
    } finally {
      setSavingTrial(false);
    }
  }

  async function handleChangePassword() {
    setPwdError(null);
    if (newPwd.length < 8) { setPwdError("Senha precisa ter ao menos 8 caracteres"); return; }
    setSavingPwd(true);
    try {
      await adminSetUserPassword(pwdUser.id, newPwd);
      setPwdUser(null);
      setNewPwd("");
    } catch (err) {
      setPwdError(errText(err, "Não foi possível concluir a ação. Tente novamente."));
    } finally {
      setSavingPwd(false);
    }
  }

  const isPagando  = u => PAGANDO.has(u.subscription?.status) && !u.subscription?.crossMode;
  const isAtrasado = u => ATRASADO.has(u.subscription?.status) && !u.subscription?.crossMode;
  const isOperando = u => (u.counts?.activeGroups || 0) > 0 && (u.counts?.connectedNumbers || 0) > 0;
  // Dois grupos disjuntos e ambos invisíveis até aqui: quem já foi embora
  // (status canceled) e quem avisou que vai (cancelAtPeriodEnd, ainda pagando).
  const isCancelado  = u => u.subscription?.status === "canceled";
  const isCancelando = u => isPagando(u) && !!u.subscription?.cancelAtPeriodEnd;
  const temCortesia  = u => !!u.subscription?.manualTrialActive;

  const filtered = users.filter(u => {
    if (filter === "paying" && !isPagando(u)) return false;
    if (filter === "unverified" && u.emailVerified) return false;
    if (filter === "suspended" && !u.suspended) return false;
    if (filter === "admin" && u.role !== "admin") return false;
    if (filter === "canceled" && !isCancelado(u)) return false;
    if (filter === "canceling" && !isCancelando(u)) return false;
    if (filter === "manual-trial" && !temCortesia(u)) return false;
    if (search) {
      const s = search.toLowerCase();
      return (u.name || "").toLowerCase().includes(s) || (u.email || "").toLowerCase().includes(s);
    }
    return true;
  });

  const unverifiedCount = users.filter(u => !u.emailVerified).length;
  const suspendedCount  = users.filter(u => u.suspended).length;
  const adminCount      = users.filter(u => u.role === "admin").length;
  const pagandoCount    = users.filter(isPagando).length;
  const atrasadoCount   = users.filter(isAtrasado).length;
  const operandoCount   = users.filter(isOperando).length;
  const canceladoCount  = users.filter(isCancelado).length;
  const cancelandoCount = users.filter(isCancelando).length;
  const cortesiaCount   = users.filter(temCortesia).length;

  // Quebra por plano entre quem está pagando — "12 pagando" sem dizer de quê é
  // a mesma ambiguidade que este trabalho veio consertar.
  const porPlano = users.filter(isPagando).reduce((acc, u) => {
    const p = u.subscription?.planId || "free";
    acc[p] = (acc[p] || 0) + 1;
    return acc;
  }, {});
  const planoResumo = Object.entries(porPlano)
    .map(([p, n]) => `${n} ${PLAN_LABEL[p] || p}`)
    .join(" · ");

  const btnStyle = (variant = "default") => ({
    padding: "4px 10px", borderRadius: 6, fontSize: 11, cursor: "pointer", fontWeight: 500,
    ...(variant === "default" && {
      border: "0.5px solid var(--color-border-secondary)",
      background: "transparent",
      color: "var(--color-text-primary)",
    }),
    ...(variant === "primary" && {
      border: `0.5px solid ${PRIMARY}`,
      background: PRIMARY_LIGHT,
      color: PRIMARY_DARK,
    }),
    ...(variant === "danger" && {
      border: "0.5px solid var(--danger-border)",
      background: "var(--danger-bg)",
      color: "var(--danger-text)",
    }),
    ...(variant === "warning" && {
      border: "0.5px solid var(--warn-border)",
      background: "var(--warn-bg)",
      color: "var(--warn-text)",
    }),
    ...(variant === "success" && {
      border: "0.5px solid var(--success-border)",
      background: "var(--success-bg)",
      color: "var(--success-text)",
    }),
  });

  const filterBtn = (value, label, count) => (
    <button
      onClick={() => setFilter(value)}
      style={{
        padding: "5px 12px", borderRadius: 7, fontSize: 12, cursor: "pointer",
        border: filter === value ? `0.5px solid ${PRIMARY}` : "0.5px solid var(--color-border-tertiary)",
        background: filter === value ? PRIMARY_LIGHT : "transparent",
        color: filter === value ? PRIMARY_DARK : "var(--color-text-secondary)",
        fontWeight: filter === value ? 600 : 400,
      }}
    >
      {label}{count > 0 ? ` (${count})` : ""}
    </button>
  );

  return (
    <div>
      {/* Cabeçalho */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16, flexWrap: "wrap", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <h2 style={{ fontSize: 18, fontWeight: 500, margin: 0 }}>Usuários</h2>
          {regBlocked && <Badge color="red">Cadastro fechado (beta)</Badge>}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {regBlocked !== null && (
            <button onClick={toggleRegistration} disabled={regBusy} style={btnStyle(regBlocked ? "warning" : "default")}>
              {regBusy ? "…" : regBlocked ? "🔒 Cadastro bloqueado — Liberar" : "🔓 Cadastro liberado — Bloquear"}
            </button>
          )}
          <button onClick={refresh} disabled={loading} style={btnStyle()}>
            {loading ? "⟳" : "⟳ Atualizar"}
          </button>
        </div>
      </div>

      {/* Resumo. Cada card carrega no title a definição exata do que conta —
          foi a falta disso que fez ninguém saber o que "ativo" media. */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginBottom: 14 }}>
        <div title="Total de contas criadas, em qualquer estado.">
          <StatCard label="Cadastrados" value={users.length} sub={`${adminCount} admin${adminCount !== 1 ? "s" : ""}`} />
        </div>
        <div title="Assinatura com status active ou trialing no Stripe. Não inclui quem está em atraso.">
          <StatCard label="Pagando" value={pagandoCount} sub={planoResumo || undefined} color={PRIMARY_DARK} />
        </div>
        <div title="Assinatura past_due ou unpaid: o pagamento falhou e a conta está na carência de 3 dias.">
          <StatCard label="Em atraso" value={atrasadoCount} color={atrasadoCount > 0 ? "var(--warn-text)" : undefined} />
        </div>
        <div title="Contas suspensas por admin, ou que ainda não confirmaram o e-mail e por isso não conseguem entrar.">
          <StatCard
            label="Bloqueados"
            value={suspendedCount + unverifiedCount}
            sub={`${suspendedCount} suspenso${suspendedCount !== 1 ? "s" : ""} · ${unverifiedCount} sem verificar`}
            color={suspendedCount > 0 ? "var(--danger-text)" : undefined}
          />
        </div>
        <div title="Usuários com pelo menos uma campanha ativa (não pausada pelo usuário nem pelo plano) E pelo menos um número de WhatsApp conectado agora. É a única métrica desta tela que responde 'está funcionando de verdade?'.">
          <StatCard label="Operando" value={operandoCount} sub={`de ${users.length}`} color={PRIMARY_DARK} />
        </div>
      </div>

      {error && <AlertBanner tone="error" message={error} onDismiss={() => setError(null)} style={{ marginBottom: 14 }} />}

      {/* Busca + Filtros */}
      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        <input
          placeholder="Buscar por nome ou email..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ flex: 1, minWidth: 200, padding: "7px 12px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-primary)", fontSize: 13, boxSizing: "border-box" }}
        />
      </div>
      <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
        {filterBtn("all",        "Todos",           0)}
        {filterBtn("paying",     "Pagando",         pagandoCount)}
        {filterBtn("canceled",   "Cancelados",      canceladoCount)}
        {filterBtn("canceling",  "Cancelamento agendado", cancelandoCount)}
        {filterBtn("manual-trial", "Cortesia",   cortesiaCount)}
        {filterBtn("unverified", "Não verificados", unverifiedCount)}
        {filterBtn("suspended",  "Suspensos",       suspendedCount)}
        {filterBtn("admin",      "Admins",          adminCount)}
      </div>

      {filtered.length === 0 ? (
        <div style={{ textAlign: "center", padding: 40, color: "var(--color-text-secondary)", fontSize: 13 }}>
          {loading ? "Carregando..." : "Nenhum usuário encontrado."}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {filtered.map(u => {
            const isMe       = u.id === currentUser?.id;
            const isAdmin    = u.role === "admin";
            const isBusy     = !!busy[u.id];
            const expandido  = aberto === u.id;
            // stopPropagation em cada ação: o card inteiro alterna a ficha, e
            // sem isso "Suspender" também abriria o painel.
            const acao = fn => e => { e.stopPropagation(); fn(); };
            return (
              <div key={u.id} style={{
                background: "var(--color-background-primary)",
                border: `0.5px solid ${u.suspended ? "#FECACA" : "var(--color-border-tertiary)"}`,
                borderRadius: 12,
                opacity: isBusy ? 0.6 : 1,
              }}>
                <div
                  role="button"
                  tabIndex={0}
                  aria-expanded={expandido}
                  aria-label={`Ficha de ${u.name || u.email}`}
                  onClick={() => toggleAberto(u.id)}
                  onKeyDown={e => {
                    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleAberto(u.id); }
                  }}
                  style={{ padding: "12px 14px", cursor: "pointer" }}
                >
                  {/* Linha principal: nome + badges */}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 8 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 5, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 11, color: "var(--color-text-secondary)", width: 10 }}>{expandido ? "▾" : "▸"}</span>
                        <span style={{ fontSize: 14, fontWeight: 500 }}>{u.name || "(sem nome)"}</span>
                        <ContaBadge user={u} />
                        <AssinaturaBadge sub={u.subscription} />
                        <CortesiaBadge sub={u.subscription} />
                        <OperacaoBadges counts={u.counts} />
                        {isAdmin && <Badge color="purple">Admin</Badge>}
                        {isMe && <Badge color="gray">Você</Badge>}
                      </div>

                      {/* Info secundária */}
                      <div style={{ fontSize: 11, color: "var(--color-text-secondary)", display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
                        <span>{u.email}</span>
                        {u.phone && <span>📱 {u.phone}</span>}
                        {u.createdAt && <span>Criado {dt(u.createdAt)}</span>}
                        {u.counts?.repasseGroups > 0 && <span>{u.counts.repasseGroups} de repasse</span>}
                        <NumerosDaLinha numbers={u.numbers} />
                        {u.suspended && u.suspendedAt && (
                          <span style={{ color: "var(--danger-text)" }}>Suspenso em {dt(u.suspendedAt)}</span>
                        )}
                      </div>

                      {/* Ações de email (só se não verificado) */}
                      {!u.emailVerified && (
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
                          <button
                            disabled={isBusy}
                            onClick={acao(() => withBusy(u.id, () => adminVerifyUserEmail(u.id)))}
                            style={btnStyle("success")}
                          >
                            ✓ Verificar email
                          </button>
                          <button
                            disabled={isBusy}
                            onClick={acao(() => withBusy(u.id, () => adminResendUserVerification(u.id)))}
                            style={btnStyle("warning")}
                          >
                            ✉ Reenviar verificação
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Ações principais */}
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "flex-start" }}>
                      <button
                        disabled={isBusy}
                        onClick={acao(() => { setPwdUser(u); setNewPwd(""); setPwdError(null); })}
                        style={btnStyle("default")}
                      >
                        Trocar senha
                      </button>

                      {!isMe && (
                        <button
                          disabled={isBusy}
                          onClick={acao(() => withBusy(u.id, () => adminSetUserRole(u.id, isAdmin ? "user" : "admin")))}
                          style={btnStyle(isAdmin ? "default" : "primary")}
                        >
                          {isAdmin ? "Rebaixar" : "Tornar admin"}
                        </button>
                      )}

                      {u.subscription?.manualTrialActive ? (
                        <button
                          disabled={isBusy}
                          onClick={acao(() => withBusy(u.id, () => adminRevokeManualTrial(u.id)))}
                          style={btnStyle("warning")}
                          title="Encerra a cortesia agora. Nada é cobrado nem apagado."
                        >
                          Desativar trial
                        </button>
                      ) : (
                        <button
                          disabled={isBusy}
                          onClick={acao(() => abrirTrial(u))}
                          style={btnStyle("primary")}
                          title="Libera um plano por N dias sem passar pelo Stripe."
                        >
                          Adicionar trial
                        </button>
                      )}

                      {!isMe && (
                        <button
                          disabled={isBusy}
                          onClick={acao(() => withBusy(u.id, () => adminSetUserSuspended(u.id, !u.suspended)))}
                          style={btnStyle(u.suspended ? "warning" : "default")}
                        >
                          {u.suspended ? "Reativar" : "Suspender"}
                        </button>
                      )}

                      {!isMe && (
                        <button
                          disabled={isBusy}
                          onClick={acao(() => setConfirmDelete(u))}
                          style={btnStyle("danger")}
                        >
                          Excluir
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                {expandido && (
                  <div style={{
                    borderTop: "0.5px solid var(--color-border-tertiary)",
                    background: "var(--color-background-secondary)",
                    padding: 12,
                    borderRadius: "0 0 12px 12px",
                  }}>
                    <PainelDetalhe
                      dados={detalhe[u.id]}
                      carregando={!!detalheBusy[u.id]}
                      erro={detalheErro[u.id]}
                      onRetry={() => carregarDetalhe(u.id)}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Modal: trocar senha */}
      {pwdUser && (
        <Modal title={`Trocar senha — ${pwdUser.name || pwdUser.email}`} onClose={() => { setPwdUser(null); setNewPwd(""); setPwdError(null); }}>
          <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 12, lineHeight: 1.5 }}>
            Define uma nova senha. O usuário precisará usá-la no próximo login.
          </div>
          <input
            type="password"
            value={newPwd}
            onChange={e => setNewPwd(e.target.value)}
            placeholder="Mínimo 8 caracteres"
            onKeyDown={e => e.key === "Enter" && handleChangePassword()}
            style={{ width: "100%", padding: "9px 12px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", fontSize: 13, boxSizing: "border-box", marginBottom: 10 }}
          />
          {pwdError && (
            <div style={{ background: "var(--danger-bg)", color: "var(--danger-text)", padding: "8px 10px", borderRadius: 8, fontSize: 12, marginBottom: 10 }}>{pwdError}</div>
          )}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={() => { setPwdUser(null); setNewPwd(""); setPwdError(null); }} disabled={savingPwd} style={btnStyle("default")}>Cancelar</button>
            <button onClick={handleChangePassword} disabled={savingPwd || newPwd.length < 8}
              style={{ padding: "8px 16px", borderRadius: 8, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500, opacity: (savingPwd || newPwd.length < 8) ? 0.5 : 1 }}>
              {savingPwd ? "Salvando..." : "Trocar senha"}
            </button>
          </div>
        </Modal>
      )}

      {/* Modal: conceder trial manual (cortesia) */}
      {trialUser && (() => {
        const dias = Number(trialDays);
        const validos = Number.isInteger(dias) && dias >= 1 && dias <= 365;
        const ate = validos ? new Date(Date.now() + dias * 86400000) : null;
        const pagando = PAGANDO.has(trialUser.subscription?.status) && !trialUser.subscription?.crossMode;
        const inputStyle = {
          width: "100%", padding: "9px 12px", borderRadius: 8,
          border: "0.5px solid var(--color-border-tertiary)",
          background: "var(--color-background-secondary)", fontSize: 13, boxSizing: "border-box",
        };
        return (
          <Modal title={`Adicionar trial — ${trialUser.name || trialUser.email}`} onClose={() => setTrialUser(null)}>
            <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 14, lineHeight: 1.5 }}>
              Libera o plano escolhido por tempo determinado, sem passar pelo Stripe e sem cobrar nada.
              Não consome o teste de R$ 1,00 da conta.
            </div>

            <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 6 }}>Plano</div>
            <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
              {TRIAL_PLANOS.map(p => (
                <button
                  key={p.id}
                  onClick={() => setTrialPlan(p.id)}
                  style={{
                    padding: "7px 14px", borderRadius: 7, fontSize: 12, cursor: "pointer",
                    border: trialPlan === p.id ? `0.5px solid ${PRIMARY}` : "0.5px solid var(--color-border-tertiary)",
                    background: trialPlan === p.id ? PRIMARY_LIGHT : "transparent",
                    color: trialPlan === p.id ? PRIMARY_DARK : "var(--color-text-secondary)",
                    fontWeight: trialPlan === p.id ? 600 : 400,
                  }}
                >
                  {p.label}
                </button>
              ))}
            </div>

            <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 6 }}>Duração</div>
            <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
              {TRIAL_DIAS.map(d => (
                <button
                  key={d}
                  onClick={() => setTrialDays(String(d))}
                  style={{
                    padding: "7px 14px", borderRadius: 7, fontSize: 12, cursor: "pointer",
                    border: trialDays === String(d) ? `0.5px solid ${PRIMARY}` : "0.5px solid var(--color-border-tertiary)",
                    background: trialDays === String(d) ? PRIMARY_LIGHT : "transparent",
                    color: trialDays === String(d) ? PRIMARY_DARK : "var(--color-text-secondary)",
                    fontWeight: trialDays === String(d) ? 600 : 400,
                  }}
                >
                  {d} dias
                </button>
              ))}
            </div>
            <input
              type="number"
              min={1}
              max={365}
              value={trialDays}
              onChange={e => setTrialDays(e.target.value)}
              aria-label="Dias de trial"
              style={{ ...inputStyle, marginBottom: 6 }}
            />
            <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 14 }}>
              {ate ? <>Vale até <strong style={{ color: "var(--color-text-primary)" }}>{ate.toLocaleDateString("pt-BR")}</strong>.</> : "Informe de 1 a 365 dias."}
            </div>

            <input
              value={trialNote}
              onChange={e => setTrialNote(e.target.value)}
              placeholder="Observação (opcional) — ex: beta tester, cortesia de suporte"
              aria-label="Observação"
              style={{ ...inputStyle, marginBottom: 12 }}
            />

            {pagando && (
              <AlertBanner
                tone="warn"
                message={`Esta conta tem assinatura paga (${PLAN_LABEL[trialUser.subscription?.planId] || trialUser.subscription?.planId}), e ela continua valendo. A cortesia fica guardada e só assume se a assinatura cair antes do fim do prazo.`}
                style={{ marginBottom: 12 }}
              />
            )}
            {trialError && (
              <div style={{ background: "var(--danger-bg)", color: "var(--danger-text)", padding: "8px 10px", borderRadius: 8, fontSize: 12, marginBottom: 10 }}>{trialError}</div>
            )}

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => setTrialUser(null)} disabled={savingTrial} style={btnStyle("default")}>Cancelar</button>
              <button
                onClick={handleGrantTrial}
                disabled={savingTrial || !validos}
                style={{ padding: "8px 16px", borderRadius: 8, background: PRIMARY, color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500, opacity: (savingTrial || !validos) ? 0.5 : 1 }}
              >
                {savingTrial ? "Liberando..." : "Liberar trial"}
              </button>
            </div>
          </Modal>
        );
      })()}

      {/* Modal: confirmar exclusão */}
      {confirmDelete && (
        <Modal title="Excluir usuário?" onClose={() => setConfirmDelete(null)} danger>
          <p style={{ fontSize: 13, marginBottom: 16, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
            <strong style={{ color: "var(--color-text-primary)" }}>{confirmDelete.name || confirmDelete.email}</strong> será excluído permanentemente junto com suas campanhas, números do WhatsApp e histórico. Esta ação não pode ser desfeita.
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={() => setConfirmDelete(null)} style={btnStyle("default")}>Cancelar</button>
            <button onClick={handleDelete} style={{ padding: "8px 16px", borderRadius: 8, background: "#E24B4A", color: "#fff", border: "none", fontSize: 13, cursor: "pointer", fontWeight: 500 }}>
              Excluir permanentemente
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
