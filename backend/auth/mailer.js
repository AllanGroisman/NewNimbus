// Mailer — envia emails transacionais via SMTP (nodemailer).
// Se SMTP_HOST não estiver configurado, cai em modo console (dev/teste).
//
// Variáveis de ambiente:
//   SMTP_HOST     — ex: mail.seudominio.com  (Hostgator: mail.seudominio.com)
//   SMTP_PORT     — 587 (STARTTLS, default) ou 465 (SSL)
//   SMTP_SECURE   — "true" para porta 465, omitir/false para 587
//   SMTP_USER     — email de envio: noreply@seudominio.com
//   SMTP_PASS     — senha do email
//   MAIL_FROM     — remetente exibido: "Nimbus <noreply@seudominio.com>"
//   APP_PUBLIC_URL — base dos links nos emails

const nodemailer = require("nodemailer");

const { appPublicUrl: APP_PUBLIC_URL } = require("../config/publicUrl");
const SMTP_CONFIGURED = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);

let _transporter = null;
function getTransporter() {
  if (_transporter) return _transporter;
  _transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || "587", 10),
    secure: process.env.SMTP_SECURE === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  return _transporter;
}

function verifyUrl(token) {
  return `${APP_PUBLIC_URL}/?verify=${encodeURIComponent(token)}`;
}

function resetUrl(token) {
  return `${APP_PUBLIC_URL}/?reset=${encodeURIComponent(token)}`;
}

const MAIL_FROM = () => process.env.MAIL_FROM || `"Nimbus" <${process.env.SMTP_USER || "noreply@nimbus.app"}>`;

// Fallback de quando não há SMTP: em dev imprime o link pra dar pra testar.
// Em produção o link NÃO vai pro log — ele contém o token de reset, que dá
// posse da conta, e os logs do PM2 ficam em disco legíveis por muito tempo.
function logLinkFallback(assunto, to, name, url, validade) {
  if (process.env.NODE_ENV === "production") {
    console.warn(`[mailer] SMTP não configurado — ${assunto} para ${to} NÃO foi enviado. Configure SMTP_* no .env.`);
    return;
  }
  console.log("\n────────────────────────────────────────────────────────────────");
  console.log(`[mailer] ${assunto} → ${to} (${name || "—"})`);
  console.log(`         Link: ${url}`);
  console.log(`         (válido por ${validade})`);
  console.log("────────────────────────────────────────────────────────────────\n");
}

async function sendVerificationEmail({ to, name, token }) {
  const url = verifyUrl(token);

  if (!SMTP_CONFIGURED) {
    logLinkFallback("VERIFICAÇÃO DE EMAIL", to, name, url, "24h");
    return { ok: true, url };
  }

  await getTransporter().sendMail({
    from:    MAIL_FROM(),
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

  if (!SMTP_CONFIGURED) {
    logLinkFallback("RESET DE SENHA", to, name, url, "1h");
    return { ok: true, url };
  }

  await getTransporter().sendMail({
    from:    MAIL_FROM(),
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

module.exports = {
  sendVerificationEmail,
  sendPasswordResetEmail,
  verifyUrl,
  resetUrl,
};
