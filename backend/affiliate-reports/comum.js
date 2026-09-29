// O que os relatórios de desempenho de afiliado (ML, Shopee) têm em comum:
// o erro tipado que a rota devolve, as contas de data e o cache curto por
// usuário+período.

class DesempenhoError extends Error {
  constructor(kind, message, status = 502) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

// ────────────────────────────────────────────────────────────────────────
// Datas (dias "AAAA-MM-DD", contados ao meio-dia UTC pra fugir de fuso)
// ────────────────────────────────────────────────────────────────────────

const DIA_RE = /^\d{4}-\d{2}-\d{2}$/;

function somaDias(dia, n) {
  const d = new Date(`${dia}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function diasEntre(from, to) {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000);
}

// Formato e ordem do período. Devolve null quando está ok, ou o motivo.
function validaFormato(from, to) {
  if (!DIA_RE.test(String(from || "")) || !DIA_RE.test(String(to || ""))) return "Período inválido — use datas no formato AAAA-MM-DD.";
  if (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) return "Período inválido.";
  if (from > to) return "A data inicial é depois da final.";
  return null;
}

// ────────────────────────────────────────────────────────────────────────
// Cache
// ────────────────────────────────────────────────────────────────────────

// As lojas atualizam os números devagar; 15 min de cache poupa a API de quem
// fica trocando de período, e o "Atualizar" da tela fura o cache (com freio:
// no máximo uma vez por minuto por período — o botão não vira martelo).
const CACHE_TTL_MS = 15 * 60 * 1000;
const REFRESH_MIN_MS = 60 * 1000;
const CACHE_MAX = 500;

// Um cache por loja: `criaCache()` → `cacheado(chave, { refresh, now }, busca)`.
// `busca()` só roda quando o guardado não serve; se ela lança, nada é guardado.
function criaCache() {
  const cache = new Map();   // chave → { ts, data }
  async function cacheado(chave, { refresh = false, now = Date.now() } = {}, busca) {
    const guardado = cache.get(chave);
    if (guardado) {
      const idade = now - guardado.ts;
      if (idade < REFRESH_MIN_MS || (!refresh && idade < CACHE_TTL_MS)) {
        return { ...guardado.data, fetchedAt: new Date(guardado.ts).toISOString(), cached: true };
      }
    }
    const data = await busca();
    cache.set(chave, { ts: now, data });
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return { ...data, fetchedAt: new Date(now).toISOString(), cached: false };
  }
  cacheado.reset = () => cache.clear();
  return cacheado;
}

module.exports = {
  DesempenhoError,
  DIA_RE,
  somaDias,
  diasEntre,
  validaFormato,
  criaCache,
};
