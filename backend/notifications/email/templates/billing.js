// Avisos de cobrança — as VARIÁVEIS de cada e-mail.
//
// O texto mora em catalog.js (e pode ser reescrito pelo Admin). Aqui fica só a
// tradução `payload → variáveis`. Onde o texto antigo tinha dois caminhos ("até
// 04 de agosto" x "em breve"), a escolha virou uma frase pronta numa variável —
// assim quem edita escreve uma frase só e o código decide o miolo.
//
// Contexto que explica o tom destes textos: quando o cartão falha, o cliente não
// perde o acesso na hora — `billing/limits.js` dá 3 dias de carência. Esses 3
// dias só valem alguma coisa se alguém avisar a pessoa, e é isso que estes
// e-mails fazem. Todos apontam pra tela de Assinatura, onde já existe o botão do
// Customer Portal (a URL do portal expira em minutos, então não vai em e-mail).

const { loginUrl } = require("../../../config/publicUrl");
const render = require("../render");

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

// Valores do Stripe vêm em centavos. Moeda vazia = BRL, que é o único caso hoje;
// se um dia houver cobrança em outra moeda o código do Stripe já vem certo.
function moeda(cents, currency) {
  const n = Number(cents);
  if (!Number.isFinite(n)) return "";
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: String(currency || "BRL").toUpperCase(),
  }).format(n / 100);
}

// Confirmação da primeira cobrança. A frase `cobranca` é o miolo: no teste de
// R$ 1,00 o que a pessoa precisa saber é quando e quanto vai ser cobrado depois
// — é a informação que evita a surpresa (e o chargeback) 15 dias à frente.
function subscription_started(p) {
  const fim = data(p.periodEnd);
  const mensal = moeda(p.planAmount, p.currency);
  let cobranca;
  if (p.trial) {
    cobranca = `Seu teste vai até *${fim || "o fim do período"}*`
      + (mensal
        ? `. A partir daí a assinatura passa a *${mensal} por mês*, cobrada automaticamente no mesmo cartão.`
        : ", e a partir daí a assinatura é cobrada automaticamente no mesmo cartão.");
  } else {
    cobranca = fim
      ? `A próxima cobrança é em *${fim}*, automaticamente no mesmo cartão.`
      : "As próximas cobranças são automáticas, no mesmo cartão.";
  }
  return {
    nome: nome(p),
    plano: p.planLabel || "",
    valor: moeda(p.amount, p.currency),
    cobranca,
  };
}

// Recibo das cobranças recorrentes. O link da fatura é o hosted_invoice_url do
// Stripe — é ele que serve de comprovante, e é público por design (URL longa e
// não indexada), então pode ir em e-mail.
function payment_receipt(p) {
  const proxima = data(p.periodEnd);
  return {
    nome: nome(p),
    plano: p.planLabel || "",
    valor: moeda(p.amount, p.currency),
    data_pagamento: data(p.paidAt) || data(new Date()),
    proxima_cobranca: proxima ? `em *${proxima}*` : "",
    link_fatura: p.invoiceUrl ? render.linkVar(p.invoiceUrl) : "",
  };
}

function refund_issued(p) {
  return {
    nome: nome(p),
    valor: moeda(p.amount, p.currency),
    tipo: p.partial ? "parcial" : "integral",
    data_reembolso: data(p.refundedAt) || data(new Date()),
  };
}

function payment_failed(p) {
  const limite = data(p.deadline);
  return {
    nome: nome(p),
    prazo: limite ? `até *${limite}*` : "por mais alguns dias",
  };
}

function payment_recovered(p) {
  return { nome: nome(p) };
}

function plan_changed(p) {
  const pausados = [];
  const total = (p.pausedGroups || 0) + (p.pausedNumbers || 0);
  if (p.pausedGroups > 0) pausados.push(plural(p.pausedGroups, "campanha", "campanhas"));
  if (p.pausedNumbers > 0) pausados.push(plural(p.pausedNumbers, "número", "números"));

  const de = p.fromPlanLabel || "";
  const para = p.toPlanLabel || "";
  return {
    nome: nome(p),
    plano_novo: para,
    plano_anterior: de,
    mudanca: de ? `mudou de *${de}* para *${para}*` : `agora é *${para}*`,
    itens_pausados: pausados.join(" e "),
    verbo_pausado: total > 1 ? "foram pausados" : "foi pausado",
  };
}

function cancel_scheduled(p) {
  const fim = data(p.periodEnd);
  return {
    nome: nome(p),
    data_fim: fim ? `*${fim}*` : "o fim do período atual",
  };
}

function cancel_reverted(p) {
  const fim = data(p.periodEnd);
  return {
    nome: nome(p),
    renovacao: fim ? `em *${fim}*` : "normalmente",
  };
}

function subscription_canceled(p) {
  return { nome: nome(p) };
}

function trial_ending(p) {
  const fim = data(p.periodEnd);
  const dias = Number(p.daysLeft);
  const temDias = Number.isFinite(dias) && dias > 0;
  return {
    nome: nome(p),
    dias: temDias ? String(dias) : "",
    data_fim: fim,
    prazo_teste: temDias
      ? `em *${plural(dias, "dia", "dias")}*${fim ? ` (${fim})` : ""}`
      : (fim ? `em *${fim}*` : "em breve"),
  };
}

function grace_ending(p) {
  const limite = data(p.deadline);
  return {
    nome: nome(p),
    prazo_pausa: limite ? `em *${limite}*` : "nas próximas horas",
  };
}

function access_paused(p) {
  return { nome: nome(p), endereco_sistema: loginUrl };
}

module.exports = {
  subscription_started,
  payment_receipt,
  refund_issued,
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
