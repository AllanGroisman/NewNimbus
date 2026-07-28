// Validação de URL antes de o servidor buscar qualquer coisa por conta própria.
//
// Dois pontos do sistema pegam uma URL de fora e fazem o servidor acessá-la:
//   1. POST /api/scraper/fetch-url  — link colado por um usuário logado
//   2. repasse/capture.js           — link vindo de mensagem de WhatsApp (sem login)
//
// Sem filtro, dá pra apontar esses fluxos pra dentro da própria infra
// (http://127.0.0.1:3001, metadata de nuvem em 169.254.169.254, Redis, Postgres)
// e ler o resultado — o servidor vira um proxy pra rede interna (SSRF).
//
// Regra adotada: só http/https, só domínios de loja conhecidos, e o host precisa
// resolver pra IP público. Em redirect, cada salto é validado de novo.

const dns = require("dns").promises;
const net = require("net");

// Sufixo de domínio → loja. Casa o domínio exato ou subdomínio dele
// ("shopee.com.br" e "s.shopee.com.br" passam; "shopee.com.br.evil.com" não).
const STORE_DOMAINS = {
  "mercadolivre.com.br": "Mercado Livre",
  "mercadolivre.com": "Mercado Livre",
  "mercadolibre.com": "Mercado Livre",
  "mercadolibre.com.ar": "Mercado Livre",
  "merc.li": "Mercado Livre",
  "mlb.li": "Mercado Livre",
  "meli.la": "Mercado Livre",
  "amazon.com.br": "Amazon",
  "amazon.com": "Amazon",
  "amzn.to": "Amazon",
  "amzn.eu": "Amazon",
  "a.co": "Amazon",
  "shopee.com.br": "Shopee",
  "shopee.com": "Shopee",
  "shp.ee": "Shopee",
  "americanas.com.br": "Americanas",
  "magazineluiza.com.br": "Magazine Luiza",
  "magazinevoce.com.br": "Magazine Luiza",
  "magalu.com": "Magazine Luiza",
};

function normalizeHost(hostname) {
  return String(hostname || "").toLowerCase().replace(/\.$/, "");
}

// Nome da loja, ou null se o host não for de nenhuma loja conhecida.
function detectStore(url) {
  let host;
  try {
    host = normalizeHost(new URL(url).hostname);
  } catch {
    return null;
  }
  if (!host) return null;
  for (const [domain, store] of Object.entries(STORE_DOMAINS)) {
    if (host === domain || host.endsWith(`.${domain}`)) return store;
  }
  return null;
}

// Faixas que nunca devem ser alvo: loopback, redes privadas, link-local
// (169.254.169.254 é o metadata das nuvens), CGNAT e afins.
function isPrivateAddress(ip) {
  const v = net.isIP(ip);
  if (v === 4) {
    const p = ip.split(".").map(Number);
    if (p[0] === 0 || p[0] === 10 || p[0] === 127) return true;
    if (p[0] === 169 && p[1] === 254) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;
    if (p[0] === 192 && p[1] === 0 && p[2] === 0) return true;
    if (p[0] >= 224) return true; // multicast e reservados
    return false;
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    if (s === "::" || s === "::1") return true;
    if (s.startsWith("fe80") || s.startsWith("fc") || s.startsWith("fd")) return true;
    // IPv4 mapeado (::ffff:127.0.0.1) — checa a parte v4.
    const m = s.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return isPrivateAddress(m[1]);
    return false;
  }
  return true; // não é IP válido → trata como suspeito
}

// Confere que o host resolve só pra IPs públicos.
async function assertPublicHost(hostname) {
  const host = normalizeHost(hostname);
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) {
      throw new Error("URL aponta para um endereço interno");
    }
    return;
  }
  let addrs;
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    throw new Error("Não consegui resolver o endereço do link");
  }
  if (!addrs.length || addrs.some(a => isPrivateAddress(a.address))) {
    throw new Error("URL aponta para um endereço interno");
  }
}

// Validação completa. Lança Error com mensagem amigável, ou devolve
// { url, store } com a URL já normalizada.
async function assertStoreUrl(rawUrl) {
  let u;
  try {
    u = new URL(String(rawUrl || "").trim());
  } catch {
    throw new Error("URL inválida");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("Só aceito links http ou https");
  }
  // user:senha@host confunde a leitura do host — não há caso legítimo aqui.
  if (u.username || u.password) {
    throw new Error("URL inválida");
  }
  const store = detectStore(u.href);
  if (!store) {
    throw new Error(
      "Link não reconhecido. Aceito links de Mercado Livre, Amazon, Shopee, Americanas e Magazine Luiza."
    );
  }
  await assertPublicHost(u.hostname);
  return { url: u.href, store };
}

// fetch que segue redirect manualmente, validando cada salto. Necessário porque
// encurtador de loja pode redirecionar pra qualquer lugar — inclusive interno.
async function safeFetchFollow(rawUrl, { headers = {}, signal, maxHops = 5 } = {}) {
  let current = (await assertStoreUrl(rawUrl)).url;

  for (let hop = 0; hop <= maxHops; hop++) {
    const res = await fetch(current, { method: "GET", redirect: "manual", headers, signal });
    const location = res.headers.get("location");
    if (!location || res.status < 300 || res.status >= 400) {
      return { res, finalUrl: current };
    }
    try { await res.body?.cancel?.(); } catch { /* ignore */ }
    const next = new URL(location, current).href;
    current = (await assertStoreUrl(next)).url;
  }
  throw new Error("Link com redirecionamentos demais");
}

module.exports = {
  STORE_DOMAINS,
  detectStore,
  isPrivateAddress,
  assertPublicHost,
  assertStoreUrl,
  safeFetchFollow,
};
