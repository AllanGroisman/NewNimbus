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
// Regra adotada: só http/https e o host precisa resolver pra IP público — sempre.
// Ser de loja conhecida é cobrado na URL de ENTRADA e no DESTINO FINAL.
//
// Os saltos do MEIO de um redirect só precisam do mínimo anti-SSRF. Antes eles
// também tinham que ser de loja, e isso quebrava encurtador encadeado — que é o
// normal em link de afiliado: link.amazon → amzlinks.in → amazon.com.br morria no
// salto do meio e voltava a URL curta, sem ASIN pra reafiliar. O que a checagem de
// loja no meio protegia (o servidor buscar um endereço qualquer) continua coberto
// pelo assertPublicHost em todo salto, e o destino ainda tem que ser uma loja.

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
  "link.amazon": "Amazon",
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

const UNKNOWN_STORE_MSG =
  "Link não reconhecido. Aceito links de Mercado Livre, Amazon, Shopee, Americanas e Magazine Luiza.";

// Forma da URL, sem tocar na rede: só http(s) e sem credencial embutida
// (user:senha@host confunde a leitura do host — não há caso legítimo aqui).
function parseFetchableUrl(rawUrl) {
  let u;
  try {
    u = new URL(String(rawUrl || "").trim());
  } catch {
    throw new Error("URL inválida");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("Só aceito links http ou https");
  }
  if (u.username || u.password) {
    throw new Error("URL inválida");
  }
  return u;
}

// O mínimo pra o servidor poder buscar a URL: forma válida e host público.
// Não exige loja — é o que vale pros saltos do meio de um redirect.
async function assertPublicUrl(rawUrl) {
  const u = parseFetchableUrl(rawUrl);
  await assertPublicHost(u.hostname);
  return { url: u.href };
}

// Validação completa. Lança Error com mensagem amigável, ou devolve
// { url, store } com a URL já normalizada. A loja é conferida ANTES do DNS:
// link de fora de loja é o caso comum e não merece uma consulta de rede.
async function assertStoreUrl(rawUrl) {
  const u = parseFetchableUrl(rawUrl);
  const store = detectStore(u.href);
  if (!store) {
    throw new Error(UNKNOWN_STORE_MSG);
  }
  await assertPublicHost(u.hostname);
  return { url: u.href, store };
}

// fetch que segue redirect manualmente, validando cada salto. Necessário porque
// encurtador de loja pode redirecionar pra qualquer lugar — inclusive interno.
// Entrada e destino final: loja conhecida. Saltos do meio: só host público
// (ver o cabeçalho do arquivo pra o porquê da diferença).
async function safeFetchFollow(rawUrl, { headers = {}, signal, maxHops = 5 } = {}) {
  let current = (await assertStoreUrl(rawUrl)).url;

  for (let hop = 0; hop <= maxHops; hop++) {
    const res = await fetch(current, { method: "GET", redirect: "manual", headers, signal });
    const location = res.headers.get("location");
    if (!location || res.status < 300 || res.status >= 400) {
      // Parou de redirecionar: aqui a exigência volta a ser a da entrada. Um
      // encurtador que termine fora das lojas não vira produto nenhum.
      if (!detectStore(current)) {
        try { await res.body?.cancel?.(); } catch { /* ignore */ }
        throw new Error(UNKNOWN_STORE_MSG);
      }
      return { res, finalUrl: current };
    }
    try { await res.body?.cancel?.(); } catch { /* ignore */ }
    const next = new URL(location, current).href;
    current = (await assertPublicUrl(next)).url;
  }
  throw new Error("Link com redirecionamentos demais");
}

module.exports = {
  STORE_DOMAINS,
  detectStore,
  isPrivateAddress,
  assertPublicHost,
  assertPublicUrl,
  assertStoreUrl,
  safeFetchFollow,
};
