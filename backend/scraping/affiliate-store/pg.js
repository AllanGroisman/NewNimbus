// Storage per-user em Postgres (tabela affiliate_config).
// Cache sync write-through (Map<userId, raw>). Mantemos interface SÍNCRONA pra
// affiliate.js não precisar virar async — IO é fire-and-forget.

const { prisma } = require("../../db");

const _cache = new Map();

function getRaw(userId) {
  if (!userId) return {};
  return _cache.get(userId) || {};
}

function setRaw(userId, value) {
  if (!userId) throw new Error("setRaw exige userId");
  _cache.set(userId, value);
  prisma().affiliateConfig.upsert({
    where: { userId },
    create: { userId, data: value },
    update: { data: value },
  }).catch(err => console.error(`[affiliate-store] set("${userId}") falhou:`, err.message));
}

function clear(userId) {
  if (!userId) return;
  _cache.delete(userId);
  prisma().affiliateConfig.delete({ where: { userId } })
    .catch(err => {
      if (err.code !== "P2025") console.error(`[affiliate-store] clear("${userId}") falhou:`, err.message);
    });
}

function listShopeeConfigs() {
  const out = [];
  for (const [userId, raw] of _cache.entries()) {
    if (!raw) continue;
    const sh = raw.shopee;
    if (sh && sh.appId && sh.appSecret) out.push({ userId, appId: sh.appId, appSecret: sh.appSecret });
  }
  return out;
}

async function warmup() {
  const rows = await prisma().affiliateConfig.findMany();
  for (const r of rows) _cache.set(r.userId, r.data || {});
}

module.exports = { getRaw, setRaw, clear, listShopeeConfigs, warmup };
