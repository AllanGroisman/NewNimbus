// Mailer — e-mails de TOKEN (verificação, reset, boas-vindas, troca de email).
// Os avisos transacionais (cobrança, segurança) saem por notifications/email/.
//
// O texto destes 4 e-mails vive no catálogo (notifications/email/catalog.js,
// grupo "token") e é editável pelo Admin, como todos os outros. O que continua
// aqui: gerar o link com token e escolher para quem vai. O link NUNCA é
// editável — só o rótulo do botão.
//
// Estes 4 não podem ser desligados: sem "confirme seu e-mail" o cadastro não
// fecha, e sem "redefinir senha" quem esqueceu a senha fica trancado do lado de
// fora (render.isEnabled trata disso).
//
// O transporte SMTP mora em notifications/email/transport.js — as variáveis de
// ambiente (SMTP_HOST/PORT/SECURE/USER/PASS, MAIL_FROM) estão documentadas lá.
// PUBLIC_BASE_URL / APP_PUBLIC_URL define a base dos links daqui.

const { appPublicUrl: APP_PUBLIC_URL } = require("../config/publicUrl");
const transport = require("../notifications/email/transport");
const render = require("../notifications/email/render");
const emailLog = require("../notifications/email/log");

function verifyUrl(token) {
  return `${APP_PUBLIC_URL}/?verify=${encodeURIComponent(token)}`;
}

function resetUrl(token) {
  return `${APP_PUBLIC_URL}/?reset=${encodeURIComponent(token)}`;
}

function emailChangeUrl(token) {
  return `${APP_PUBLIC_URL}/?trocaemail=${encodeURIComponent(token)}`;
}

// Caminho comum dos quatro: sem SMTP configurado o link vai pro console (dev) em
// vez de sumir; com SMTP, renderiza pelo catálogo e envia.
async function enviar({ key, to, url, vars, fallbackLabel, validade }) {
  if (!transport.smtpConfigured()) {
    transport.logLinkFallback(fallbackLabel, to, vars.nome, url, validade);
    return { ok: true, url };
  }

  const { subject, html, text } = render.renderEmail(
    key,
    { ...vars, link: render.linkVar(url) },
    { ctaUrl: url },
  );
  await transport.sendMail({ to, subject, html, text });

  return { ok: true, url };
}

async function sendVerificationEmail({ to, name, token }) {
  return enviar({
    key: "verify_email",
    to,
    url: verifyUrl(token),
    vars: { nome: name || "", email: to },
    fallbackLabel: "VERIFICAÇÃO DE EMAIL",
    validade: "24h",
  });
}

async function sendPasswordResetEmail({ to, name, token }) {
  return enviar({
    key: "password_reset_link",
    to,
    url: resetUrl(token),
    vars: { nome: name || "", email: to },
    fallbackLabel: "RESET DE SENHA",
    validade: "1h",
  });
}

// Boas-vindas de quem assinou pela landing: a conta foi criada pelo pagamento,
// então a pessoa ainda não tem senha. O link é o mesmo fluxo de reset (a tela já
// existe), só com texto de primeiro acesso — e vale 24h.
// Este e-mail é o plano B: no caminho feliz a pessoa já volta logada do Stripe e
// define a senha ali mesmo.
//
// É o único dos quatro que deixa rastro em `email_log`: billing/notify.js precisa
// saber se ele saiu pra não mandar o "assinatura confirmada" logo atrás (os dois
// dizem "pagamento confirmado" — quem assina pela landing receberia dois e-mails
// quase iguais). O log falhar não pode impedir o envio: sem senha a pessoa não
// entra no sistema.
async function sendWelcomeSetPasswordEmail({ to, name, token, planLabel, userId }) {
  const res = await enviar({
    key: "welcome_set_password",
    to,
    url: resetUrl(token),
    vars: { nome: name || "", plano: planLabel ? `do plano *${planLabel}*` : "" },
    fallbackLabel: "BOAS-VINDAS / DEFINIR SENHA",
    validade: "24h",
  });

  if (userId) {
    try {
      const row = await emailLog.claim({
        kind: "welcome_set_password",
        userId,
        to,
        dedupeKey: `welcome_set_password:${userId}:${token}`,
      });
      if (row) await emailLog.finish(row.id, "sent");
    } catch { /* histórico é secundário — o e-mail já foi */ }
  }

  return res;
}

// Confirmação de troca de email. Vai SEMPRE para o endereço novo: é ele que
// precisa ser provado, e é o clique aqui que efetiva a troca. Se a pessoa digitou
// errado, este email cai no vazio e a conta continua no email antigo.
// O endereço ANTIGO recebe um aviso separado (notifications/email, kind
// "email_change_requested") — ele não confirma nada, só denuncia se não foi ela.
async function sendEmailChangeEmail({ to, name, token, currentEmail }) {
  return enviar({
    key: "email_change_confirm",
    to,
    url: emailChangeUrl(token),
    vars: {
      nome: name || "",
      email_novo: to,
      email_atual: currentEmail ? ` de *${currentEmail}*` : "",
    },
    fallbackLabel: "TROCA DE EMAIL",
    validade: "1h",
  });
}

module.exports = {
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendWelcomeSetPasswordEmail,
  sendEmailChangeEmail,
  verifyUrl,
  resetUrl,
  emailChangeUrl,
};
