// Wrapper do Stripe SDK — centraliza configuração e mapeamento de price→plan.
// Sem chave secreta no modo ativo, todas as ops viram no-op com `enabled=false`
// — útil pra rodar dev/test sem credenciais ou desativar billing em deploys
// específicos.
//
// MODOS (test/live): o sistema carrega os DOIS conjuntos de credenciais do .env
// e o admin escolhe qual está valendo (aba Stripe do painel → app_config
// "stripe-mode"). Assim dá pra alternar entre os produtos de teste e os de
// produção sem editar .env nem reiniciar. O modo é lido a cada chamada porque
// o cache do app_config é atualizado sozinho a cada 30s — o worker acompanha a
// troca feita no server sem restart.

const logger = require("../infra/logger");
const appConfig = require("../config");
const { normalizeCpf, isValidCpf, formatCpf } = require("../utils/cpf");

const MODES = ["test", "live"];
const MODE_KEY = "stripe-mode";

// A que modo pertencem as variáveis SEM sufixo (formato antigo do .env): a
// própria chave diz — sk_live_… é produção, qualquer outra coisa é teste.
// Amarrar isso ao STRIPE_MODE_DEFAULT seria uma armadilha: quem setasse
// STRIPE_MODE_DEFAULT=live antes de preencher as _LIVE rodaria "em produção"
// com as chaves de teste, sem nenhum aviso.
const LEGACY_MODE = /^sk_live_/.test(process.env.STRIPE_SECRET_KEY || "") ? "live" : "test";

// Modo do primeiro boot, antes de alguém escolher no painel. Sem
// STRIPE_MODE_DEFAULT, segue o modo das variáveis sem sufixo — assim um .env
// antigo (só chaves live, sem sufixo) continua subindo em produção como antes.
const DEFAULT_MODE = MODES.includes(process.env.STRIPE_MODE_DEFAULT)
  ? process.env.STRIPE_MODE_DEFAULT
  : LEGACY_MODE;

// Sufixo _TEST/_LIVE, com fallback pras variáveis sem sufixo (que valem só pro
// LEGACY_MODE). O .env que já existe continua funcionando sem edição nenhuma.
function envFor(name, m) {
  const suffixed = process.env[`${name}_${m.toUpperCase()}`];
  if (suffixed) return suffixed;
  return (m === LEGACY_MODE && process.env[name]) || "";
}

function buildConf(m) {
  const prices = {
    basic: envFor("STRIPE_PRICE_BASIC", m),
    pro: envFor("STRIPE_PRICE_PRO", m),
    business: envFor("STRIPE_PRICE_BUSINESS", m),
  };
  return {
    secret: envFor("STRIPE_SECRET_KEY", m),
    webhookSecret: envFor("STRIPE_WEBHOOK_SECRET", m),
    prices,
    // Price avulso de R$1 cobrado hoje no checkout com trial ("15 dias por R$1").
    trialFeePrice: envFor("STRIPE_PRICE_TRIAL_FEE", m),
    // Mapa reverso pra resolver planId a partir de price.id no webhook.
    priceToPlan: Object.fromEntries(
      Object.entries(prices).filter(([, v]) => v).map(([k, v]) => [v, k])
    ),
  };
}

const CONF = Object.fromEntries(MODES.map((m) => [m, buildConf(m)]));

const TRIAL_DAYS = 15;

const { stripeSuccessUrl: SUCCESS_URL, stripeCancelUrl: CANCEL_URL } = require("../config/publicUrl");

// Modo ativo. Cai no default quando o banco ainda não tem a chave (primeiro
// boot) ou quando o valor gravado é inválido.
function mode() {
  const saved = appConfig.get(MODE_KEY);
  const value = typeof saved === "string" ? saved : saved?.mode;
  return MODES.includes(value) ? value : DEFAULT_MODE;
}

function conf(m = mode()) {
  return CONF[m] || CONF[DEFAULT_MODE];
}

// Troca o modo ativo. Grava no app_config (compartilhado entre server e worker)
// e limpa o cache de preços pra próxima leitura já trazer o catálogo novo.
// Quem precisa de confirmação da gravação chama appConfig.flush() depois.
function setMode(next) {
  if (!MODES.includes(next)) throw new Error(`Modo Stripe inválido: "${next}"`);
  appConfig.set(MODE_KEY, { mode: next });
  // require tardio: prices.js requer este módulo (ciclo se fosse no topo).
  require("./prices").__invalidate();
  logger.info({ mode: next }, "[stripe] modo alterado");
  return next;
}

// Retrato da configuração pro painel admin — nunca expõe segredo, só se existe.
function modeInfo() {
  const active = mode();
  const modes = Object.fromEntries(MODES.map((m) => {
    const c = CONF[m];
    return [m, {
      hasSecret: !!c.secret,
      hasWebhookSecret: !!c.webhookSecret,
      prices: { ...c.prices, trialFee: c.trialFeePrice },
      // Faltando algo essencial, o painel explica o que colocar no .env.
      missing: [
        !c.secret && `STRIPE_SECRET_KEY_${m.toUpperCase()}`,
        !c.prices.basic && `STRIPE_PRICE_BASIC_${m.toUpperCase()}`,
        !c.prices.pro && `STRIPE_PRICE_PRO_${m.toUpperCase()}`,
        !c.prices.business && `STRIPE_PRICE_BUSINESS_${m.toUpperCase()}`,
      ].filter(Boolean),
    }];
  }));
  return { mode: active, defaultMode: DEFAULT_MODE, modes };
}

const _clients = { test: null, live: null };
function client() {
  const m = mode();
  const { secret } = conf(m);
  if (!secret) return null;
  if (!_clients[m]) {
    const Stripe = require("stripe");
    _clients[m] = new Stripe(secret, {
      // Sem apiVersion fixa — usa a versão default da chave (configurada no dashboard).
      // Fixar aqui ajuda em prod (estabilidade), mas em dev/test deixar livre é mais simples.
      typescript: false,
    });
  }
  return _clients[m];
}

function enabled() {
  return !!conf().secret;
}

function priceFor(planId) {
  return conf().prices[planId] || "";
}

function planFromPrice(priceId) {
  return conf().priceToPlan[priceId] || null;
}

// Cria (ou recupera) o Stripe Customer pra um user do Nimbus.
// userId vai como metadata pra rastrear no dashboard.
//
// O CPF entra como documento fiscal (tax ID br_cpf), não só como metadata: é o
// que faz o número aparecer no cadastro do cliente, nas faturas e nos recibos.
// Gravamos na criação (tax_id_data) e conferimos no reuso (ensureCustomerTaxId),
// porque o Customer pode ter nascido antes desta regra.
async function getOrCreateCustomer({ userId, email, name, cpf, existingCustomerId }) {
  const digits = normalizeCpf(cpf);
  const validCpf = isValidCpf(digits) ? digits : null;

  if (existingCustomerId) {
    try {
      const existing = await client().customers.retrieve(existingCustomerId);
      if (validCpf) await ensureCustomerTaxId(existing.id, validCpf);
      return existing;
    } catch (err) {
      logger.warn({ err: err.message, existingCustomerId }, "[stripe] customer retrieve falhou — criando novo");
    }
  }
  return client().customers.create({
    email,
    name,
    metadata: { ...(userId ? { nimbusUserId: userId } : {}), ...(validCpf ? { cpf: validCpf } : {}) },
    ...(validCpf ? { tax_id_data: [{ type: "br_cpf", value: formatCpf(validCpf) }] } : {}),
  });
}

// Garante que o Customer tenha o CPF como documento fiscal, sem duplicar.
// Best-effort de propósito: documento fiscal não pode derrubar um pagamento —
// se o Stripe recusar, o CPF continua no metadata e o log conta o que houve.
async function ensureCustomerTaxId(customerId, cpf) {
  const digits = normalizeCpf(cpf);
  if (!customerId || !isValidCpf(digits)) return null;
  const c = client();
  if (!c) return null;
  try {
    const { data } = await c.customers.listTaxIds(customerId, { limit: 20 });
    const already = (data || []).some(
      t => t.type === "br_cpf" && normalizeCpf(t.value) === digits
    );
    if (already) return null;
    return await c.customers.createTaxId(customerId, {
      type: "br_cpf",
      value: formatCpf(digits),
    });
  } catch (err) {
    logger.warn({ err: err.message, customerId }, "[stripe] CPF fiscal não gravado no customer");
    return null;
  }
}

// Procura um Customer pelo e-mail. Usado no checkout público, onde a conta ainda
// não existe: sem isso, cada tentativa abandonada criaria um Customer novo pro
// mesmo e-mail.
async function findCustomerByEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e) return null;
  const c = client();
  if (!c) return null;
  try {
    const { data } = await c.customers.list({ email: e, limit: 1 });
    return data?.[0] || null;
  } catch (err) {
    logger.warn({ err: err.message }, "[stripe] busca de customer por e-mail falhou");
    return null;
  }
}

// Acerta o email do Customer depois que a pessoa troca o email da conta —
// senão recibo e aviso de cobrança continuam indo pro endereço antigo.
async function updateCustomerEmail(customerId, email) {
  if (!customerId || !email) return null;
  const c = client();
  if (!c) return null;
  return c.customers.update(customerId, { email });
}

// Cria sessão de Checkout em modo subscription.
// payment_method_types: cartão sempre; Pix só se planId não for trial-only.
// withTrial: cobra R$1 hoje (line item avulso) + 15 dias de trial na assinatura.
//
// Dois chamadores:
//   - app (usuário logado): passa `customer` + `userId`, volta pra SUCCESS_URL.
//   - landing (sem conta ainda): passa `customerEmail`; não há userId pra gravar
//     em client_reference_id, então a conta é provisionada depois a partir da
//     própria Checkout Session — daí o retorno em stripeWelcomeUrl.
async function createCheckoutSession({
  planId, customer, customerEmail, userId, withTrial = false,
  successUrl, cancelUrl, metadataExtra,
}) {
  const price = priceFor(planId);
  if (!price) throw new Error(`Price ID não configurado pro plano "${planId}"`);
  if (!customer && !customerEmail) throw new Error("Checkout precisa de customer ou customerEmail");
  const trialFeePrice = conf().trialFeePrice;
  if (withTrial && !trialFeePrice) {
    throw new Error("STRIPE_PRICE_TRIAL_FEE não configurado — trial de R$1 indisponível");
  }

  const lineItems = [{ price, quantity: 1 }];
  if (withTrial) lineItems.push({ price: trialFeePrice, quantity: 1 });

  // userId é undefined no checkout público — metadata do Stripe rejeita valores
  // não-string, então só entra quando existe.
  const baseMeta = {
    ...(userId ? { nimbusUserId: userId } : {}),
    planId,
    ...(metadataExtra || {}),
  };

  const subscriptionData = {
    metadata: { ...baseMeta, ...(withTrial ? { trial: "1" } : {}) },
  };
  if (withTrial) {
    subscriptionData.trial_period_days = TRIAL_DAYS;
    subscriptionData.trial_settings = {
      end_behavior: { missing_payment_method: "cancel" },
    };
  }

  return client().checkout.sessions.create({
    mode: "subscription",
    ...(customer
      ? { customer: customer.id }
      // Sem customer: o Stripe cria um na conclusão e já vincula à assinatura.
      : { customer_email: customerEmail }),
    ...(userId ? { client_reference_id: userId } : {}),
    line_items: lineItems,
    // Pix recorrente em BRL precisa estar habilitado no dashboard.
    // Se ainda não ativou, deixar só "card" funciona; com Pix ativo, ambos.
    payment_method_types: ["card"],
    // Garante cartão salvo durante o trial pra renovação funcionar.
    ...(withTrial ? { payment_method_collection: "always" } : {}),
    locale: "pt-BR",
    allow_promotion_codes: true,
    success_url: successUrl || SUCCESS_URL,
    cancel_url: cancelUrl || CANCEL_URL,
    metadata: baseMeta,
    subscription_data: subscriptionData,
  });
}

// Busca uma Checkout Session pelo id, com o customer expandido — é a fonte do
// e-mail e do plano no provisionamento de quem pagou antes de ter conta.
async function getCheckoutSession(sessionId) {
  return client().checkout.sessions.retrieve(sessionId, {
    expand: ["customer", "subscription"],
  });
}

// Troca o plano de uma assinatura viva, cobrando a diferença na hora
// (always_invoice gera a fatura proporcional imediatamente, em vez de jogar o
// crédito/débito pra próxima renovação). Só usado pra upgrade — descer de plano
// continua indo pelo Customer Portal.
async function changeSubscriptionPlan(subscriptionId, planId) {
  const price = priceFor(planId);
  if (!price) throw new Error(`Price ID não configurado pro plano "${planId}"`);
  const sub = await client().subscriptions.retrieve(subscriptionId);
  const item = sub.items?.data?.[0];
  if (!item) throw new Error("Assinatura sem item de cobrança");

  const updated = await client().subscriptions.update(subscriptionId, {
    items: [{ id: item.id, price, quantity: 1 }],
    proration_behavior: "always_invoice",
    // Se a cobrança da diferença cair em 3DS/recusa, a assinatura não é
    // derrubada — fica incomplete e o Stripe segue tentando.
    payment_behavior: "pending_if_incomplete",
    // Mantém o planId explícito que normalizeSubscription prefere ler.
    metadata: { ...(sub.metadata || {}), planId },
  });
  return normalizeSubscription(updated);
}

// Customer Portal — Stripe-hosted UI pra trocar cartão / cancelar / ver faturas.
async function createPortalSession({ customer }) {
  return client().billingPortal.sessions.create({
    customer: customer.id,
    return_url: SUCCESS_URL.replace(/\?.*$/, "") || "http://localhost:5173/",
  });
}

// Verifica assinatura do webhook. Lança em falha — express handler responde 400.
//
// Tenta o segredo do modo ativo e, se não bater, o do outro modo: teste e
// produção são endpoints DIFERENTES no dashboard do Stripe (com segredos
// diferentes) apontando pra mesma URL. Sem isso, todo evento do modo inativo
// viraria 400 no log — inclusive os do modo teste que chegam atrasados logo
// depois de virar a chave pra produção.
function constructEvent(rawBody, signature) {
  const active = mode();
  const secrets = [conf(active).webhookSecret, ...MODES.filter((m) => m !== active).map((m) => conf(m).webhookSecret)]
    .filter(Boolean);
  if (!secrets.length) throw new Error("STRIPE_WEBHOOK_SECRET não configurado");
  let lastErr = null;
  for (const secret of secrets) {
    try { return client().webhooks.constructEvent(rawBody, signature, secret); }
    catch (err) { lastErr = err; }
  }
  throw lastErr;
}

// Extrai os campos relevantes de um Stripe Subscription pra persistir.
// Status string vai direto. Plano é resolvido por price.id do primeiro item.
function normalizeSubscription(sub) {
  const item = sub.items?.data?.[0];
  const priceId = item?.price?.id || null;
  // Prefere o planId explícito gravado no checkout (subscription_data.metadata.planId).
  // Fallback pro mapa price→plan. Blinda contra price_id defasado/trocado no .env.
  const metaPlan = sub.metadata?.planId;
  const validMeta = ["basic", "pro", "business"].includes(metaPlan) ? metaPlan : null;
  const planId = validMeta || (priceId ? planFromPrice(priceId) : null);
  // API "basil" (2025-03+) moveu current_period_end pro item — fallback defensivo.
  const periodEndUnix = sub.current_period_end ?? item?.current_period_end ?? null;
  const currentPeriodEnd = periodEndUnix ? new Date(periodEndUnix * 1000) : null;
  return {
    stripeSubscriptionId: sub.id,
    stripeCustomerId: typeof sub.customer === "string" ? sub.customer : sub.customer?.id,
    // Modo em que esta assinatura vive — assinatura de teste não pode valer
    // quando o sistema está em produção (e vice-versa). Ver billing/pg.js.
    stripeMode: sub.livemode === true ? "live" : sub.livemode === false ? "test" : mode(),
    planId: planId || "free",
    status: sub.status,
    currentPeriodEnd,
    cancelAtPeriodEnd: !!sub.cancel_at_period_end,
    // Não é coluna do banco — chamadores usam pra marcar trialUsedAt e removem antes de persistir.
    trialEnd: sub.trial_end ? new Date(sub.trial_end * 1000) : null,
  };
}

// Busca a assinatura ao vivo do customer no Stripe e devolve normalizada.
// Usado pela reconciliação ativa (POST /api/billing/sync) — corrige o plano
// mesmo quando o webhook customer.subscription.updated não chega (ex: ngrok defasado).
async function getActiveSubscriptionForCustomer(customerId) {
  if (!customerId) return null;
  const res = await client().subscriptions.list({
    customer: customerId,
    status: "all",
    limit: 10,
  });
  const subs = res.data || [];
  if (!subs.length) return null;
  const active = subs.find((s) => ["active", "trialing", "past_due"].includes(s.status))
    || subs.slice().sort((a, b) => b.created - a.created)[0];
  return normalizeSubscription(active);
}

// Preview da próxima fatura (valor exato, considera cupons/proração).
// Sem fatura futura (ex: cancelamento agendado) o Stripe lança — retorna null.
async function getUpcomingInvoice(customerId) {
  if (!customerId) return null;
  try {
    const inv = await client().invoices.createPreview({ customer: customerId });
    return {
      amountBRL: (inv.total ?? 0) / 100,
      currency: inv.currency || "brl",
      nextPaymentAttempt: inv.next_payment_attempt
        ? new Date(inv.next_payment_attempt * 1000)
        : null,
    };
  } catch (err) {
    logger.warn({ err: err.message, customerId }, "[stripe] upcoming invoice indisponível");
    return null;
  }
}

// Quanto de cada fatura já voltou pro cliente. O Stripe NUNCA muda o
// `invoice.status` depois de um estorno — a fatura reembolsada segue "paid"
// pra sempre —, então o valor devolvido tem que vir das cobranças.
//
// A ligação fatura↔cobrança é por payment_intent: `invoice.charge` não existe
// mais nesta versão da API (vem undefined), e `charge.invoice` também não. O
// que sobra é `invoice.payments[].payment.payment_intent` de um lado e
// `charge.payment_intent` do outro.
function refundsFromCharges(invoices, charges) {
  const porPI = new Map();
  for (const ch of charges || []) {
    if (ch.payment_intent) porPI.set(ch.payment_intent, Number(ch.amount_refunded) || 0);
  }
  const out = new Map();
  for (const inv of invoices) {
    let devolvido = 0;
    for (const p of inv.payments?.data || []) {
      const pi = p?.payment?.payment_intent;
      if (pi && porPI.has(pi)) devolvido += porPI.get(pi);
    }
    out.set(inv.id, devolvido);
  }
  return out;
}

// Últimas faturas do customer pro histórico na página (máx. 10).
async function listInvoices(customerId, limit = 10) {
  if (!customerId) return [];
  const res = await client().invoices.list({
    customer: customerId,
    limit,
    expand: ["data.payments"],
  });
  const invoices = res.data || [];

  // Estorno é enfeite: se a listagem de charges falhar, o histórico ainda vale.
  let refunds = new Map();
  try {
    const charges = await client().charges.list({ customer: customerId, limit: 100 });
    refunds = refundsFromCharges(invoices, charges.data || []);
  } catch (err) {
    logger.warn({ err: err.message, customerId }, "[stripe] estornos das faturas indisponíveis");
  }

  return invoices.map((inv) => {
    const total = inv.total ?? 0;
    const devolvido = refunds.get(inv.id) || 0;
    return {
      id: inv.id,
      date: new Date(inv.created * 1000),
      amountBRL: total / 100,
      status: inv.status, // draft | open | paid | void | uncollectible
      // Separado do `status` de propósito — quem lê status espera o vocabulário
      // do Stripe, e o resto do sistema depende dele.
      refundedBRL: devolvido / 100,
      refundStatus: devolvido <= 0 ? "none" : devolvido >= total ? "full" : "partial",
      hostedUrl: inv.hosted_invoice_url || null,
      pdfUrl: inv.invoice_pdf || null,
    };
  });
}

// Cartão que será cobrado: default da assinatura, senão default do customer.
async function getDefaultPaymentMethod(customerId, subscriptionId) {
  let pm = null;
  if (subscriptionId) {
    try {
      const sub = await client().subscriptions.retrieve(subscriptionId, {
        expand: ["default_payment_method"],
      });
      pm = sub.default_payment_method;
    } catch (err) {
      logger.warn({ err: err.message, subscriptionId }, "[stripe] retrieve subscription falhou");
    }
  }
  if (!pm && customerId) {
    try {
      const cust = await client().customers.retrieve(customerId, {
        expand: ["invoice_settings.default_payment_method"],
      });
      pm = cust.invoice_settings?.default_payment_method;
    } catch (err) {
      logger.warn({ err: err.message, customerId }, "[stripe] retrieve customer falhou");
    }
  }
  if (!pm || typeof pm === "string" || !pm.card) return null;
  return {
    brand: pm.card.brand,
    last4: pm.card.last4,
    expMonth: pm.card.exp_month,
    expYear: pm.card.exp_year,
  };
}

// Busca no Stripe o preço E o nome do produto de cada plano configurado
// (STRIPE_PRICE_*). Retorna { basic: { priceBRL, name, priceId }, ... } só com
// os planos válidos (BRL, unit_amount presente) — plano ausente aqui cai no
// fallback de limits.js no chamador.
async function fetchPlanPrices() {
  const out = {};
  for (const [planId, priceId] of Object.entries(conf().prices)) {
    if (!priceId) continue;
    // expand product: o nome exibido no site passa a ser o do dashboard.
    const price = await client().prices.retrieve(priceId, { expand: ["product"] });
    if (price.currency !== "brl" || price.unit_amount == null) {
      logger.warn({ planId, priceId, currency: price.currency }, "[stripe] price sem unit_amount em BRL — ignorando");
      continue;
    }
    const product = typeof price.product === "object" ? price.product : null;
    out[planId] = {
      priceBRL: price.unit_amount / 100,
      // Produto arquivado/sem nome não derruba nada — chamador cai no label local.
      name: product?.name || null,
      priceId,
    };
  }
  return out;
}

// Cancela a assinatura AGORA (não no fim do período). O Stripe responde com o
// objeto já `canceled` e dispara customer.subscription.deleted — é ESSE evento
// que derruba o plano pra free do nosso lado; aqui não mexemos no banco.
async function cancelSubscription(subscriptionId) {
  const canceled = await client().subscriptions.cancel(subscriptionId);
  return normalizeSubscription(canceled);
}

// Desfaz cancelamento agendado (cancel_at_period_end=true → false).
async function reactivateSubscription(subscriptionId) {
  const updated = await client().subscriptions.update(subscriptionId, {
    cancel_at_period_end: false,
  });
  return normalizeSubscription(updated);
}

module.exports = {
  client,
  enabled,
  mode,
  setMode,
  modeInfo,
  priceFor,
  planFromPrice,
  getOrCreateCustomer,
  ensureCustomerTaxId,
  findCustomerByEmail,
  updateCustomerEmail,
  createCheckoutSession,
  getCheckoutSession,
  changeSubscriptionPlan,
  cancelSubscription,
  createPortalSession,
  constructEvent,
  normalizeSubscription,
  getActiveSubscriptionForCustomer,
  getUpcomingInvoice,
  listInvoices,
  refundsFromCharges, // exportada pro teste unitário do mapeamento fatura↔estorno
  getDefaultPaymentMethod,
  fetchPlanPrices,
  reactivateSubscription,
};
