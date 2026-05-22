// Mailer stub — por enquanto só loga o link no console.
// Pra produção, plugar nodemailer/Resend/SendGrid aqui mantendo a interface.
//
// APP_PUBLIC_URL controla a base da URL nos links (ex: https://app.nimbus.com).
// Em dev fica http://localhost:5173 (Vite) por padrão.

const APP_PUBLIC_URL = String(process.env.APP_PUBLIC_URL || "http://localhost:5173").replace(/\/+$/, "");

function verifyUrl(token) {
  return `${APP_PUBLIC_URL}/?verify=${encodeURIComponent(token)}`;
}

function resetUrl(token) {
  return `${APP_PUBLIC_URL}/?reset=${encodeURIComponent(token)}`;
}

async function sendVerificationEmail({ to, name, token }) {
  const url = verifyUrl(token);
  console.log("\n────────────────────────────────────────────────────────────────");
  console.log(`[mailer] VERIFICAÇÃO DE EMAIL → ${to} (${name || "—"})`);
  console.log(`         Link: ${url}`);
  console.log(`         (válido por 24h)`);
  console.log("────────────────────────────────────────────────────────────────\n");
  return { ok: true, url };
}

async function sendPasswordResetEmail({ to, name, token }) {
  const url = resetUrl(token);
  console.log("\n────────────────────────────────────────────────────────────────");
  console.log(`[mailer] RESET DE SENHA → ${to} (${name || "—"})`);
  console.log(`         Link: ${url}`);
  console.log(`         (válido por 1h)`);
  console.log("────────────────────────────────────────────────────────────────\n");
  return { ok: true, url };
}

module.exports = {
  sendVerificationEmail,
  sendPasswordResetEmail,
  verifyUrl,
  resetUrl,
};
