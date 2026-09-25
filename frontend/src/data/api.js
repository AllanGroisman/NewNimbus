import { reportSuccess, reportFailure } from "./netStatus.js";

const API_BASE = "";
const TOKEN_KEY = "nimbus.token";
const LAST_ACTIVITY_KEY = "nimbus.lastActivity";

// Sessão expira após este tempo sem atividade do usuário. Fonte única no front —
// o backend usa TTL de token equivalente (2h) renovado enquanto há atividade.
export const IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2h

// ─── Token (localStorage) ──────────────────────────────────────────────
export function getToken() {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
export function setToken(t) {
  try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch {}
}
export function clearToken() { setToken(null); }

// ─── Última atividade (para timeout de inatividade) ─────────────────────
export function getLastActivity() {
  try { return Number(localStorage.getItem(LAST_ACTIVITY_KEY)) || 0; } catch { return 0; }
}
export function setLastActivity(ts) {
  try { localStorage.setItem(LAST_ACTIVITY_KEY, String(ts)); } catch {}
}

// ─── Erros ──────────────────────────────────────────────────────────────
// Tudo que sai de http() é um NimbusError com `message` já em português e
// pronto pra ir na tela. A mensagem técnica original (inglês, nome de host,
// stack de biblioteca) fica em `raw` — console e Sentry, nunca a interface.

export const MSG_OFFLINE  = "Não foi possível conectar ao Nimbus. Verifique sua conexão ou tente novamente em instantes.";
export const MSG_INTERNAL = "Algo deu errado do nosso lado. Tente novamente em instantes.";
export const MSG_REQUEST  = "Não foi possível concluir a ação. Tente novamente.";

export class NimbusError extends Error {
  constructor(message, { status = 0, code = null, body = {}, offline = false, raw = null, retryAfterSeconds = null } = {}) {
    super(message);
    this.name = "NimbusError";
    this.status = status;
    this.code = code;
    // Corpo inteiro do erro: respostas como o 409 do checkout público mandam
    // dados que a tela usa (planos maiores, links) além da mensagem.
    this.body = body;
    this.offline = offline;
    this.raw = raw || message;
    if (retryAfterSeconds) this.retryAfterSeconds = retryAfterSeconds;
  }
}

// Helper pras telas: mensagem pronta pro usuário, com fallback contextual.
export function errText(err, fallback = MSG_REQUEST) {
  return err?.message || fallback;
}

function offlineError(raw, code = "server_offline", status = 0) {
  return new NimbusError(MSG_OFFLINE, { status, code, offline: true, raw });
}

// Timeout do cliente. O nginx corta em 90s (proxy_read_timeout), então as
// rotas lentas usam um teto maior que o dele — assim quem responde é o nginx,
// com 504, e a mensagem sai igual à de queda.
const DEFAULT_TIMEOUT_MS = 30_000;
const SLOW_TIMEOUT_MS = 100_000;
// O yt-dlp listando um canal grande passa dos 100s do SLOW. Acima dos 180s do
// nginx de propósito: quem corta é o nginx, com 504, e a mensagem sai igual à
// de queda em vez de um "abortado" genérico do navegador.
const VERY_SLOW_TIMEOUT_MS = 190_000;

async function http(method, path, body, { signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const opts = { method, headers: {} };
  const token = getToken();
  if (token) opts.headers["Authorization"] = `Bearer ${token}`;
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }

  // Um controller só, alimentado pelo timeout e pelo abort do chamador (o
  // botão "cancelar busca" do GroupDashboard). AbortSignal.any não serve aqui
  // porque precisamos saber *qual* dos dois disparou pra escolher a mensagem.
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
  const onCallerAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener("abort", onCallerAbort);
  }
  opts.signal = ctrl.signal;

  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, opts);
  } catch (err) {
    // Cancelamento pedido pela tela: repassa cru (o chamador trata AbortError).
    if (signal?.aborted) throw err;
    const failure = timedOut
      ? offlineError(`timeout ${timeoutMs}ms em ${method} ${path}`, "timeout")
      // fetch só rejeita com TypeError: backend fora, DNS, CORS, rede caída.
      : offlineError(`${err?.name || "Error"}: ${err?.message || err} em ${method} ${path}`);
    reportFailure(failure);
    throw failure;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onCallerAbort);
  }

  if (res.status === 401) {
    clearToken();
    // notifica a app que o token caiu
    window.dispatchEvent(new CustomEvent("nimbus:unauthorized"));
  }

  if (!res.ok) {
    let payload = null;
    try { payload = await res.json(); } catch { /* HTML do nginx ou corpo vazio */ }
    const detail = payload && typeof payload === "object" ? (payload.error || payload.details) : null;
    if (detail) {
      // Erro do backend: a mensagem já vem em português e pronta pro usuário.
      const err = new NimbusError(detail, {
        status: res.status,
        code: payload.code || null,
        body: payload,
        retryAfterSeconds: payload.retryAfterSeconds,
        offline: payload.code === "server_offline",
      });
      if (err.offline) reportFailure(err); else reportSuccess();
      throw err;
    }
    // Sem JSON aproveitável. É daqui que vinha o "Bad Gateway" em inglês:
    // res.statusText nunca vai pra tela, a mensagem sai do status.
    const offline = res.status === 502 || res.status === 503 || res.status === 504;
    const message = offline ? MSG_OFFLINE : res.status >= 500 ? MSG_INTERNAL : MSG_REQUEST;
    const err = new NimbusError(message, {
      status: res.status,
      code: offline ? "server_offline" : res.status >= 500 ? "internal" : "request_failed",
      body: payload && typeof payload === "object" ? payload : {},
      offline,
      raw: `${method} ${path} → ${res.status} ${res.statusText || ""}`.trim(),
    });
    if (offline) reportFailure(err); else reportSuccess();
    throw err;
  }

  reportSuccess();
  try {
    return await res.json();
  } catch (err) {
    // 2xx com corpo não-JSON (proxy mal configurado, resposta truncada).
    throw new NimbusError(MSG_INTERNAL, {
      status: res.status, code: "bad_response",
      raw: `corpo não-JSON em ${method} ${path}: ${err?.message || err}`,
    });
  }
}

// ─── Auth ──────────────────────────────────────────────────────────────
export async function authRegister({ name, email, password, phone }) {
  // Backend não devolve token — precisa verificar email primeiro.
  return http("POST", "/api/auth/register", { name, email, password, phone });
}
export async function authRegistrationStatus() { return http("GET", "/api/auth/registration-status"); }
export async function authLogin({ email, password }) {
  const r = await http("POST", "/api/auth/login", { email, password });
  if (r.token) setToken(r.token);
  return r;
}
export async function authGoogle(idToken) {
  const r = await http("POST", "/api/auth/google", { idToken });
  if (r.token) setToken(r.token);
  return r;
}
export async function authVerifyEmail(token) {
  const r = await http("POST", "/api/auth/verify-email", { token });
  if (r.token) setToken(r.token);
  return r;
}
export async function authResendVerification(email) {
  return http("POST", "/api/auth/resend-verification", { email });
}
export async function authForgotPassword(email) {
  return http("POST", "/api/auth/forgot-password", { email });
}
export async function authResetPassword(token, newPassword) {
  const r = await http("POST", "/api/auth/reset-password", { token, newPassword });
  if (r.token) setToken(r.token);
  return r;
}
export async function authMe() {
  return http("GET", "/api/auth/me");
}
// Renova o token de sessão (sliding session). Chamado enquanto há atividade.
export async function authRefresh() {
  const r = await http("POST", "/api/auth/refresh");
  if (r.token) setToken(r.token);
  return r;
}
export async function authUpdate(updates) {
  return http("PATCH", "/api/auth/me", updates);
}
export async function authChangePassword({ currentPassword, newPassword }) {
  const r = await http("POST", "/api/auth/password", { currentPassword, newPassword });
  // Trocar a senha derruba os tokens antigos no servidor — guardamos o novo pra
  // esta aba continuar logada (as outras sessões caem, que é a intenção).
  if (r.token) setToken(r.token);
  return r;
}
export function authLogout() { clearToken(); }

// ─── Estado persistido (groups / numbers / whatsappGroups) ─────────────
export async function loadAppState() {
  return http("GET", "/api/state");
}
export async function saveAppState(state) {
  return http("PUT", "/api/state", state);
}
// Apenas dados operacionais (queue/history/métricas) para polling
export async function loadAppOps() {
  return http("GET", "/api/state/ops");
}
// Envia o próximo item da fila da campanha agora (ignora janela/intervalo)
export async function sendNextNow(groupId) {
  return http("POST", `/api/state/groups/${groupId}/send-now`);
}
// Força refill da fila a partir do catálogo (consulta com filtros atuais da campanha).
// Aceita { signal } pra suportar AbortController do chamador (UI cancelar).
export async function refillQueueNow(groupId, overrides, { signal } = {}) {
  return http("POST", `/api/state/groups/${groupId}/refill`, overrides || {}, { signal, timeoutMs: SLOW_TIMEOUT_MS });
}
// Busca metadados de uma URL (scraping on-demand) — pré-preenche o form de manual add
export async function fetchUrlMetadata(url) {
  return http("POST", "/api/scraper/fetch-url", { url }, { timeoutMs: SLOW_TIMEOUT_MS });
}
// Adiciona um produto manualmente à fila/pending da campanha.
// `payload` = { url, overrides: { name, price, originalPrice, discount, img, store, category }, force? }
// Tratamento especial: 409 (duplicata) é jogado como erro com code; cooldown vem como { inCooldown: true } no JSON.
export async function manualAddToQueue(groupId, payload) {
  return http("POST", `/api/state/groups/${groupId}/manual-add`, payload || {});
}
// Persiste a fila reordenada/editada (drag-and-drop, remoção de item). A ordem
// e a composição vivem numa tabela de ops que o save geral (PUT /api/state) não
// grava — por isso a fila precisa desta rota dedicada pra sobreviver ao poll.
export async function saveGroupQueue(groupId, queue) {
  return http("PUT", `/api/state/groups/${groupId}/queue`, { queue });
}
// Salva o cupom de um item da fila ou dos pendentes (list: "queue" | "pending").
// coupon "" apaga o cupom do item.
export async function saveItemCoupon(groupId, list, itemId, coupon) {
  return http("PATCH", `/api/state/groups/${groupId}/${list}/${encodeURIComponent(itemId)}/coupon`, { coupon });
}
// Limpa a fila de envios da campanha
export async function clearGroupQueue(groupId) {
  return http("DELETE", `/api/state/groups/${groupId}/queue`);
}
// Limpa o histórico de envios da campanha (reseta cooldown — produtos voltam a ser elegíveis)
export async function clearGroupHistory(groupId) {
  return http("DELETE", `/api/state/groups/${groupId}/history`);
}
// Move um item de pending pra queue (aprova manualmente)
export async function approvePendingItem(groupId, pendingId) {
  return http("POST", `/api/state/groups/${groupId}/pending/${encodeURIComponent(pendingId)}/approve`);
}
// Remove um item de pending (rejeita)
export async function rejectPendingItem(groupId, pendingId) {
  return http("DELETE", `/api/state/groups/${groupId}/pending/${encodeURIComponent(pendingId)}`);
}
// Move TODOS os pendentes pra queue numa única escrita (sem race de N requests)
export async function approveAllPending(groupId) {
  return http("POST", `/api/state/groups/${groupId}/pending/approve-all`);
}
// Remove TODOS os pendentes numa única escrita (rejeita todos)
export async function rejectAllPending(groupId) {
  return http("DELETE", `/api/state/groups/${groupId}/pending`);
}

// ─── Billing (Stripe) ──────────────────────────────────────────────────
// Status atual: { planId, effectivePlan, status, currentPeriodEnd, daysLeftInTrial,
// daysUntilPeriodEnd, limits, usage, trialEligible, plans, stripeEnabled }
// fresh=true → backend reconcilia com o Stripe antes (usar no mount da página).
export async function billingMe(fresh) {
  return http("GET", "/api/billing/me" + (fresh ? "?fresh=1" : ""));
}
// Cria Checkout Session e devolve { url } — frontend chama window.location.assign(url)
// opts.trial=true → checkout "7 dias por R$1" (só Básico, 1x por conta)
// opts.keepManualTrial=false → quem está em cortesia pediu pra encerrá-la e já
//   começar a pagar. Omitido = mantém a cortesia (default que nunca cobra por
//   dias já concedidos).
export async function billingCheckout(planId, opts) {
  return http("POST", "/api/billing/checkout", {
    planId,
    trial: !!opts?.trial,
    keepManualTrial: opts?.keepManualTrial !== false,
  });
}
// Detalhes de cobrança: { upcomingInvoice, paymentMethod, invoices } — mount da página
export async function billingDetails() {
  return http("GET", "/api/billing/details");
}
// Desfaz cancelamento agendado — devolve status atualizado (mesmo shape do billingMe)
export async function billingReactivate() {
  return http("POST", "/api/billing/reactivate");
}
// Reconciliação ativa — busca a assinatura ao vivo no Stripe e devolve o status
// atualizado (mesmo shape do billingMe). Chamado ao voltar do checkout.
export async function billingSync() {
  return http("POST", "/api/billing/sync");
}
// Customer Portal — alterar cartão / cancelar / ver faturas
export async function billingPortal() {
  return http("POST", "/api/billing/portal");
}
// Escolha de quais campanhas/números ficam ATIVOS dentro do plano. O que não
// vier na lista fica pausado pelo plano (não envia, não é apagado).
// selection: { groups: [id, …], numbers: ["id", …] }
export async function billingActiveSelection(selection) {
  return http("PUT", "/api/billing/active-selection", selection);
}
// Upgrade de plano numa assinatura existente — cobra só a diferença (proration).
// Devolve o status atualizado (mesmo shape do billingMe).
export async function billingChangePlan(planId) {
  return http("POST", "/api/billing/change-plan", { planId });
}

// ─── Checkout público (landing → Stripe → sistema) ─────────────────────
// Sem token: são as rotas usadas por quem ainda não tem conta.

// Catálogo pra tela /assinar montar nome e preço do plano escolhido.
export async function publicPlans() { return http("GET", "/api/public/plans"); }

// Diz se o e-mail e o CPF podem seguir pro pagamento:
// { decision: "checkout" | "cpf_taken" | "blocked" | "upgrade_requires_login", message, currentPlan }
export async function publicPlanCheck({ planId, email, cpf }) {
  return http("POST", "/api/public/plan-check", { planId, email, cpf });
}

// Cria a Checkout Session pública e devolve { url }. Erro 409 traz err.code com
// a decisão ("cpf_taken" | "blocked" | "upgrade_requires_login") pra tela explicar.
export async function publicCheckout({ planId, email, cpf, phone, trial }) {
  return http("POST", "/api/public/checkout", { planId, email, cpf, phone, trial: !!trial });
}

// Troca a Checkout Session paga por uma sessão logada: { token, user, needsPassword }.
export async function publicClaim(sessionId) {
  return http("POST", "/api/public/claim", { sessionId });
}

// CPF de quem já tinha conta antes da regra "uma conta = um CPF".
// Erro 409 traz code "cpf_taken" (documento já usado por outra conta).
export async function accountSetCpf(cpf) {
  return http("POST", "/api/account/cpf", { cpf });
}

// Telefone de quem entrou sem informar um (conta antiga, conta do Google).
export async function accountSetPhone(phone) {
  return http("POST", "/api/account/phone", { phone });
}

// Pede a troca de email: manda o link de confirmação pro endereço novo. Nada
// muda na conta até o clique. Erro 409 traz code "email_taken".
export async function accountRequestEmailChange({ password, newEmail }) {
  return http("POST", "/api/account/email", { password, newEmail });
}

// Confirma a troca pelo token do link. Não exige sessão — e derruba as sessões
// abertas no servidor, então quem chamar aqui volta pro login com o email novo.
export async function accountConfirmEmailChange(token) {
  return http("POST", "/api/account/email/confirm", { token });
}

// Primeira senha de quem entrou pelo checkout público (não pede a senha atual).
export async function authSetInitialPassword(password) {
  const r = await http("POST", "/api/auth/set-initial-password", { password });
  if (r.token) setToken(r.token);
  return r;
}

// ─── Afiliados ML ──────────────────────────────────────────────────────
export async function getAffiliateStatus()      { return http("GET",    "/api/affiliate"); }
export async function saveAffiliate(payload)    { return http("PUT",    "/api/affiliate", payload); }
export async function clearAffiliate()          { return http("DELETE", "/api/affiliate"); }
// Os testes de afiliado batem no site da loja — usam o teto maior.
export async function testAffiliate(url)        { return http("POST",   "/api/affiliate/test", url ? { url } : {}, { timeoutMs: SLOW_TIMEOUT_MS }); }

// ─── Afiliados Amazon ──────────────────────────────────────────────────
export async function saveAmazonAffiliate(tag)  { return http("PUT",    "/api/affiliate/amazon", { tag }); }
export async function clearAmazonAffiliate()    { return http("DELETE", "/api/affiliate/amazon"); }
export async function testAmazonAffiliate(url)  { return http("POST",   "/api/affiliate/amazon/test", url ? { url } : {}, { timeoutMs: SLOW_TIMEOUT_MS }); }

// ─── Afiliados Shopee ──────────────────────────────────────────────────
export async function saveShopeeAffiliate({ appId, appSecret }) { return http("PUT",    "/api/affiliate/shopee", { appId, appSecret }); }
export async function clearShopeeAffiliate()                    { return http("DELETE", "/api/affiliate/shopee"); }
export async function testShopeeAffiliate(url)                  { return http("POST",   "/api/affiliate/shopee/test", url ? { url } : {}, { timeoutMs: SLOW_TIMEOUT_MS }); }

// ─── Scraping ──────────────────────────────────────────────────────────
export async function fetchOfertas({ category, minDiscount = 0, minPrice = 0, maxPrice, limit = 50, refresh = false, sources } = {}) {
  const params = new URLSearchParams();
  if (category) params.set("category", category);
  if (minDiscount > 0) params.set("minDiscount", minDiscount);
  if (minPrice > 0) params.set("minPrice", minPrice);
  if (maxPrice) params.set("maxPrice", maxPrice);
  if (limit) params.set("limit", limit);
  if (refresh) params.set("refresh", "true");
  if (sources && sources.length) params.set("sources", sources.join(","));
  return http("GET", `/api/ofertas?${params}`);
}

// Navega o catálogo com os mesmos filtros/ordem que a busca da campanha usa.
// Alimenta a prévia da aba "Busca de Produtos" (paginada).
// Retorna { items, total, page, pageSize, fuzzy, catalogStats } — `fuzzy` quando
// nada batia exato com `q` e a lista é de nomes parecidos.
// Com `groupId`, o backend já tira da lista o que essa campanha tem na fila
// (hideQueued) e o que ela já mandou alguma vez (hideRecent) — o mesmo corte que
// o preenchimento automático faz.
export async function browseCatalog({
  categories, sources, q = "", minPrice = 0, maxPrice, minDiscount = 0,
  minRating = 0, minSales = 0, hasCoupon = false,
  sortBy = "discount_desc", page = 1, pageSize = 24,
  groupId, hideQueued = true, hideRecent = true,
} = {}, { signal } = {}) {
  const params = new URLSearchParams();
  if (categories && categories.length) params.set("categories", categories.join(","));
  if (sources && sources.length) params.set("sources", sources.join(","));
  if (groupId) {
    params.set("groupId", groupId);
    // Só o "0" desliga no backend — mandamos apenas quando é pra desligar.
    if (!hideQueued) params.set("hideQueued", "0");
    if (!hideRecent) params.set("hideRecent", "0");
  }
  if (q && q.trim()) params.set("q", q.trim());
  if (minPrice > 0) params.set("minPrice", minPrice);
  if (maxPrice) params.set("maxPrice", maxPrice);
  if (minDiscount > 0) params.set("minDiscount", minDiscount);
  if (minRating > 0) params.set("minRating", minRating);
  if (minSales > 0) params.set("minSales", minSales);
  // Só quando ligado: o backend lê "1"/"true" e ignora o resto, e mandar
  // "hasCoupon=false" à toa só sujaria a URL (e a chave de cache do navegador).
  if (hasCoupon) params.set("hasCoupon", "1");
  params.set("sortBy", sortBy);
  params.set("page", page);
  params.set("pageSize", pageSize);
  return http("GET", `/api/ofertas?${params}`, undefined, { signal });
}

export async function fetchStatus() {
  return http("GET", "/api/status");
}

// ─── WhatsApp / sessões ────────────────────────────────────────────────
export async function startWASession(id) { return http("POST", `/api/whatsapp/sessions/${id}`); }
export async function getWASession(id)   { return http("GET",  `/api/whatsapp/sessions/${id}`); }
export async function deleteWASession(id){ return http("DELETE", `/api/whatsapp/sessions/${id}`); }
// Versão pro unload da página: `keepalive` deixa o browser terminar a requisição
// depois que a aba já fechou. Sem isso, fechar a aba no meio do QR deixava uma
// sessão provisória viva no servidor, sob um id que não existe em `numbers` —
// invisível e irremovível pela tela. `sendBeacon` não serve: só faz POST e não
// carrega o header Authorization. Best-effort: erro aqui é ignorado (o backend
// tem a própria varredura de sessões órfãs).
export function deleteWASessionKeepalive(id) {
  try {
    const token = getToken();
    return fetch(`${API_BASE}/api/whatsapp/sessions/${id}`, {
      method: "DELETE",
      keepalive: true,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }).catch(() => {});
  } catch { return Promise.resolve(); }
}
export async function listWASessions()   { return http("GET",  `/api/whatsapp/sessions`); }
// Código de pareamento (alternativa ao QR). Timeout maior que o padrão: o backend
// espera o handshake do socket (até 20s) antes de conseguir pedir o código, e o
// RPC pro worker tem teto de 35s — o cliente precisa ser o último a desistir.
export async function requestWAPairingCode(id, phone) {
  return http("POST", `/api/whatsapp/sessions/${id}/pairing-code`, { phone }, { timeoutMs: 45_000 });
}

// ─── WhatsApp / grupos ─────────────────────────────────────────────────
export async function listWAGroups(id)   { return http("GET",  `/api/whatsapp/sessions/${id}/groups`); }
export async function createWAGroup(id, name, participants) {
  return http("POST", `/api/whatsapp/sessions/${id}/groups`, { name, participants });
}
export async function getWAInvite(id, jid) {
  return http("GET", `/api/whatsapp/sessions/${id}/groups/${encodeURIComponent(jid)}/invite`);
}
export async function revokeWAInvite(id, jid) {
  return http("POST", `/api/whatsapp/sessions/${id}/groups/${encodeURIComponent(jid)}/invite/revoke`);
}
export async function leaveWAGroup(id, jid) {
  return http("DELETE", `/api/whatsapp/sessions/${id}/groups/${encodeURIComponent(jid)}`);
}

// ─── WhatsApp / envio ──────────────────────────────────────────────────
export async function sendWAText(id, jid, text, imageUrl) {
  return http("POST", `/api/whatsapp/sessions/${id}/send`, { jid, text, imageUrl });
}
export async function broadcastWA(id, jids, text, imageUrl, intervalMs = 4000) {
  return http("POST", `/api/whatsapp/sessions/${id}/broadcast`, { jids, text, imageUrl, intervalMs });
}
// Teste de conexão do número: auto-DM pelo próprio número + DM do WhatsNimbus.
// Responde 200 com o veredito de cada perna ({ ok, self, whatsnimbus }); falha de
// perna NÃO é erro HTTP. 429 quando o cooldown de 60s ainda não passou.
// Timeout maior que o padrão: além dos dois envios, o backend espera alguns
// segundos pra saber se o aparelho pediu reenvio da mensagem de teste.
export async function testWASession(id) {
  return http("POST", `/api/whatsapp/sessions/${id}/test`, undefined, { timeoutMs: 60_000 });
}

// ─── Admin / usuários ──────────────────────────────────────────────────
export async function adminListUsers()           { return http("GET",    "/api/admin/users"); }
export async function adminDeleteUser(id)        { return http("DELETE", `/api/admin/users/${id}`); }
export async function adminSetUserPassword(id, newPassword) {
  return http("PATCH", `/api/admin/users/${id}/password`, { newPassword });
}
export async function adminSetUserRole(id, role) {
  return http("PATCH", `/api/admin/users/${id}/role`, { role });
}
export async function adminVerifyUserEmail(id) {
  return http("PATCH", `/api/admin/users/${id}/verify-email`);
}
export async function adminSetUserSuspended(id, suspended) {
  return http("PATCH", `/api/admin/users/${id}/suspend`, { suspended });
}
export async function adminResendUserVerification(id) {
  return http("POST", `/api/admin/users/${id}/resend-verification`);
}
export async function adminUserDetail(id)        { return http("GET", `/api/admin/users/${id}/detail`); }
// Trial manual (cortesia): libera um plano por N dias sem passar pelo Stripe.
export async function adminGrantManualTrial(id, { planId, days, note }) {
  return http("POST", `/api/admin/users/${id}/manual-trial`, { planId, days, note });
}
export async function adminRevokeManualTrial(id) {
  return http("DELETE", `/api/admin/users/${id}/manual-trial`);
}
export async function adminGetRegistration()        { return http("GET", "/api/admin/registration"); }
export async function adminSetRegistration(blocked) { return http("PUT", "/api/admin/registration", { blocked }); }

// ─── Admin / Stripe (modo teste ↔ produção) ────────────────────────────
export async function adminStripeGet()          { return http("GET", "/api/admin/stripe"); }
export async function adminStripeSetMode(mode)  { return http("PUT", "/api/admin/stripe", { mode }); }

// ─── Admin / Backups ───────────────────────────────────────────────────
export async function adminBackupsLocal()              { return http("GET",    "/api/admin/backups/local"); }
export async function adminBackupsRemote()             { return http("GET",    "/api/admin/backups/remote"); }
// Dump, upload pro B2 e restore levam minutos — teto maior.
export async function adminCreateLocalBackup()         { return http("POST",   "/api/admin/backups/local", undefined, { timeoutMs: SLOW_TIMEOUT_MS }); }
export async function adminPushBackup(filename)        { return http("POST",   "/api/admin/backups/push", { filename }, { timeoutMs: SLOW_TIMEOUT_MS }); }
export async function adminRestoreBackup(source, filename) { return http("POST", "/api/admin/backups/restore", { source, filename }, { timeoutMs: SLOW_TIMEOUT_MS }); }
export async function adminDeleteLocalBackup(filename) { return http("DELETE", `/api/admin/backups/local/${encodeURIComponent(filename)}`); }
export async function adminDeleteRemoteBackup(filename){ return http("DELETE", `/api/admin/backups/remote/${encodeURIComponent(filename)}`); }
export async function adminSystemDisk()                { return http("GET",    "/api/admin/system/disk"); }

// ─── Admin / scraper global e catálogo ─────────────────────────────────
export async function adminScraperConfig()       { return http("GET",  "/api/admin/scraper/config"); }
export async function adminSaveScraperConfig(cfg){ return http("PUT",  "/api/admin/scraper/config", cfg); }
export async function adminRunScraper({ resume = false } = {}) { return http("POST", "/api/admin/scraper/run", { resume }); }
export async function adminPauseScraper()        { return http("POST", "/api/admin/scraper/pause"); }
export async function adminCancelScraper()       { return http("POST", "/api/admin/scraper/cancel"); }
export async function adminScraperStatus()       { return http("GET",  "/api/admin/scraper/status"); }
export async function adminScraperShopee()           { return http("GET",    "/api/admin/scraper/shopee"); }
export async function adminScraperShopeeSave(body)   { return http("PUT",    "/api/admin/scraper/shopee", body); }
export async function adminScraperShopeeClear()      { return http("DELETE", "/api/admin/scraper/shopee"); }
export async function adminScraperShopeeTest(url)    { return http("POST",   "/api/admin/scraper/shopee/test", { url }, { timeoutMs: SLOW_TIMEOUT_MS }); }
export async function adminScraperShopeeFilters()        { return http("GET", "/api/admin/scraper/shopee/filters"); }
export async function adminScraperShopeeFiltersSave(f)   { return http("PUT", "/api/admin/scraper/shopee/filters", f); }
// Sessão do ML da conta do sistema (Hub de Afiliados) — não é o cookie de nenhum usuário.
export async function adminScraperMLSession()            { return http("GET",    "/api/admin/scraper/ml/session"); }
export async function adminScraperMLSessionSave(patch)   { return http("PUT",    "/api/admin/scraper/ml/session", patch); }
export async function adminScraperMLSessionClear()       { return http("DELETE", "/api/admin/scraper/ml/session"); }
export async function adminScraperMLSessionTest()        { return http("POST",   "/api/admin/scraper/ml/session/test", {}, { timeoutMs: SLOW_TIMEOUT_MS }); }
// Fontes de ofertas do ML: { vitrine, hub, priority }. O PUT aceita patch parcial.
export async function adminScraperMLSources()            { return http("GET", "/api/admin/scraper/ml/sources"); }
export async function adminScraperMLSourcesSave(patch)   { return http("PUT", "/api/admin/scraper/ml/sources", patch); }
export async function adminScraperMLFilters()            { return http("GET", "/api/admin/scraper/ml/filters"); }
export async function adminScraperMLFiltersSave(f)       { return http("PUT", "/api/admin/scraper/ml/filters", f); }
export async function adminScraperAmazonFilters()        { return http("GET", "/api/admin/scraper/amazon/filters"); }
export async function adminScraperAmazonFiltersSave(f)   { return http("PUT", "/api/admin/scraper/amazon/filters", f); }

// ─── Travas de loja (admin tranca, usuário vê só a mensagem) ───────────
export async function adminStoreLocks()                  { return http("GET", "/api/admin/stores/locks"); }
export async function adminStoreLockSave(store, body)    { return http("PUT", `/api/admin/stores/${encodeURIComponent(store)}/lock`, body); }
export async function storeLocks()                       { return http("GET", "/api/stores/locks"); }

// ScrapTester — monitor de saúde do scraping
export async function adminScrapTesterConfig()       { return http("GET",  "/api/admin/scrap-tester/config"); }
export async function adminScrapTesterSave(cfg)      { return http("PUT",  "/api/admin/scrap-tester/config", cfg); }
export async function adminScrapTesterStatus()       { return http("GET",  "/api/admin/scrap-tester/status"); }
export async function adminScrapTesterRun()          { return http("POST", "/api/admin/scrap-tester/run", undefined, { timeoutMs: SLOW_TIMEOUT_MS }); }
export async function adminScrapTesterCancel()       { return http("POST", "/api/admin/scrap-tester/cancel"); }
export async function adminScrapTesterHistory()      { return http("GET",  "/api/admin/scrap-tester/history"); }
export async function adminScrapTesterLink(url)      { return http("POST", "/api/admin/scrap-tester/link", { url }, { timeoutMs: SLOW_TIMEOUT_MS }); }

// Teste de cupom do ML (Admin › Cupom). Abre um Chrome de verdade e pode ir até o
// checkout, então demora tanto quanto o teste de acesso ao Hub — daí o SLOW.
export async function adminCouponTest(body)          { return http("POST", "/api/admin/ml-coupon/test", body, { timeoutMs: SLOW_TIMEOUT_MS }); }
export async function adminCouponHistory()           { return http("GET",  "/api/admin/ml-coupon/history"); }
// O mesmo teste, no Chrome do admin. O /start roda o caminho rápido (rápido de
// verdade: sem abrir nada); o /result recebe o material que a aba trouxe. Nenhum
// dos dois espera pelo ML, então nenhum precisa do SLOW.
export async function adminCouponLocalStart(body)  { return http("POST", "/api/admin/ml-coupon/local/start", body); }
export async function adminCouponLocalResult(body) { return http("POST", "/api/admin/ml-coupon/local/result", body, { timeoutMs: SLOW_TIMEOUT_MS }); }

// Cupons que o ML oferece para a conta do sistema (Admin › Cupom › Cupons do ML).
export async function adminMlCuponsStatus()          { return http("GET",  "/api/admin/ml-cupons/status"); }
export async function adminMlCuponsSaveConfig(cfg)   { return http("PUT",  "/api/admin/ml-cupons/config", cfg); }
// A fila da etapa 2: os cupons que ainda não têm vitrine, separados entre os que
// só precisam ser lidos e os que precisam do "Eu quero" antes.
export async function adminMlCuponsAlvosProdutos({ limit = 500, campaignId = null, soSemProdutos = false } = {}) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (campaignId) params.set("campaignId", campaignId);
  if (soSemProdutos) params.set("soSemProdutos", "1");
  return http("GET", `/api/admin/ml-cupons/alvos-produtos?${params}`);
}
// A varredura, tocada pelo Chrome do admin: a tela abre cada página pela extensão
// e manda o modelo cru pra cá. O servidor continua sendo quem decide onde parar,
// quem ativar e o que gravar — estas rotas só levam e trazem.
export async function adminMlCuponsLocalStart(body)  { return http("POST", "/api/admin/ml-cupons/local/start", body || {}); }
export async function adminMlCuponsLocalAtivar(body) { return http("POST", "/api/admin/ml-cupons/local/ativar", body); }
// Uma página da lista traz dezenas de cupons com o `raw` de cada um: é corpo
// grande e a gravação da última página roda o persistRun inteiro, daí o SLOW.
export async function adminMlCuponsLocalPagina(body) { return http("POST", "/api/admin/ml-cupons/local/pagina", body, { timeoutMs: SLOW_TIMEOUT_MS }); }
// A aba que terminou e quer a próxima página (task 21). Ver a rota `/local/proximas`.
export async function adminMlCuponsLocalProximas(body) { return http("POST", "/api/admin/ml-cupons/local/proximas", body || {}); }
// SLOW porque o fim GRAVA o que a varredura leu (inclusive ao Parar) — com milhares
// de cupons na lista, é a mesma gravação da última página.
export async function adminMlCuponsLocalFim(body)    { return http("POST", "/api/admin/ml-cupons/local/fim", body || {}, { timeoutMs: SLOW_TIMEOUT_MS }); }
// O balanço dos botões 2 e 3 (task 17): o laço é da tela, e o servidor só guarda
// o que ela manda para o "última vez" de cada botão sobreviver a um F5.
export async function adminMlCuponsRodadaFim(body)   { return http("POST", "/api/admin/ml-cupons/rodada-fim", body); }
// A agenda das etapas (backend/coupons/agenda.js): o que venceu, pegar para rodar,
// ou avisar que esta aba não pôde.
export async function adminMlCuponsAgendaPendentes()          { return http("GET",  "/api/admin/ml-cupons/agenda/pendentes"); }
export async function adminMlCuponsAgendaReivindicar(botao)   { return http("POST", "/api/admin/ml-cupons/agenda/reivindicar", { botao }); }
export async function adminMlCuponsAgendaFalhou(botao, motivo) { return http("POST", "/api/admin/ml-cupons/agenda/falhou", { botao, motivo }); }
// A palavra testada pela extensão: vai o material cru que a página do ML respondeu,
// volta o mesmo veredito de sempre. Rápido — quem esperou pelo ML foi o navegador.
export async function adminMlCuponsLocalPalavra(body) { return http("POST", "/api/admin/ml-cupons/local/palavra", body); }
// Apaga tudo que a aba guardou: cupons, vínculos e o carimbo no catálogo. As
// palavras já testadas ficam. Varre o catálogo inteiro, daí o SLOW.
export async function adminMlCuponsClearAll() { return http("DELETE", "/api/admin/ml-cupons", undefined, { timeoutMs: SLOW_TIMEOUT_MS }); }
// Apaga UM cupom: os vínculos dele e o carimbo que ele deixou no catálogo.
export async function adminMlCuponsDelete(campaignId) {
  return http("DELETE", `/api/admin/ml-cupons/${encodeURIComponent(campaignId)}`, undefined, { timeoutMs: SLOW_TIMEOUT_MS });
}
export async function adminMlCuponsCodes(limit = 50) { return http("GET",  `/api/admin/ml-cupons/codes?limit=${limit}`); }
// `source` marca de onde veio a palavra (`ml_coupon_codes.source`): "admin" quando
// alguém digitou, "repasse" quando a aba Repasse mandou testar um código pescado
// de grupo líder.
export async function adminMlCuponsTestWord(word, force = false, source = "admin") {
  return http("POST", "/api/admin/ml-cupons/code", { word, force, source }, { timeoutMs: SLOW_TIMEOUT_MS });
}
// Dispara a busca da campanha que uma palavra apontou. Responde na hora (202) — a
// varredura da lista do ML passa dos 90s do nginx, então ela roda solta e o
// desfecho vem pelo status abaixo. Timeout padrão de propósito: se ESTA chamada
// demorar, é sinal de problema, não de busca longa.
export async function adminMlCuponsImportCampaign(campaignId, withProducts = true) {
  return http("POST", `/api/admin/ml-cupons/${encodeURIComponent(campaignId)}/importar`, { withProducts });
}
export async function adminMlCuponsImportStatus() {
  return http("GET", "/api/admin/ml-cupons/importar/status");
}
export async function adminMlCuponsSyncProducts(campaignId) {
  return http("POST", `/api/admin/ml-cupons/${encodeURIComponent(campaignId)}/sync-produtos`, undefined, { timeoutMs: SLOW_TIMEOUT_MS });
}
// A vitrine colhida pela extensão no Chrome do admin (extension/ na raiz). O
// `parcial` é o campo caro: coleta interrompida (muro, teto de páginas) não pode
// entrar como lista fechada — o backend grava origem "landing" quando ele vem.
// `total` é quantos produtos a vitrine diz ter — o "200" do "45/200" da tabela.
export async function adminMlCuponsImportVitrine(campaignId, { products, parcial = false, carimbar = true, total = null } = {}) {
  return http("POST", `/api/admin/ml-cupons/${encodeURIComponent(campaignId)}/vitrine-local`, { products, parcial, carimbar, total }, { timeoutMs: SLOW_TIMEOUT_MS });
}
// O carimbo do catálogo que a etapa 2 adia com `carimbar: false` — uma vez por lote.
export async function adminMlCuponsCarimbar() {
  return http("POST", "/api/admin/ml-cupons/carimbar", {}, { timeoutMs: SLOW_TIMEOUT_MS });
}
// O passo final do diagnóstico da aba Config Test: pede ao servidor um link de
// afiliado do sistema pra uma URL de produto. É o que prova cookie E tag valendo
// contra o ML — os dois aparecem "salvos" na tela sem nenhum dos dois funcionar.
export async function adminMlCuponsDiagnosticoLink(url) {
  return http("POST", "/api/admin/ml-cupons/diagnostico/link", { url }, { timeoutMs: SLOW_TIMEOUT_MS });
}

export async function adminMlCuponsProducts(campaignId, { page = 1, pageSize = 50 } = {}) {
  return http("GET", `/api/admin/ml-cupons/${encodeURIComponent(campaignId)}/produtos?page=${page}&pageSize=${pageSize}`);
}
export async function adminMlCupons({ page = 1, pageSize = 50, q, scope, grouping, onlyActive, onlyValid, withCode, sortBy } = {}) {
  const params = new URLSearchParams();
  params.set("page", page);
  params.set("pageSize", pageSize);
  if (q) params.set("q", q);
  if (scope) params.set("scope", scope);
  if (grouping) params.set("grouping", grouping);
  if (onlyActive) params.set("onlyActive", "true");
  if (onlyValid) params.set("onlyValid", "true");
  if (withCode) params.set("withCode", "true");
  if (sortBy) params.set("sortBy", sortBy);
  return http("GET", `/api/admin/ml-cupons?${params}`);
}
// `cupom` (com | com-palavra | sem-palavra | sem), `cupomBusca` (id, palavra ou
// título) e `cupomOrigem` (vitrine | parcial | checkout) filtram pelo
// vínculo cupom ↔ produto; cada item volta com `coupons` (os vigentes).
export async function adminCatalog({ page = 1, pageSize = 50, category, source, q, sortBy, minDiscount, cupom, cupomBusca, cupomOrigem } = {}) {
  const params = new URLSearchParams();
  params.set("page", page);
  params.set("pageSize", pageSize);
  if (category) params.set("category", category);
  if (source) params.set("source", source);
  if (q) params.set("q", q);
  if (sortBy) params.set("sortBy", sortBy);
  if (minDiscount > 0) params.set("minDiscount", minDiscount);
  if (cupom) params.set("cupom", cupom);
  if (cupomBusca) params.set("cupomBusca", cupomBusca);
  if (cupomOrigem) params.set("cupomOrigem", cupomOrigem);
  return http("GET", `/api/admin/catalog?${params}`);
}
export async function adminClearCatalog() { return http("DELETE", "/api/admin/catalog"); }

// ─── Admin / Repasse (log de captura) ──────────────────────────────────
export async function adminRepasseLogs({ page = 1, pageSize = 50, userId, groupId, store, outcome, errorKind, stage, coupon } = {}) {
  const params = new URLSearchParams();
  params.set("page", page);
  params.set("pageSize", pageSize);
  if (userId) params.set("userId", userId);
  if (groupId) params.set("groupId", groupId);
  if (store) params.set("store", store);
  if (outcome) params.set("outcome", outcome);
  if (errorKind) params.set("errorKind", errorKind);
  if (stage) params.set("stage", stage);
  // As capturas de UM cupom — o que a aba Admin › Cupom › Repasse abre ao
  // expandir uma linha.
  if (coupon) params.set("coupon", coupon);
  return http("GET", `/api/admin/repasse/logs?${params}`);
}

// Os cupons capturados pelo repasse, um por linha (Admin › Cupom › Repasse).
// `days` aceita "tudo"; `status` é um dos de repasse/coupons.js STATUS.
export async function adminRepasseCoupons({ page = 1, pageSize = 50, days = 90, status = "todos", q = "" } = {}) {
  const params = new URLSearchParams();
  params.set("page", page);
  params.set("pageSize", pageSize);
  params.set("days", days);
  if (status) params.set("status", status);
  if (q) params.set("q", q);
  return http("GET", `/api/admin/repasse/coupons?${params}`);
}

// Esquecer um cupom capturado: a coluna `coupon` das capturas dele vai a null.
// As capturas ficam no log de Admin › Repasse e a palavra testada continua no
// dicionário — some só o código, da lista desta aba.
export async function adminRepasseCouponForget(code) {
  return http("DELETE", `/api/admin/repasse/coupons/${encodeURIComponent(code)}`);
}

// O mesmo, para todos os cupons que o filtro atual mostra.
export async function adminRepasseCouponsClear({ days = 90, status = "todos", q = "" } = {}) {
  const params = new URLSearchParams();
  params.set("days", days);
  if (status) params.set("status", status);
  if (q) params.set("q", q);
  return http("DELETE", `/api/admin/repasse/coupons?${params}`);
}

// "Quais cupons valem neste produto?" — só o que o sistema já sabe, sem rede.
export async function adminProdutoCupons({ url = "", key = "" } = {}) {
  const params = new URLSearchParams();
  if (url) params.set("url", url);
  if (key) params.set("key", key);
  return http("GET", `/api/admin/produtos/cupons?${params}`);
}

// A sonda do checkout: manda pro servidor guardar o que a extensão fotografou.
export async function adminSondaCheckoutCupons({ url, material }) {
  return http("POST", "/api/admin/ml-cupons/sonda-checkout", { url, material });
}

// A sonda em LOTE (task 13): a fila dos produtos do scraping, já ordenada pelo
// servidor, e o resultado de cada produto sondado.
export async function adminSondaLoteAlvos({ categorias = [], limite = 20, pularDias = 7, soSemCupom = false } = {}) {
  const params = new URLSearchParams({ limite: String(limite), pularDias: String(pularDias) });
  if (categorias.length) params.set("categorias", categorias.join(","));
  if (soSemCupom) params.set("soSemCupom", "1");
  return http("GET", `/api/admin/ml-cupons/sonda-lote/alvos?${params}`);
}

export async function adminSondaLoteResultado({ key, url, material = null, erro = null }) {
  return http("POST", "/api/admin/ml-cupons/sonda-lote/resultado", { key, url, material, erro });
}

// O ritmo do lote (abas em paralelo, pausa, tempos da sonda). GET devolve
// { config, defaults, faixas }; PUT grava o que mudou e devolve { config }.
// O histórico das execuções do lote: GET { runs } (a mais nova primeiro); POST grava
// o resumo de uma execução que terminou.
export async function adminSondaLoteRuns() {
  return http("GET", "/api/admin/ml-cupons/sonda-lote/runs");
}

export async function adminSondaLoteRegistrarRun(run) {
  return http("POST", "/api/admin/ml-cupons/sonda-lote/runs", run);
}

export async function adminSondaLoteConfig() {
  return http("GET", "/api/admin/ml-cupons/sonda-lote/config");
}

export async function adminSondaLoteSalvarConfig(patch) {
  return http("PUT", "/api/admin/ml-cupons/sonda-lote/config", patch);
}

// ─── Admin / Repasse (teste automático de cupom) ───────────────────────
// O robô que testa no ML a palavra pescada na legenda e traz a campanha pro
// sistema. GET devolve config + defaults + o status da última rodada juntos —
// a tela mostra os três no mesmo card, e separá-los em duas chamadas só daria
// chance de o painel abrir com a config nova e o status velho.
export async function adminRepasseAutotest() {
  return http("GET", "/api/admin/repasse/coupon-autotest");
}

export async function adminRepasseAutotestSave(config) {
  return http("PUT", "/api/admin/repasse/coupon-autotest", config);
}

// "Rodar agora": responde 202 e a rodada segue solta (é Chrome por palavra, passa
// do timeout do proxy). Quem acompanha é o status + o log.
export async function adminRepasseAutotestRun() {
  return http("POST", "/api/admin/repasse/coupon-autotest/run", {});
}

// O diário do robô: uma linha por tentativa. `code` filtra o histórico de um cupom.
export async function adminRepasseAutotestLog({ page = 1, pageSize = 20, code = "" } = {}) {
  const params = new URLSearchParams();
  params.set("page", page);
  params.set("pageSize", pageSize);
  if (code) params.set("code", code);
  return http("GET", `/api/admin/repasse/coupon-autotest/log?${params}`);
}

// O teste do cupom no checkout do produto (task 7): a fila que a aba do Repasse
// consome pela extensão, e o material que ela devolve.
export async function adminRepasseCupomCheckoutPendentes({ limit = 50 } = {}) {
  return http("GET", `/api/admin/repasse/cupom-checkout/pendentes?limit=${limit}`);
}

export async function adminRepasseCupomCheckoutAuto(auto) {
  return http("PUT", "/api/admin/repasse/cupom-checkout/auto", { auto: !!auto });
}

// Um teste pedido à mão: link do produto + código. Entra no começo da fila.
export async function adminRepasseCupomCheckoutManual({ code, url }) {
  return http("POST", "/api/admin/repasse/cupom-checkout/manual", { code, url });
}

export async function adminRepasseCupomCheckoutManualRemover(id) {
  return http("DELETE", `/api/admin/repasse/cupom-checkout/manual/${encodeURIComponent(id)}`);
}

export async function adminRepasseCupomCheckoutReivindicar(code) {
  return http("POST", "/api/admin/repasse/cupom-checkout/reivindicar", { code });
}

export async function adminRepasseCupomCheckoutResultado({ code, url, material, source, durationMs, manualId = null }) {
  return http("POST", "/api/admin/repasse/cupom-checkout/resultado", { code, url, material, source, durationMs, manualId });
}

// Resumo da janela (1h/24h/7d): totais por resultado, por motivo e taxa por loja.
export async function adminRepasseSummary({ hours = 24, userId, groupId, store } = {}) {
  const params = new URLSearchParams();
  params.set("hours", hours);
  if (userId) params.set("userId", userId);
  if (groupId) params.set("groupId", groupId);
  if (store) params.set("store", store);
  return http("GET", `/api/admin/repasse/summary?${params}`);
}

// Palavras que fazem a captura reconhecer um cupom escrito na legenda. O GET
// devolve { config, defaults } — os defaults alimentam o "Restaurar padrão".
export async function adminRepasseCouponConfig()      { return http("GET", "/api/admin/repasse/coupon-config"); }
export async function adminRepasseCouponConfigSave(config) { return http("PUT", "/api/admin/repasse/coupon-config", config); }
// Testa com a config do formulário (ainda não salva) — daí ela ir no corpo.
export async function adminRepasseCouponTest(text, config) { return http("POST", "/api/admin/repasse/coupon-config/test", { text, config }); }

// ─── Layout (paleta de cores, global) ──────────────────────────────────
// A leitura é pública: a tela de login precisa da paleta antes do login.
export async function layoutGet()                 { return http("GET",  "/api/layout"); }
// Última paleta conhecida, pra pintar a tela já na primeira renderização em vez
// de esperar a resposta do servidor (ver o script inline no index.html).
export const PALETTE_CACHE_KEY = "nimbus_palette";
export async function adminLayoutSave(palette)    { return http("PUT",  "/api/admin/layout", { palette }); }

// ─── Admin / Notificações WhatsApp ─────────────────────────────────────
export async function adminNotifConfig()          { return http("GET",  "/api/admin/notifications/config"); }
export async function adminNotifSave(cfg)         { return http("PUT",  "/api/admin/notifications/config", cfg); }
export async function adminNotifTest()            { return http("POST", "/api/admin/notifications/test"); }
export async function adminNotifGroups()          { return http("GET",  "/api/admin/whatsnimbus/groups"); }
export async function adminNotifTemplates()               { return http("GET",  "/api/admin/notifications/templates"); }
export async function adminNotifTemplatesSave(t)         { return http("PUT",  "/api/admin/notifications/templates", { templates: t }); }
export async function adminNotifTemplatePreview(key, text) { return http("POST", "/api/admin/notifications/templates/preview", { key, text }); }

// ─── Tutoriais ─────────────────────────────────────────────────────────────
// A leitura é de qualquer usuário logado; a escrita manda a árvore INTEIRA
// (seções + tutoriais na ordem em que devem aparecer) e só o admin passa.
export async function tutoriaisGet()                 { return http("GET", "/api/tutoriais"); }
export async function adminTutoriaisSave(sections)   { return http("PUT", "/api/admin/tutoriais", { sections }); }

// ─── Admin / Modelos de e-mail ─────────────────────────────────────────────
export async function adminEmailTemplates()          { return http("GET",  "/api/admin/emails/templates"); }
export async function adminEmailTemplatesSave(t)     { return http("PUT",  "/api/admin/emails/templates", { templates: t }); }
export async function adminEmailPreview(key, block)  { return http("POST", "/api/admin/emails/preview", { key, block }); }
export async function adminEmailTest(key, block)     { return http("POST", "/api/admin/emails/test", { key, block }); }

// ─── Admin / WhatsNimbus (remetente do sistema) ────────────────────────────
export async function whatsNimbusStatus()         { return http("GET",  "/api/admin/whatsnimbus"); }
export async function whatsNimbusConnect()        { return http("POST", "/api/admin/whatsnimbus/connect"); }
export async function whatsNimbusFinalize(info)   { return http("POST", "/api/admin/whatsnimbus/finalize", info); }
export async function whatsNimbusDisconnect()     { return http("POST", "/api/admin/whatsnimbus/disconnect"); }
export async function whatsNimbusGroups()         { return http("GET",  "/api/admin/whatsnimbus/groups"); }
export async function whatsNimbusSend(payload)    { return http("POST", "/api/admin/whatsnimbus/send", payload); }

// ─── Admin / Downloader (vídeos do TikTok e do YouTube) ────────────────────
// Os links de arquivo e de .zip NÃO passam por aqui: são <a href> puros, que
// não conseguem mandar header. Eles usam a chave do job (ver DownloadPanel.jsx).
export async function adminDlHealth()              { return http("GET",  "/api/admin/downloader/health"); }
export async function adminDlList(params)          { return http("POST", "/api/admin/downloader/list", params, { timeoutMs: VERY_SLOW_TIMEOUT_MS }); }
export async function adminDlProducts(url)         { return http("POST", "/api/admin/downloader/products", { url }); }
export async function adminDlTemplates()           { return http("GET",  "/api/admin/downloader/templates"); }
export async function adminDlTemplateSave(id, t)   { return http("PUT",  `/api/admin/downloader/templates/${encodeURIComponent(id)}`, t); }
export async function adminDlTemplateRemove(id)    { return http("DELETE", `/api/admin/downloader/templates/${encodeURIComponent(id)}`); }
export async function adminDlJobCreate(payload)    { return http("POST", "/api/admin/downloader/jobs", payload, { timeoutMs: SLOW_TIMEOUT_MS }); }
export async function adminDlJob(id)               { return http("GET",  `/api/admin/downloader/jobs/${encodeURIComponent(id)}`); }
export async function adminDlUpdateYtdlp()         { return http("POST", "/api/admin/downloader/update-ytdlp", undefined, { timeoutMs: VERY_SLOW_TIMEOUT_MS }); }
