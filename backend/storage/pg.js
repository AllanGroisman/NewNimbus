// Implementação Postgres do storage por usuário.
// Diferença chave vs JSON: a race condition entre frontend e scheduler é resolvida
// pelo schema (queue/pending/history em tabelas próprias, sentToday/lastSend em
// colunas dedicadas). O hack OPS_FIELDS deixa de ser necessário internamente,
// mas mantemos a constante exportada pra compat com o frontend.
const { prisma } = require("../db");
const { normalizeRepasse } = require("../repasse/leaders");

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

// Normaliza a coluna planPaused pro shape { groups: [Number], numbers: [String] }.
// Ids de campanha são numéricos (BigInt no banco, Number no frontend); ids de
// número são string. Vem de JSON, então nunca confie no formato.
function normalizePlanPaused(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const groups = (Array.isArray(src.groups) ? src.groups : [])
    .map(Number)
    .filter(n => Number.isFinite(n));
  const numbers = (Array.isArray(src.numbers) ? src.numbers : [])
    .map(String)
    .filter(Boolean);
  return { groups: [...new Set(groups)], numbers: [...new Set(numbers)] };
}

async function loadPlanPaused(userId) {
  const row = await prisma().userState.findUnique({ where: { userId }, select: { planPaused: true } });
  return normalizePlanPaused(row?.planPaused);
}

// Grava a pausa por plano. Server-owned: só billing/enforce.js e a rota de
// seleção chamam isso — nunca o PUT /api/state.
async function savePlanPaused(userId, planPaused) {
  const value = normalizePlanPaused(planPaused);
  await prisma().userState.upsert({
    where: { userId },
    create: { userId, settings: {}, planPaused: value },
    update: { planPaused: value },
  });
  return value;
}

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

  // Pausa por plano — some junto no state pra UI e scheduler não precisarem de
  // uma segunda ida ao banco. `planPaused` no item é derivado (read-only).
  const planPaused = normalizePlanPaused(stateRow?.planPaused);
  const pausedGroups = new Set(planPaused.groups);
  const pausedNumbers = new Set(planPaused.numbers);
  for (const g of groups) g.planPaused = pausedGroups.has(Number(g.id));

  const result = {
    ...EMPTY_STATE,
    settings: stateRow?.settings || {},
    groups,
    whatsappGroups: waGroups.map(whatsappRowToObject),
    numbers: numbers.map(n => {
      const obj = numberRowToObject(n);
      obj.planPaused = pausedNumbers.has(String(obj.id));
      return obj;
    }),
    planPaused,
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

  // Concorrência otimista: se o cliente informou a versão (`updatedAt`) que
  // carregou por último e ela não bate mais com o que está no banco, alguém
  // (outra aba, outro save em voo) já escreveu por cima — rejeita em vez de
  // aceitar um PUT baseado em estado obsoleto e apagar a mudança mais nova.
  // `userState.updatedAt` é tocado em TODO saveState bem-sucedido (upsert
  // abaixo), então serve como versão do estado inteiro do usuário, não só
  // das settings. Sem `baseUpdatedAt` (primeiro save do usuário) não há o
  // que comparar — deixa passar.
  if (incoming.baseUpdatedAt) {
    const current = await prisma().userState.findUnique({ where: { userId }, select: { updatedAt: true } });
    if (current && current.updatedAt.toISOString() !== incoming.baseUpdatedAt) {
      const err = new Error("Estado desatualizado — recarregue antes de salvar");
      err.code = "STALE_STATE";
      throw err;
    }
  }

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
    // normalizeRepasse converte o líder único do formato antigo pro array
    // `repasse.leaders` — campanha antiga migra sozinha no primeiro save.
    const scraping = normalizeRepasse(g.scraping ?? {});
    // Categoria é conceito da busca no catálogo. A campanha de repasse recebe o
    // link pronto do grupo líder, então não tem categoria — e zerar aqui tira a
    // campanha antiga da contagem de `categoriesPerGroup` do plano.
    const isRepasse = scraping.kind === "repasse";
    const cfg = {
      name: String(g.name || ""),
      messageTemplate: String(g.messageTemplate || ""),
      paused: !!g.paused,
      categories: isRepasse ? [] : (g.categories ?? []),
      whatsappGroupIds: g.whatsappGroupIds ?? [],
      schedule: g.schedule ?? {},
      scraping,
    };
    tx.push(prisma().group.upsert({
      where: { id },
      create: { id, userId, ...cfg },
      update: cfg,
    }));
  }

  // whatsapp_groups: replace-all (frontend manda lista completa).
  // Descarta grupo cujo número não está na lista de `numbers` deste mesmo save:
  // referência órfã não é pausável pelo plano (enforce.js só marca id conhecido)
  // e o scheduler acabaria enviando por um número fora do limite.
  const incomingNumberIds = new Set(
    (Array.isArray(incoming.numbers) ? incoming.numbers : []).map(n => String(n?.id)),
  );
  tx.push(prisma().whatsappGroup.deleteMany({ where: { userId } }));
  for (const w of (incoming.whatsappGroups || [])) {
    if (!w.id) continue;
    if (!incomingNumberIds.has(String(w.numberId))) {
      // Não deve acontecer no fluxo normal — o frontend remove os grupos junto
      // com o número (removeNumberAndGroups) e remapeia na canonicalização
      // (relinkNumber). Loga pra não sumir dado em silêncio.
      console.warn(`[storage] grupo WA ${w.id} descartado: número ${w.numberId} não está no estado (user ${userId})`);
      continue;
    }
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
    // planPaused é derivado no loadState e volta no payload do frontend —
    // descarta pra não virar lixo no metadata (o valor real fica em user_state).
    const { id, label, phone, planPaused: _ignored, ...rest } = n;
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

// Keys que a busca de produtos não deve mostrar pra uma campanha: o que já está
// na fila / aguardando revisão (`queued`) e o que a campanha JÁ ENVIOU alguma vez
// (`recent`).
//
// "Já enviou alguma vez", e não "enviou dentro do tempo de espera", porque é esse
// o corte que o preenchimento faz (scheduler.refillQueue monta o excludeKeys com
// o histórico inteiro). Enquanto era só o cooldown, a lista da tela oferecia
// "Adicionar de novo" em produtos que o preenchimento automático nunca ia pegar.
// O tempo de espera continua valendo pro que é manual: adicionar um já-enviado
// pela lista ainda passa pela confirmação de reenvio (scheduler.addItemToGroup).
//
// Puxa só a coluna productKey, escopada nesse grupo. É de propósito bem mais magro que loadState(), que traz o
// estado inteiro do usuário em 7 queries: isso aqui roda a cada busca da aba
// (uma por tecla digitada, depois do debounce, e uma por página virada).
//
// Devolve null se o grupo não é desse usuário — quem chama trata como "sem
// exclusão", nunca como erro.
async function loadExcludeKeys(userId, groupId, { queued = true, recent = true } = {}) {
  let id;
  try {
    id = BigInt(groupId);
  } catch {
    return null;   // id não-numérico (o id legado é Date.now())
  }
  const group = await prisma().group.findFirst({
    where: { id, userId },
    select: { id: true },
  });
  if (!group) return null;

  const [queueRows, pendingRows, historyRows] = await Promise.all([
    queued ? prisma().groupQueueItem.findMany({ where: { groupId: id }, select: { productKey: true } }) : [],
    queued ? prisma().groupPendingItem.findMany({ where: { groupId: id }, select: { productKey: true } }) : [],
    recent
      ? prisma().groupHistory.findMany({ where: { groupId: id }, select: { productKey: true } })
      : [],
  ]);

  const out = new Set();
  for (const rows of [queueRows, pendingRows, historyRows]) {
    for (const r of rows) out.add(r.productKey);
  }
  return out;
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
  // planPaused viaja junto no poll de ops (a linha de user_state já foi lida
  // aqui) — assim a UI reage a um downgrade sem precisar de F5.
  const planPaused = normalizePlanPaused(stateRow?.planPaused);
  const pausedGroups = new Set(planPaused.groups);
  for (const g of groups) g.planPaused = pausedGroups.has(Number(g.id));
  return { groups, planPaused, updatedAt: max.getTime() ? max.toISOString() : null };
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
  loadExcludeKeys,
  clearState,
  listAllUserIds,
  loadPlanPaused,
  savePlanPaused,
  OPS_FIELDS,
};
