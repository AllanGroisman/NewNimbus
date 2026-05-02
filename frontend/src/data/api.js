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

async function http(method, path, body) {
  const opts = { method, headers: {} };
  const token = getToken();
  if (token) opts.headers["Authorization"] = `Bearer ${token}`;
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${API_BASE}${path}`, opts);
  if (res.status === 401) {
    clearToken();
    // notifica a app que o token caiu
    window.dispatchEvent(new CustomEvent("nimbus:unauthorized"));
  }
  if (!res.ok) {
    let detail = res.statusText;
    try { const j = await res.json(); detail = j.error || j.details || detail; } catch {}
    throw new Error(detail || `Falha ${method} ${path}`);
  }
  return res.json();
}

// ─── Auth ──────────────────────────────────────────────────────────────
export async function authRegister({ name, email, password, phone }) {
  const r = await http("POST", "/api/auth/register", { name, email, password, phone });
  if (r.token) setToken(r.token);
  return r;
}
export async function authLogin({ email, password }) {
  const r = await http("POST", "/api/auth/login", { email, password });
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

// ─── Afiliados ML ──────────────────────────────────────────────────────
export async function getAffiliateStatus()      { return http("GET",    "/api/affiliate"); }
export async function saveAffiliate(payload)    { return http("PUT",    "/api/affiliate", payload); }
export async function clearAffiliate()          { return http("DELETE", "/api/affiliate"); }
export async function testAffiliate(url)        { return http("POST",   "/api/affiliate/test", url ? { url } : {}); }

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
