// Implementação Postgres do storage por usuário.
// Diferença chave vs JSON: a race condition entre frontend e scheduler é resolvida
// pelo schema (queue/pending/history em tabelas próprias, sentToday/lastSend em
// colunas dedicadas). O hack OPS_FIELDS deixa de ser necessário internamente,
// mas mantemos a constante exportada pra compat com o frontend.
const { prisma } = require("../db");

const OPS_FIELDS = ["queue", "pending", "history", "sentToday", "sentWeek", "weekData", "lastSend", "avgDiscount"];

const EMPTY_STATE = {
  groups: [],
  numbers: [],
  whatsappGroups: [],
  settings: {},
};

// ────────────────────────────────────────────────────────────────────────
// Helpers de (des)serialização
// ────────────────────────────────────────────────────────────────────────

// avgDiscount é gravado como string no PG (coluna String @default("—")) pra
// suportar tanto o sentinel "—" quanto valores numéricos. Na leitura, coerce
// pra número quando for numérico — mantém compat com o shape antigo do JSON
// (que devolvia number) que o frontend espera.
function parseAvgDiscount(v) {
  if (v == null) return v;
  if (typeof v === "number") return v;
  const s = String(v);
  if (s === "—" || s === "") return s;
  const n = Number(s);
  return Number.isFinite(n) ? n : s;
}

// Group row + relações → shape que o frontend/scheduler esperam.
// Inclui queue/pending/history "inline" como o JSON antigo.
function groupRowToObject(row, queue = [], pending = [], history = []) {
  return {
    id: Number(row.id),
    name: row.name,
    messageTemplate: row.messageTemplate,
    paused: !!row.paused,
    categories: row.categories || [],
    whatsappGroupIds: row.whatsappGroupIds || [],
    schedule: row.schedule || {},
    scraping: row.scraping || {},
    sentToday: row.sentToday,
    sentWeek: row.sentWeek,
    weekData: row.weekData || [0, 0, 0, 0, 0, 0, 0],
    lastSend: row.lastSend,
    avgDiscount: parseAvgDiscount(row.avgDiscount),
    queue: queue.map(q => q.payload),
    pending: pending.map(p => p.payload),
    history: history.map(h => ({
      key: h.productKey,
      name: h.name,
      link: h.link,
      img: h.img,
      store: h.store,
      price: h.price,
      originalPrice: h.originalPrice,
      discount: h.discount,
      sentAt: h.sentAt.toISOString(),
      groupCount: h.groupCount,
    })),
  };
}

function whatsappRowToObject(r) {
  return { id: r.id, numberId: r.numberId, jid: r.jid, name: r.name, ...(r.metadata || {}) };
}

function numberRowToObject(r) {
  return { id: r.id, label: r.label, phone: r.phone, ...(r.metadata || {}) };
}

// ────────────────────────────────────────────────────────────────────────
// API pública
// ────────────────────────────────────────────────────────────────────────

async function loadState(userId) {
  const [stateRow, groupRows, queueRows, pendingRows, historyRows, waGroups, numbers] = await Promise.all([
    prisma().userState.findUnique({ where: { userId } }),
    prisma().group.findMany({ where: { userId } }),
    prisma().groupQueueItem.findMany({
      where: { group: { userId } },
      orderBy: [{ groupId: "asc" }, { position: "asc" }, { id: "asc" }],
    }),
    prisma().groupPendingItem.findMany({
      where: { group: { userId } },
      orderBy: [{ groupId: "asc" }, { id: "asc" }],
    }),
    prisma().groupHistory.findMany({
      where: { group: { userId } },
      orderBy: [{ groupId: "asc" }, { sentAt: "desc" }],
    }),
    prisma().whatsappGroup.findMany({ where: { userId } }),
    prisma().whatsappNumber.findMany({ where: { userId } }),
  ]);

  // Agrupa por groupId
  const byGroup = (rows) => {
    const m = new Map();
    for (const r of rows) {
      const k = String(r.groupId);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
    return m;
  };
  const qByG = byGroup(queueRows);
  const pByG = byGroup(pendingRows);
  const hByG = byGroup(historyRows);

  const groups = groupRows.map(g => groupRowToObject(
    g,
    qByG.get(String(g.id)) || [],
    pByG.get(String(g.id)) || [],
    (hByG.get(String(g.id)) || []).slice(0, 200),
  ));

  const result = {
    ...EMPTY_STATE,
    settings: stateRow?.settings || {},
    groups,
    whatsappGroups: waGroups.map(whatsappRowToObject),
    numbers: numbers.map(numberRowToObject),
  };
  // updatedAt: só inclui se houver state row (mantém shape do JSON pro user vazio)
  if (stateRow?.updatedAt) {
    result.updatedAt = stateRow.updatedAt.toISOString();
  }
  return result;
}

// Save vindo do frontend — preserva ops do DB (não precisa do hack OPS_FIELDS porque
// queue/pending/history são tabelas separadas; só não atualizamos as colunas de ops).
async function saveState(userId, incoming) {
  if (!incoming || typeof incoming !== "object") throw new Error("state inválido");

  const tx = [];

  // user_state (settings)
  tx.push(prisma().userState.upsert({
    where: { userId },
    create: { userId, settings: incoming.settings || {} },
    update: { settings: incoming.settings || {} },
  }));

  // groups: upsert por id; campos de config sobrescrevem, ops NÃO.
  const incomingGroups = Array.isArray(incoming.groups) ? incoming.groups : [];
  const existingRows = await prisma().group.findMany({ where: { userId }, select: { id: true, paused: true, name: true } });
  const existingIds = existingRows.map(g => Number(g.id));
  // Snapshot do `paused` atual pra detectar desativação/reativação após o commit.
  const prevPaused = new Map(existingRows.map(g => [Number(g.id), !!g.paused]));
  const incomingIds = incomingGroups.map(g => Number(g.id));

  // Apaga grupos removidos pelo frontend
  const removed = existingIds.filter(id => !incomingIds.includes(id));
  if (removed.length) {
    tx.push(prisma().group.deleteMany({ where: { userId, id: { in: removed.map(BigInt) } } }));
  }

  for (const g of incomingGroups) {
    const id = BigInt(g.id);
    const cfg = {
      name: String(g.name || ""),
      messageTemplate: String(g.messageTemplate || ""),
      paused: !!g.paused,
      categories: g.categories ?? [],
      whatsappGroupIds: g.whatsappGroupIds ?? [],
      schedule: g.schedule ?? {},
      scraping: g.scraping ?? {},
    };
    tx.push(prisma().group.upsert({
      where: { id },
      create: { id, userId, ...cfg },
      update: cfg,
    }));
  }

  // whatsapp_groups: replace-all (frontend manda lista completa)
  tx.push(prisma().whatsappGroup.deleteMany({ where: { userId } }));
  for (const w of (incoming.whatsappGroups || [])) {
    if (!w.id) continue;
    const { id, numberId, jid, name, ...rest } = w;
    tx.push(prisma().whatsappGroup.create({
      data: {
        id: String(id),
        userId,
        numberId: String(numberId || ""),
        jid: String(jid || id),
        name: String(name || ""),
        metadata: rest,
      },
    }));
  }

  // numbers
  tx.push(prisma().whatsappNumber.deleteMany({ where: { userId } }));
  for (const n of (incoming.numbers || [])) {
    if (!n.id) continue;
    const { id, label, phone, ...rest } = n;
    tx.push(prisma().whatsappNumber.create({
      data: {
        id: String(id),
        userId,
        label: label || null,
        phone: phone || null,
        metadata: rest,
      },
    }));
  }

  await prisma().$transaction(tx);

  // Notifica desativação/reativação de campanha (transição do `paused` manual).
  // Só pra grupos que já existiam — criação nova não conta. Fire-and-forget.
  try {
    const notifier = require("../notifications/user-notifier");
    for (const g of incomingGroups) {
      const gid = Number(g.id);
      if (!prevPaused.has(gid)) continue;
      const before = prevPaused.get(gid);
      const after = !!g.paused;
      if (before === after) continue;
      const name = String(g.name || "");
      if (after) notifier.onCampaignDeactivated(userId, name).catch(() => {});
      else notifier.onCampaignReactivated(userId, name).catch(() => {});
    }
  } catch { /* ignore */ }

  return loadState(userId);
}

// Save vindo do scheduler — atualiza um campo ops específico de um grupo.
// Sem race com saveState porque colunas/tabelas são distintas.
async function updateGroupOps(userId, groupId, patch) {
  const id = BigInt(groupId);
  const exists = await prisma().group.findFirst({ where: { id, userId }, select: { id: true } });
  if (!exists) return null;

  const tx = [];

  // Colunas escalares
  const colData = {};
  if (patch.sentToday !== undefined) colData.sentToday = patch.sentToday;
  if (patch.sentWeek !== undefined) colData.sentWeek = patch.sentWeek;
  if (patch.weekData !== undefined) colData.weekData = patch.weekData;
  if (patch.lastSend !== undefined) colData.lastSend = String(patch.lastSend);
  if (patch.avgDiscount !== undefined) colData.avgDiscount = String(patch.avgDiscount);
  if (Object.keys(colData).length) {
    tx.push(prisma().group.update({ where: { id }, data: colData }));
  }

  // queue: replace-all (scheduler sempre passa a lista nova já calculada).
  // Dedup por productKey — o scheduler ocasionalmente concatena lista existente
  // com newItems do refill e pode duplicar chave; o unique [groupId, productKey]
  // quebraria a transação. Primeira ocorrência vence (preserva ordem original).
  if (Array.isArray(patch.queue)) {
    tx.push(prisma().groupQueueItem.deleteMany({ where: { groupId: id } }));
    const seen = new Set();
    let pos = 0;
    for (const item of patch.queue) {
      const key = item.key || item.id;
      if (!key) continue;
      const k = String(key);
      if (seen.has(k)) continue;
      seen.add(k);
      tx.push(prisma().groupQueueItem.create({
        data: { groupId: id, productKey: k, position: pos++, payload: item },
      }));
    }
  }

  // pending: replace-all (mesmo tratamento de dedup)
  if (Array.isArray(patch.pending)) {
    tx.push(prisma().groupPendingItem.deleteMany({ where: { groupId: id } }));
    const seen = new Set();
    for (const item of patch.pending) {
      const key = item.key || item.id;
      if (!key) continue;
      const k = String(key);
      if (seen.has(k)) continue;
      seen.add(k);
      tx.push(prisma().groupPendingItem.create({
        data: { groupId: id, productKey: k, payload: item },
      }));
    }
  }

  // history: o scheduler manda lista nova começando pelo item recém-enviado.
  // Inserimos só os que ainda não estão no DB (chave: groupId + productKey + sentAt).
  // Estratégia simples: limpa últimos 200 e regrava — barato e idempotente.
  if (Array.isArray(patch.history)) {
    const slice = patch.history.slice(0, 200);
    tx.push(prisma().groupHistory.deleteMany({ where: { groupId: id } }));
    for (const h of slice) {
      tx.push(prisma().groupHistory.create({
        data: {
          groupId: id,
          productKey: String(h.key || ""),
          name: String(h.name || ""),
          link: String(h.link || ""),
          img: h.img || null,
          store: h.store || null,
          price: h.price ?? null,
          originalPrice: h.originalPrice ?? null,
          discount: h.discount ?? null,
          sentAt: h.sentAt ? new Date(h.sentAt) : new Date(),
          groupCount: h.groupCount || 1,
        },
      }));
    }
  }

  if (tx.length) await prisma().$transaction(tx);

  // Devolve o grupo atualizado (pra parear com a interface JSON)
  const fresh = await prisma().group.findUnique({ where: { id } });
  const queue = await prisma().groupQueueItem.findMany({ where: { groupId: id }, orderBy: { position: "asc" } });
  const pending = await prisma().groupPendingItem.findMany({ where: { groupId: id }, orderBy: { id: "asc" } });
  const history = await prisma().groupHistory.findMany({ where: { groupId: id }, orderBy: { sentAt: "desc" }, take: 200 });
  return groupRowToObject(fresh, queue, pending, history);
}

async function loadOps(userId) {
  const [groupRows, queueRows, pendingRows, historyRows] = await Promise.all([
    prisma().group.findMany({ where: { userId } }),
    prisma().groupQueueItem.findMany({
      where: { group: { userId } },
      orderBy: [{ groupId: "asc" }, { position: "asc" }],
    }),
    prisma().groupPendingItem.findMany({ where: { group: { userId } }, orderBy: { id: "asc" } }),
    prisma().groupHistory.findMany({
      where: { group: { userId } },
      orderBy: [{ groupId: "asc" }, { sentAt: "desc" }],
    }),
  ]);

  const idx = (rows) => {
    const m = new Map();
    for (const r of rows) {
      const k = String(r.groupId);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
    return m;
  };
  const qByG = idx(queueRows);
  const pByG = idx(pendingRows);
  const hByG = idx(historyRows);

  const groups = groupRows.map(g => ({
    id: Number(g.id),
    queue: (qByG.get(String(g.id)) || []).map(q => q.payload),
    pending: (pByG.get(String(g.id)) || []).map(p => p.payload),
    history: (hByG.get(String(g.id)) || []).slice(0, 200).map(h => ({
      key: h.productKey,
      name: h.name,
      link: h.link,
      img: h.img,
      store: h.store,
      price: h.price,
      originalPrice: h.originalPrice,
      discount: h.discount,
      sentAt: h.sentAt.toISOString(),
      groupCount: h.groupCount,
    })),
    sentToday: g.sentToday,
    sentWeek: g.sentWeek,
    weekData: g.weekData,
    lastSend: g.lastSend,
    avgDiscount: parseAvgDiscount(g.avgDiscount),
  }));

  // updatedAt: pega max(updatedAt) entre groups e user_state
  const stateRow = await prisma().userState.findUnique({ where: { userId } });
  const groupMax = groupRows.reduce((acc, g) => g.updatedAt > acc ? g.updatedAt : acc, new Date(0));
  const stateMax = stateRow?.updatedAt || new Date(0);
  const max = stateMax > groupMax ? stateMax : groupMax;
  return { groups, updatedAt: max.getTime() ? max.toISOString() : null };
}

async function listAllUserIds() {
  const users = await prisma().user.findMany({ select: { id: true } });
  return users.map(u => u.id);
}

async function clearState(userId) {
  // Cascata via FK + onDelete: Cascade no schema. Aqui apagamos só o estado, não o user.
  await prisma().$transaction([
    prisma().group.deleteMany({ where: { userId } }),
    prisma().whatsappGroup.deleteMany({ where: { userId } }),
    prisma().whatsappNumber.deleteMany({ where: { userId } }),
    prisma().userState.deleteMany({ where: { userId } }),
  ]);
}

module.exports = {
  loadState,
  saveState,
  updateGroupOps,
  loadOps,
  clearState,
  listAllUserIds,
  OPS_FIELDS,
};
