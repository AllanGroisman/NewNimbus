const API_BASE = "";

async function http(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${API_BASE}${path}`, opts);
  if (!res.ok) {
    let detail = res.statusText;
    try { const j = await res.json(); detail = j.error || j.details || detail; } catch {}
    throw new Error(detail || `Falha ${method} ${path}`);
  }
  return res.json();
}

// ─── Scraping ──────────────────────────────────────────────────────────
export async function fetchOfertas({ category, minDiscount = 0, maxPrice, limit = 50, refresh = false } = {}) {
  const params = new URLSearchParams();
  if (category) params.set("category", category);
  if (minDiscount > 0) params.set("minDiscount", minDiscount);
  if (maxPrice) params.set("maxPrice", maxPrice);
  if (limit) params.set("limit", limit);
  if (refresh) params.set("refresh", "true");
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
