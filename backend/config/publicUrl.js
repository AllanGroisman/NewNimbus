// Fonte ÚNICA da URL pública do sistema.
//
// Defina PUBLIC_BASE_URL no backend/.env e TODAS as URLs externas derivam dela:
//   - CORS allowlist          (server.js)
//   - links em e-mails        (auth/mailer.js)
//   - retorno do Stripe        (billing/stripe.js)
//
// Para alternar entre o ambiente de testes (ngrok) e produção
// (sistema.nimbuspromocoes.com) basta trocar PUBLIC_BASE_URL — uma linha só.
//
// Se PUBLIC_BASE_URL estiver vazio, caímos nas variáveis individuais antigas
// (APP_PUBLIC_URL / STRIPE_SUCCESS_URL / STRIPE_CANCEL_URL / NIMBUS_CORS_ORIGINS)
// e, por fim, nos defaults de dev (localhost). Assim nada quebra em ambientes
// que ainda não definiram PUBLIC_BASE_URL.

function stripTrailing(u) {
  return String(u || "").trim().replace(/\/+$/, "");
}

const BASE = stripTrailing(process.env.PUBLIC_BASE_URL);

// Base dos links nos e-mails transacionais.
const appPublicUrl = BASE
  || stripTrailing(process.env.APP_PUBLIC_URL)
  || "http://localhost:5173";

// URLs de retorno do Checkout do Stripe.
const stripeSuccessUrl = (BASE && `${BASE}/?checkout=success`)
  || process.env.STRIPE_SUCCESS_URL
  || "http://localhost:5173/?checkout=success";
const stripeCancelUrl = (BASE && `${BASE}/?checkout=cancel`)
  || process.env.STRIPE_CANCEL_URL
  || "http://localhost:5173/?checkout=cancel";

// Retorno do checkout PÚBLICO (quem veio da landing e ainda não tem conta).
// O success leva o id da Checkout Session, que a página /bem-vindo troca por
// uma sessão logada; o cancel devolve pra própria tela de assinatura do plano.
const appBase = appPublicUrl;
const stripeWelcomeUrl = `${appBase}/bem-vindo?session_id={CHECKOUT_SESSION_ID}`;
const subscribeUrl = (planId) =>
  `${appBase}/assinar?plano=${encodeURIComponent(planId || "")}&cancelado=1`;

// Allowlist de CORS: junta PUBLIC_BASE_URL com NIMBUS_CORS_ORIGINS (CSV).
// Lista vazia = aceita tudo (comportamento de dev mantido em server.js).
const corsOrigins = [
  ...(BASE ? [BASE] : []),
  ...String(process.env.NIMBUS_CORS_ORIGINS || "")
    .split(",").map(s => s.trim()).filter(Boolean),
];

module.exports = {
  PUBLIC_BASE_URL: BASE,
  appPublicUrl,
  stripeSuccessUrl,
  stripeCancelUrl,
  stripeWelcomeUrl,
  subscribeUrl,
  corsOrigins,
};
