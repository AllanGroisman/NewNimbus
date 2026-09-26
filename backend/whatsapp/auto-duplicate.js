// Duplicação automática de grupo destino cheio (task 25).
//
// O WhatsApp não deixa um grupo passar de 1.024 participantes. Quando um grupo
// destino com a opção ligada (`whatsappGroup.metadata.autoDuplicate`) chega perto
// disso, este job cria um grupo novo com o próximo nome da série ("Ofertas #2"),
// pelo MESMO número, e o vincula a todas as campanhas que usavam o cheio. O cheio
// continua recebendo — quem já está lá dentro segue querendo as ofertas —, e o
// link de convite novo é o que o dono passa a divulgar.
//
// Roda no processo do server, junto do scheduler: as operações de grupo passam
// pela fachada `whatsapp` (no modo redis, RPC para o worker, que é o dono das
// sessões). Uma vez por grupo: `duplicatedTo` marca o feito, e o grupo novo nasce
// com a opção ligada, então é ELE que duplica quando encher.
//
// O estado do usuário é salvo inteiro pelo navegador (PUT /api/state), com
// concorrência otimista pelo `user_state.updatedAt`. Por isso a transação daqui
// toca esse carimbo: a próxima gravação de uma aba aberta com o estado antigo
// leva 409 e recarrega — sem isso ela apagaria o grupo novo (whatsapp_groups é
// replace-all no saveState).
const { prisma } = require("../db");

// O teto do WhatsApp é 1.024. A folga é para o grupo não lotar entre duas passadas.
const FULL_AT = Number(process.env.AUTO_DUPLICATE_AT) || 1000;
const INTERVAL_MS = Number(process.env.AUTO_DUPLICATE_INTERVAL_MS) || 30 * 60 * 1000;
// Depois de uma falha (número caído, WhatsApp recusou), espera antes de tentar de novo.
const RETRY_MS = 6 * 60 * 60 * 1000;

function getWa() { return require("./index"); }
function getNotifier() { return require("../notifications/user-notifier"); }

// "Ofertas" → "Ofertas #2"; "Ofertas #2" → "Ofertas #3". Espelha o
// computeCloneName do GroupDashboard (o "⎘ Duplicar grupo" da tela): o número
// sai do maior "#N" que o usuário já tem na série.
function nextCloneName(originalName, existingNames = []) {
  const base = String(originalName || "Grupo").replace(/\s*#\d+\s*$/, "").trim() || "Grupo";
  const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+#(\\d+)$`);
  let maxN = 1;
  let baseExists = false;
  for (const n of existingNames) {
    if (n === base) baseExists = true;
    const m = n && String(n).match(re);
    if (m) maxN = Math.max(maxN, Number(m[1]));
  }
  return `${base} #${baseExists ? maxN + 1 : maxN}`;
}

function recentlyFailed(meta, now = Date.now()) {
  const t = meta?.autoDuplicateTriedAt ? Date.parse(meta.autoDuplicateTriedAt) : NaN;
  return Number.isFinite(t) && now - t < RETRY_MS;
}

async function markFailure(row, message) {
  await prisma().whatsappGroup.update({
    where: { id: row.id },
    data: { metadata: { ...(row.metadata || {}), autoDuplicateTriedAt: new Date().toISOString(), autoDuplicateError: String(message || "falhou").slice(0, 300) } },
  }).catch(() => {});
}

// Um grupo candidato: confere o tamanho e, cheio, duplica. Devolve o que fez.
async function checkGroup(row, { wa = getWa(), fullAt = FULL_AT } = {}) {
  const meta = row.metadata || {};
  if (!meta.autoDuplicate || meta.duplicatedTo) return { skipped: "off" };
  if (recentlyFailed(meta)) return { skipped: "retry-later" };

  const session = await wa.getSession(row.userId, row.numberId);
  if (session?.status !== "connected") return { skipped: "offline" };

  let members;
  try {
    const md = await wa.getGroupMetadata(row.userId, row.numberId, row.jid);
    members = Array.isArray(md?.participants) ? md.participants.length : null;
  } catch (err) {
    return { skipped: "metadata", error: err.message };
  }
  if (members == null) return { skipped: "metadata" };
  if (members < fullAt) return { members, full: false };

  const phone = session?.info?.phone;
  if (!phone) {
    await markFailure(row, "número sem telefone conhecido");
    return { members, full: true, error: "sem telefone" };
  }

  const irmaos = await prisma().whatsappGroup.findMany({ where: { userId: row.userId }, select: { name: true } });
  const name = nextCloneName(row.name, irmaos.map(g => g.name));
  let created;
  try {
    created = await wa.createGroup(row.userId, row.numberId, name, [phone]);
  } catch (err) {
    await markFailure(row, err.message);
    return { members, full: true, error: err.message };
  }

  const agora = new Date().toISOString();
  const campanhas = await prisma().group.findMany({ where: { userId: row.userId }, select: { id: true, name: true, whatsappGroupIds: true, scraping: true } });
  const afetadas = campanhas.filter(g => Array.isArray(g.whatsappGroupIds) && g.whatsappGroupIds.map(String).includes(String(row.id)));

  const tx = [
    prisma().whatsappGroup.create({
      data: {
        id: created.jid, userId: row.userId, numberId: row.numberId, jid: created.jid, name: created.name || name,
        metadata: {
          members: (created.participants || []).length + 1,
          inviteLink: created.inviteLink || null,
          status: "connected",
          createdAt: new Date().toLocaleDateString("pt-BR"),
          sentToday: 0, lastSend: "—",
          description: meta.description || "",
          autoDuplicate: true,
          duplicatedFrom: row.id,
        },
      },
    }),
    prisma().whatsappGroup.update({
      where: { id: row.id },
      data: { metadata: { ...meta, members, duplicatedTo: created.jid, duplicatedAt: agora, autoDuplicateError: null } },
    }),
    ...afetadas.map(g => prisma().group.update({
      where: { id: g.id },
      data: { whatsappGroupIds: [...g.whatsappGroupIds, created.jid] },
    })),
    // Versão do estado: a aba aberta com o estado antigo recarrega em vez de apagar.
    prisma().userState.upsert({
      where: { userId: row.userId },
      create: { userId: row.userId, settings: {} },
      update: { updatedAt: new Date() },
    }),
  ];
  await prisma().$transaction(tx);

  console.log(`[auto-duplicate] ${row.userId}: "${row.name}" (${members} membros) → "${created.name || name}" em ${afetadas.length} campanha(s)`);
  Promise.resolve().then(() => getNotifier().onGroupDuplicated(row.userId, {
    from: row.name, to: created.name || name, members, inviteLink: created.inviteLink || null,
    campaigns: afetadas.map(g => g.name),
  })).catch(() => {});
  return { members, full: true, duplicated: created.jid, campaigns: afetadas.length };
}

let _running = false;
async function tick() {
  if (_running) return;
  _running = true;
  try {
    // O filtro no JSON fica no SQL: a tabela tem os grupos de todos os usuários.
    const rows = await prisma().$queryRaw`
      SELECT "id", "userId", "numberId", "jid", "name", "metadata"
        FROM "whatsapp_groups"
       WHERE ("metadata"->>'autoDuplicate')::boolean IS TRUE
         AND "metadata"->>'duplicatedTo' IS NULL`;
    for (const row of rows) {
      try { await checkGroup(row); } catch (err) { console.error(`[auto-duplicate] ${row.id}:`, err.message); }
    }
  } catch (err) {
    console.error("[auto-duplicate] tick:", err.message);
  } finally {
    _running = false;
  }
}

let _timer = null;
function start() {
  if (_timer) return;
  _timer = setInterval(tick, INTERVAL_MS);
  if (_timer.unref) _timer.unref();
  setTimeout(tick, 60 * 1000).unref?.();
}

module.exports = { start, tick, checkGroup, nextCloneName, FULL_AT };
