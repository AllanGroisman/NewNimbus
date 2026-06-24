const API_BASE = "";
const TOKEN_KEY = "nimbus.token";

// ─── Token (localStorage) ──────────────────────────────────────────────
export function getToken() {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
export function setToken(t) {
  try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch {}
}
export function clearToken() { setToken(null); }

async function http(method, path, body, { signal } = {}) {
  const opts = { method, headers: {} };
  const token = getToken();
  if (token) opts.headers["Authorization"] = `Bearer ${token}`;
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  if (signal) opts.signal = signal;
  const res = await fetch(`${API_BASE}${path}`, opts);
  if (res.status === 401) {
    clearToken();
    // notifica a app que o token caiu
    window.dispatchEvent(new CustomEvent("nimbus:unauthorized"));
  }
  if (!res.ok) {
    let detail = res.statusText;
    let code = null;
    let extra = {};
    try { const j = await res.json(); detail = j.error || j.details || detail; code = j.code || null; extra = j; } catch {}
    const err = new Error(detail || `Falha ${method} ${path}`);
    if (code) err.code = code;
    if (extra.retryAfterSeconds) err.retryAfterSeconds = extra.retryAfterSeconds;
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// ─── Auth ──────────────────────────────────────────────────────────────
export async function authRegister({ name, email, password }) {
  // Backend não devolve token — precisa verificar email primeiro.
  return http("POST", "/api/auth/register", { name, email, password });
}
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
export async function authUpdate(updates) {
  return http("PATCH", "/api/auth/me", updates);
}
export async function authChangePassword({ currentPassword, newPassword }) {
  return http("POST", "/api/auth/password", { currentPassword, newPassword });
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
  return http("POST", `/api/state/groups/${groupId}/refill`, overrides || {}, { signal });
}
// Busca metadados de uma URL (scraping on-demand) — pré-preenche o form de manual add
export async function fetchUrlMetadata(url) {
  return http("POST", "/api/scraper/fetch-url", { url });
}
// Adiciona um produto manualmente à fila/pending da campanha.
// `payload` = { url, overrides: { name, price, originalPrice, discount, img, store, category }, force? }
// Tratamento especial: 409 (duplicata) é jogado como erro com code; cooldown vem como { inCooldown: true } no JSON.
export async function manualAddToQueue(groupId, payload) {
  return http("POST", `/api/state/groups/${groupId}/manual-add`, payload || {});
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
// Status atual: { planId, effectivePlan, status, currentPeriodEnd, daysLeftInTrial, limits, stripeEnabled }
export async function billingMe() {
  return http("GET", "/api/billing/me");
}
// Cria Checkout Session e devolve { url } — frontend chama window.location.assign(url)
export async function billingCheckout(planId) {
  return http("POST", "/api/billing/checkout", { planId });
}
// Customer Portal — alterar cartão / cancelar / ver faturas
export async function billingPortal() {
  return http("POST", "/api/billing/portal");
}

// ─── Afiliados ML ──────────────────────────────────────────────────────
export async function getAffiliateStatus()      { return http("GET",    "/api/affiliate"); }
export async function saveAffiliate(payload)    { return http("PUT",    "/api/affiliate", payload); }
export async function clearAffiliate()          { return http("DELETE", "/api/affiliate"); }
export async function testAffiliate(url)        { return http("POST",   "/api/affiliate/test", url ? { url } : {}); }

// ─── Afiliados Amazon ──────────────────────────────────────────────────
export async function saveAmazonAffiliate(tag)  { return http("PUT",    "/api/affiliate/amazon", { tag }); }
export async function clearAmazonAffiliate()    { return http("DELETE", "/api/affiliate/amazon"); }
export async function testAmazonAffiliate(url)  { return http("POST",   "/api/affiliate/amazon/test", url ? { url } : {}); }

// ─── Afiliados Shopee ──────────────────────────────────────────────────
export async function saveShopeeAffiliate({ appId, appSecret }) { return http("PUT",    "/api/affiliate/shopee", { appId, appSecret }); }
export async function clearShopeeAffiliate()                    { return http("DELETE", "/api/affiliate/shopee"); }
export async function testShopeeAffiliate(url)                  { return http("POST",   "/api/affiliate/shopee/test", url ? { url } : {}); }

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

export async function fetchStatus() {
  return http("GET", "/api/status");
}

// ─── WhatsApp / sessões ────────────────────────────────────────────────
export async function startWASession(id) { return http("POST", `/api/whatsapp/sessions/${id}`); }
export async function getWASession(id)   { return http("GET",  `/api/whatsapp/sessions/${id}`); }
export async function deleteWASession(id){ return http("DELETE", `/api/whatsapp/sessions/${id}`); }
export async function listWASessions()   { return http("GET",  `/api/whatsapp/sessions`); }

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

// ─── Admin / Backups ───────────────────────────────────────────────────
export async function adminBackupsLocal()              { return http("GET",    "/api/admin/backups/local"); }
export async function adminBackupsRemote()             { return http("GET",    "/api/admin/backups/remote"); }
export async function adminCreateLocalBackup()         { return http("POST",   "/api/admin/backups/local"); }
export async function adminPushBackup(filename)        { return http("POST",   "/api/admin/backups/push", { filename }); }
export async function adminRestoreBackup(source, filename) { return http("POST", "/api/admin/backups/restore", { source, filename }); }
export async function adminDeleteLocalBackup(filename) { return http("DELETE", `/api/admin/backups/local/${encodeURIComponent(filename)}`); }
export async function adminDeleteRemoteBackup(filename){ return http("DELETE", `/api/admin/backups/remote/${encodeURIComponent(filename)}`); }

// ─── Admin / scraper global e catálogo ─────────────────────────────────
export async function adminScraperConfig()       { return http("GET",  "/api/admin/scraper/config"); }
export async function adminSaveScraperConfig(cfg){ return http("PUT",  "/api/admin/scraper/config", cfg); }
export async function adminRunScraper()          { return http("POST", "/api/admin/scraper/run"); }
export async function adminCancelScraper()       { return http("POST", "/api/admin/scraper/cancel"); }
export async function adminScraperStatus()       { return http("GET",  "/api/admin/scraper/status"); }
export async function adminScraperShopee()           { return http("GET",    "/api/admin/scraper/shopee"); }
export async function adminScraperShopeeSave(body)   { return http("PUT",    "/api/admin/scraper/shopee", body); }
export async function adminScraperShopeeClear()      { return http("DELETE", "/api/admin/scraper/shopee"); }
export async function adminScraperShopeeTest(url)    { return http("POST",   "/api/admin/scraper/shopee/test", { url }); }
export async function adminScraperShopeeFilters()        { return http("GET", "/api/admin/scraper/shopee/filters"); }
export async function adminScraperShopeeFiltersSave(f)   { return http("PUT", "/api/admin/scraper/shopee/filters", f); }
export async function adminScraperMLFilters()            { return http("GET", "/api/admin/scraper/ml/filters"); }
export async function adminScraperMLFiltersSave(f)       { return http("PUT", "/api/admin/scraper/ml/filters", f); }
export async function adminScraperAmazonFilters()        { return http("GET", "/api/admin/scraper/amazon/filters"); }
export async function adminScraperAmazonFiltersSave(f)   { return http("PUT", "/api/admin/scraper/amazon/filters", f); }
export async function adminCatalog({ page = 1, pageSize = 50, category, source, q, sortBy } = {}) {
  const params = new URLSearchParams();
  params.set("page", page);
  params.set("pageSize", pageSize);
  if (category) params.set("category", category);
  if (source) params.set("source", source);
  if (q) params.set("q", q);
  if (sortBy) params.set("sortBy", sortBy);
  return http("GET", `/api/admin/catalog?${params}`);
}
export async function adminClearCatalog() { return http("DELETE", "/api/admin/catalog"); }

// ─── Admin / Notificações WhatsApp ─────────────────────────────────────
export async function adminNotifConfig()          { return http("GET",  "/api/admin/notifications/config"); }
export async function adminNotifSave(cfg)         { return http("PUT",  "/api/admin/notifications/config", cfg); }
export async function adminNotifTest()            { return http("POST", "/api/admin/notifications/test"); }
export async function adminNotifGroups(numberId)  { return http("GET",  `/api/whatsapp/sessions/${encodeURIComponent(numberId)}/groups`); }
