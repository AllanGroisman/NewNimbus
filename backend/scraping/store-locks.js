// Trava de loja (admin): esconde uma loja dos usuários sem mexer no scraping.
// Loja trancada some da escolha das campanhas e da aba de afiliado; em ambos os
// casos o usuário vê a `message` configurada aqui ("em breve" / "em manutenção").
//
// O scraping NÃO para quando a loja tranca — o catálogo continua enchendo pra
// que, ao destrancar, os produtos já estejam prontos. Ligar/desligar scraping
// continua sendo o `sources` da config global (admin → Scraping).
const appConfig = require("../config");
const { STORES, normalizeSource } = require("./scraper");

const STORE_LOCKS_KEY = "store-locks";

const DEFAULT_MESSAGE = "Esta loja está em manutenção e volta em breve.";

// Estado default de uma loja: destrancada.
function defaultLock() {
  return { locked: false, message: DEFAULT_MESSAGE, updatedAt: null };
}

// Sempre devolve as três lojas, mesmo que appConfig esteja vazio/corrompido.
function readStoreLocks() {
  const raw = appConfig.get(STORE_LOCKS_KEY);
  const out = {};
  for (const id of Object.keys(STORES)) {
    const cur = raw && typeof raw === "object" ? raw[id] : null;
    out[id] = cur && typeof cur === "object"
      ? {
          locked: !!cur.locked,
          message: typeof cur.message === "string" && cur.message.trim()
            ? cur.message.trim()
            : DEFAULT_MESSAGE,
          updatedAt: cur.updatedAt || null,
        }
      : defaultLock();
  }
  return out;
}

// Aceita "ml" / "Mercado Livre" / "mercadolivre" e devolve o id canônico, ou
// null se não for uma loja suportada.
function resolveStoreId(store) {
  const id = normalizeSource(store);
  return id && STORES[id] ? id : null;
}

// Patch parcial: { locked?, message? }. Devolve o estado completo da loja.
function writeStoreLock(store, patch) {
  const id = resolveStoreId(store);
  if (!id) throw new Error(`Loja desconhecida: ${store}`);
  const all = readStoreLocks();
  const cur = all[id];
  const next = {
    locked: patch?.locked === undefined ? cur.locked : !!patch.locked,
    message: cur.message,
    updatedAt: new Date().toISOString(),
  };
  if (patch?.message !== undefined) {
    const msg = String(patch.message || "").trim();
    next.message = msg || DEFAULT_MESSAGE;
  }
  all[id] = next;
  appConfig.set(STORE_LOCKS_KEY, all);
  return next;
}

function isStoreLocked(store) {
  const id = resolveStoreId(store);
  if (!id) return false;
  return readStoreLocks()[id].locked;
}

// Mensagem da loja trancada, ou null se ela não está trancada.
function lockMessage(store) {
  const id = resolveStoreId(store);
  if (!id) return null;
  const lock = readStoreLocks()[id];
  return lock.locked ? lock.message : null;
}

function lockedStoreIds() {
  const all = readStoreLocks();
  return Object.keys(all).filter(id => all[id].locked);
}

module.exports = {
  STORE_LOCKS_KEY,
  DEFAULT_MESSAGE,
  readStoreLocks,
  writeStoreLock,
  isStoreLocked,
  lockMessage,
  lockedStoreIds,
  resolveStoreId,
};
