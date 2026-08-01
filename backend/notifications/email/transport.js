// Transporte SMTP — camada única que fala com o nodemailer.
//
// Todo e-mail do sistema (os de token em auth/mailer.js e os transacionais em
// notifications/email/) passa por aqui, então SMTP_HOST/USER/PASS e MAIL_FROM
// ficam num lugar só.
//
// Variáveis de ambiente:
//   SMTP_HOST     — ex: mail.seudominio.com  (Hostgator: mail.seudominio.com)
//   SMTP_PORT     — 587 (STARTTLS, default) ou 465 (SSL)
//   SMTP_SECURE   — "true" para porta 465, omitir/false para 587
//   SMTP_USER     — email de envio: noreply@seudominio.com
//   SMTP_PASS     — senha do email
//   MAIL_FROM     — remetente exibido: "Nimbus <noreply@seudominio.com>"

const nodemailer = require("nodemailer");

let _transporter = null;

// Função, e não constante de load: o .env é carregado por config/loadEnv no
// require do db, e a ordem de require entre módulos não é garantida. Avaliar
// no load fazia o transporte se declarar "sem SMTP" pra sempre.
function smtpConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

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

// Envia de fato. Diferente do fallback antigo, devolve `delivered` pra quem
// chama saber se o e-mail existiu de verdade — o log de e-mails registra a
// diferença entre "enviado" e "pulado por falta de SMTP".
// Erro de SMTP é propagado: quem chama decide se engole (fire-and-forget) ou não.
async function sendMail({ to, subject, html, text }) {
  // Trava de teste: a suíte carrega o .env do backend, que tem SMTP real. Sem
  // esta guarda, rodar os testes dispara e-mails de verdade e queima a cota
  // horária do provedor. Os mocks cobrem o caminho normal; esta é a rede de
  // segurança pra quem chamar o transporte direto.
  if (process.env.NODE_ENV === "test") {
    return { ok: true, delivered: false, reason: "test_env" };
  }
  if (!smtpConfigured()) {
    // Sem link no log: estes e-mails não carregam token, mas manter a mesma
    // regra evita que um template futuro vaze um por descuido.
    console.warn(`[mailer] SMTP não configurado — "${subject}" para ${to} NÃO foi enviado.`);
    return { ok: true, delivered: false, reason: "no_smtp" };
  }
  await getTransporter().sendMail({ from: MAIL_FROM(), to, subject, html, text });
  return { ok: true, delivered: true };
}

module.exports = { smtpConfigured, getTransporter, MAIL_FROM, logLinkFallback, sendMail };
