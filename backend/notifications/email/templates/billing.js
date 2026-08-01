// Avisos de cobrança.
//
// Contexto que explica o tom destes textos: quando o cartão falha, o cliente
// não perde o acesso na hora — `billing/limits.js` dá 3 dias de carência. Esses
// 3 dias só valem alguma coisa se alguém avisar a pessoa, e é isso que estes
// e-mails fazem. Todos apontam pra tela de Assinatura, onde já existe o botão
// do Customer Portal (a URL do portal expira em minutos, então não vai em e-mail).

const { esc, render } = require("../layout");
const { billingUrl, loginUrl } = require("../../../config/publicUrl");

const VER_ASSINATURA = { label: "Ver minha assinatura", url: billingUrl };
const ATUALIZAR_CARTAO = { label: "Atualizar forma de pagamento", url: billingUrl };

function nome(p) {
  return p?.name ? String(p.name).trim().split(/\s+/)[0] : "";
}

// Datas em e-mail vão sempre por extenso e no fuso de São Paulo — "04/08" é
// ambíguo pra quem lê no celular com locale em inglês.
function data(d) {
  if (!d) return "";
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return "";
  return dt.toLocaleDateString("pt-BR", {
    day: "2-digit", month: "long", year: "numeric", timeZone: "America/Sao_Paulo",
  });
}

function plural(n, um, muitos) {
  return `${n} ${n === 1 ? um : muitos}`;
}

function payment_failed(p) {
  const limite = data(p.deadline);
  return render({
    subject: "Não conseguimos cobrar sua assinatura do Nimbus",
    title: "Falha no pagamento",
    greeting: nome(p),
    tone: "warn",
    paragraphs: [
      "A cobrança da sua assinatura não foi aprovada pelo banco. Pode ser cartão vencido, limite ou uma recusa pontual.",
      limite
        ? `Suas campanhas continuam rodando normalmente até <strong>${esc(limite)}</strong>. Se o pagamento não for regularizado até lá, o acesso é pausado — nada é apagado, tudo volta quando o pagamento entrar.`
        : "Regularize o pagamento para não perder o acesso. Nada é apagado: tudo volta assim que o pagamento entrar.",
    ],
    cta: ATUALIZAR_CARTAO,
    footnote: "O Stripe ainda vai tentar cobrar de novo automaticamente. Se você já atualizou o cartão, pode ignorar este aviso.",
  });
}

function payment_recovered(p) {
  return render({
    subject: "Pagamento confirmado — sua assinatura do Nimbus está em dia",
    title: "Pagamento em dia",
    greeting: nome(p),
    paragraphs: [
      "Recebemos seu pagamento e sua assinatura voltou ao normal. Nenhuma ação é necessária.",
    ],
    cta: VER_ASSINATURA,
  });
}

function plan_changed(p) {
  const pausados = [];
  const total = (p.pausedGroups || 0) + (p.pausedNumbers || 0);
  if (p.pausedGroups > 0) pausados.push(plural(p.pausedGroups, "campanha", "campanhas"));
  if (p.pausedNumbers > 0) pausados.push(plural(p.pausedNumbers, "número", "números"));
  const verbo = total > 1 ? "foram pausados" : "foi pausado";

  return render({
    subject: `Seu plano do Nimbus agora é ${p.toPlanLabel || ""}`.trim(),
    title: "Plano alterado",
    greeting: nome(p),
    paragraphs: [
      p.fromPlanLabel
        ? `Seu plano mudou de <strong>${esc(p.fromPlanLabel)}</strong> para <strong>${esc(p.toPlanLabel)}</strong>.`
        : `Seu plano agora é <strong>${esc(p.toPlanLabel)}</strong>.`,
      pausados.length
        ? `Como o plano novo tem limites menores, ${esc(pausados.join(" e "))} ${verbo} automaticamente. Nada foi apagado — você escolhe o que fica ativo na tela de Assinatura.`
        : "",
    ],
    cta: VER_ASSINATURA,
  });
}

function cancel_scheduled(p) {
  const fim = data(p.periodEnd);
  return render({
    subject: "Sua assinatura do Nimbus foi cancelada",
    title: "Cancelamento agendado",
    greeting: nome(p),
    tone: "warn",
    paragraphs: [
      fim
        ? `Sua assinatura não será renovada. Você continua com acesso completo até <strong>${esc(fim)}</strong>.`
        : "Sua assinatura não será renovada ao fim do período atual.",
      "Mudou de ideia? Dá pra reativar a qualquer momento antes dessa data, sem perder nada do que já está configurado.",
    ],
    cta: { label: "Reativar assinatura", url: billingUrl },
  });
}

function cancel_reverted(p) {
  const fim = data(p.periodEnd);
  return render({
    subject: "Sua assinatura do Nimbus foi reativada",
    title: "Assinatura reativada",
    greeting: nome(p),
    paragraphs: [
      fim
        ? `O cancelamento foi desfeito e sua assinatura volta a renovar em <strong>${esc(fim)}</strong>.`
        : "O cancelamento foi desfeito e sua assinatura volta a renovar normalmente.",
    ],
    cta: VER_ASSINATURA,
  });
}

function subscription_canceled(p) {
  return render({
    subject: "Sua assinatura do Nimbus foi encerrada",
    title: "Assinatura encerrada",
    greeting: nome(p),
    tone: "warn",
    paragraphs: [
      "Sua assinatura chegou ao fim e suas campanhas e números foram pausados.",
      "Nada foi apagado: suas campanhas, grupos e configurações continuam guardados e voltam exatamente como estavam quando você assinar de novo.",
    ],
    cta: { label: "Assinar novamente", url: billingUrl },
  });
}

function trial_ending(p) {
  const fim = data(p.periodEnd);
  const dias = Number(p.daysLeft);
  return render({
    subject: "Seu período de teste do Nimbus está acabando",
    title: "Teste acabando",
    greeting: nome(p),
    paragraphs: [
      Number.isFinite(dias) && dias > 0
        ? `Seu período de teste termina em <strong>${esc(plural(dias, "dia", "dias"))}</strong>${fim ? ` (${esc(fim)})` : ""}.`
        : `Seu período de teste termina${fim ? ` em <strong>${esc(fim)}</strong>` : " em breve"}.`,
      "Depois disso a cobrança do plano começa automaticamente, e é só continuar usando — não precisa fazer nada.",
      "Se preferir não continuar, dá pra cancelar antes na tela de Assinatura.",
    ],
    cta: VER_ASSINATURA,
  });
}

function grace_ending(p) {
  const limite = data(p.deadline);
  return render({
    subject: "Último aviso: seu acesso ao Nimbus será pausado",
    title: "Seu acesso será pausado",
    greeting: nome(p),
    tone: "warn",
    paragraphs: [
      limite
        ? `O pagamento da sua assinatura continua pendente. Suas campanhas serão pausadas em <strong>${esc(limite)}</strong>.`
        : "O pagamento da sua assinatura continua pendente e suas campanhas serão pausadas nas próximas horas.",
      "Atualize a forma de pagamento para não ter interrupção. Nada é apagado — só deixa de enviar até o pagamento entrar.",
    ],
    cta: ATUALIZAR_CARTAO,
  });
}

function access_paused(p) {
  return render({
    subject: "Seu acesso ao Nimbus foi pausado por falta de pagamento",
    title: "Acesso pausado",
    greeting: nome(p),
    tone: "warn",
    paragraphs: [
      "Como o pagamento não foi regularizado, suas campanhas e números foram pausados e pararam de enviar.",
      "Suas configurações continuam intactas: assim que o pagamento entrar, é só reativar o que estava rodando.",
    ],
    cta: ATUALIZAR_CARTAO,
    footnote: `Precisa de ajuda? Entre em ${esc(loginUrl)} e fale com o suporte.`,
  });
}

module.exports = {
  payment_failed,
  payment_recovered,
  plan_changed,
  cancel_scheduled,
  cancel_reverted,
  subscription_canceled,
  trial_ending,
  grace_ending,
  access_paused,
};
