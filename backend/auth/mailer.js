// Mailer — e-mails de TOKEN (verificação, reset, boas-vindas, troca de email).
// Os avisos transacionais (cobrança, segurança) ficam em notifications/email/.
//
// O transporte SMTP mora em notifications/email/transport.js — as variáveis de
// ambiente (SMTP_HOST/PORT/SECURE/USER/PASS, MAIL_FROM) estão documentadas lá.
// APP_PUBLIC_URL / PUBLIC_BASE_URL define a base dos links daqui.

const { appPublicUrl: APP_PUBLIC_URL } = require("../config/publicUrl");
const transport = require("../notifications/email/transport");

function verifyUrl(token) {
  return `${APP_PUBLIC_URL}/?verify=${encodeURIComponent(token)}`;
}

function resetUrl(token) {
  return `${APP_PUBLIC_URL}/?reset=${encodeURIComponent(token)}`;
}

function emailChangeUrl(token) {
  return `${APP_PUBLIC_URL}/?trocaemail=${encodeURIComponent(token)}`;
}

async function sendVerificationEmail({ to, name, token }) {
  const url = verifyUrl(token);

  if (!transport.smtpConfigured()) {
    transport.logLinkFallback("VERIFICAÇÃO DE EMAIL", to, name, url, "24h");
    return { ok: true, url };
  }

  await transport.sendMail({
    to,
    subject: "Confirme seu email — Nimbus",
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 16px;color:#1a1a1a">
        <h2 style="margin:0 0 8px">Bem-vindo ao Nimbus, ${name || ""}!</h2>
        <p style="margin:0 0 24px;color:#555">Clique no botão abaixo para confirmar seu email e ativar sua conta.</p>
        <a href="${url}" style="display:inline-block;padding:12px 28px;background:#2563EB;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:15px">
          Confirmar email
        </a>
        <p style="margin:24px 0 0;font-size:12px;color:#888">
          Link válido por 24 horas. Se não criou uma conta, ignore este email.<br>
          Ou copie: <a href="${url}" style="color:#2563EB">${url}</a>
        </p>
      </div>`,
    text: `Confirme seu email no Nimbus:\n${url}\n\nLink válido por 24 horas.`,
  });

  return { ok: true, url };
}

async function sendPasswordResetEmail({ to, name, token }) {
  const url = resetUrl(token);

  if (!transport.smtpConfigured()) {
    transport.logLinkFallback("RESET DE SENHA", to, name, url, "1h");
    return { ok: true, url };
  }

  await transport.sendMail({
    to,
    subject: "Redefinir senha — Nimbus",
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 16px;color:#1a1a1a">
        <h2 style="margin:0 0 8px">Redefinir senha</h2>
        <p style="margin:0 0 24px;color:#555">Recebemos uma solicitação para redefinir a senha de <strong>${to}</strong>.</p>
        <a href="${url}" style="display:inline-block;padding:12px 28px;background:#2563EB;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:15px">
          Redefinir senha
        </a>
        <p style="margin:24px 0 0;font-size:12px;color:#888">
          Link válido por 1 hora. Se não solicitou, ignore este email.<br>
          Ou copie: <a href="${url}" style="color:#2563EB">${url}</a>
        </p>
      </div>`,
    text: `Redefina sua senha no Nimbus:\n${url}\n\nLink válido por 1 hora.`,
  });

  return { ok: true, url };
}

// Boas-vindas de quem assinou pela landing: a conta foi criada pelo pagamento,
// então a pessoa ainda não tem senha. O link é o mesmo fluxo de reset (a tela
// já existe), só com texto de primeiro acesso — e vale 24h.
// Este e-mail é o plano B: no caminho feliz a pessoa já volta logada do Stripe
// e define a senha ali mesmo.
async function sendWelcomeSetPasswordEmail({ to, name, token, planLabel }) {
  const url = resetUrl(token);
  const plano = planLabel ? ` do plano <strong>${planLabel}</strong>` : "";

  if (!transport.smtpConfigured()) {
    transport.logLinkFallback("BOAS-VINDAS / DEFINIR SENHA", to, name, url, "24h");
    return { ok: true, url };
  }

  await transport.sendMail({
    to,
    subject: "Sua assinatura está ativa — crie sua senha | Nimbus",
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 16px;color:#1a1a1a">
        <h2 style="margin:0 0 8px">Pagamento confirmado, ${name || ""}!</h2>
        <p style="margin:0 0 24px;color:#555">
          Sua assinatura${plano} já está ativa. Criamos sua conta com este e-mail —
          falta só definir uma senha para entrar.
        </p>
        <a href="${url}" style="display:inline-block;padding:12px 28px;background:#2563EB;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:15px">
          Criar minha senha
        </a>
        <p style="margin:24px 0 0;font-size:12px;color:#888">
          Link válido por 24 horas — depois é só usar "Esqueci minha senha".<br>
          Ou copie: <a href="${url}" style="color:#2563EB">${url}</a>
        </p>
      </div>`,
    text: `Pagamento confirmado! Crie sua senha no Nimbus:\n${url}\n\nLink válido por 24 horas.`,
  });

  return { ok: true, url };
}

// Confirmação de troca de email. Vai SEMPRE para o endereço novo: é ele que
// precisa ser provado, e é o clique aqui que efetiva a troca. Se a pessoa
// digitou errado, este email cai no vazio e a conta continua no email antigo.
// O endereço ANTIGO recebe um aviso separado (notifications/email, kind
// "email_change_requested") — ele não confirma nada, só denuncia se não foi ela.
async function sendEmailChangeEmail({ to, name, token, currentEmail }) {
  const url = emailChangeUrl(token);

  if (!transport.smtpConfigured()) {
    transport.logLinkFallback("TROCA DE EMAIL", to, name, url, "1h");
    return { ok: true, url };
  }

  await transport.sendMail({
    to,
    subject: "Confirme seu novo email — Nimbus",
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 16px;color:#1a1a1a">
        <h2 style="margin:0 0 8px">Confirme seu novo email</h2>
        <p style="margin:0 0 24px;color:#555">
          A conta do Nimbus${currentEmail ? ` de <strong>${currentEmail}</strong>` : ""} pediu para
          passar a usar <strong>${to}</strong> para entrar. Confirme abaixo para valer.
        </p>
        <a href="${url}" style="display:inline-block;padding:12px 28px;background:#2563EB;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:15px">
          Confirmar novo email
        </a>
        <p style="margin:24px 0 0;font-size:12px;color:#888">
          Link válido por 1 hora. Se não foi você, ignore este email — nada muda sem este clique.<br>
          Ou copie: <a href="${url}" style="color:#2563EB">${url}</a>
        </p>
      </div>`,
    text: `Confirme seu novo email no Nimbus:\n${url}\n\nLink válido por 1 hora. Se não foi você, ignore.`,
  });

  return { ok: true, url };
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
