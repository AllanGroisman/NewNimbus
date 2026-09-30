// Mensagem no privado para os membros dos grupos destino de uma campanha
// (tasks 4 e 6).
//
// DM em massa para quem não tem o número salvo é o que mais bane no WhatsApp,
// então o envio é lento DE PROPÓSITO, e o ritmo vale POR NÚMERO:
//   - intervalo aleatório entre DM_MIN_GAP_MS e DM_MAX_GAP_MS (20–45s);
//   - no máximo DM_DAILY_CAP (200) mensagens por número em 24h, somando todos os
//     disparos do usuário. Bateu o teto, espera a mais antiga da janela vencer e
//     continua sozinho;
//   - 5 falhas seguidas num número encerram os disparos que dependem dele: é o
//     jeito de um número restringido pelo WhatsApp parar de insistir.
//
// Dois tipos de laço (task 6):
//   - o preparo, um por disparo: monta a lista de destinatários e sai;
//   - o envio, um por número (usuário + numberId): pega o próximo destinatário
//     pendente de qualquer disparo em andamento daquele número, do disparo mais
//     antigo para o mais novo. Números diferentes enviam ao mesmo tempo; no mesmo
//     número, o disparo novo espera o anterior acabar — é a fila.
//
// Roda no processo do server, como o auto-duplicate: fala com o WhatsApp pela
// fachada `whatsapp` (no modo redis, RPC para o worker, que é o dono dos
// sockets). O envio passa pelo withSendLock da sessão, então não embaralha com os
// envios de produto da campanha. Disparos e destinatários moram no banco
// (dm_broadcasts), o que deixa o envio retomar depois de um restart. Só a espera
// de cada número (teto, número caído) fica em memória: o server é uma instância
// só, e um restart a recalcula na primeira volta do laço.
//
// status do disparo: preparing → running → done | canceled | failed
// status do destinatário: pending → sent | failed | canceled
const { prisma } = require("../db");

const ATIVOS = ["preparing", "running"];
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_FALHAS_SEGUIDAS = 5;
// Uma espera longa (teto diário) acorda de tempos em tempos para ver se ainda há
// o que enviar.
const FATIA_ESPERA_MS = 60 * 1000;

function num(v, padrao) {
  if (v === undefined || v === null || v === "") return padrao;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : padrao;
}

// Lido a cada laço (e não no require) para os testes poderem trocar por env.
function config() {
  const minGap = num(process.env.DM_MIN_GAP_MS, 20000);
  return {
    minGap,
    maxGap: Math.max(minGap, num(process.env.DM_MAX_GAP_MS, 45000)),
    dailyCap: Math.max(1, num(process.env.DM_DAILY_CAP, 200)),
    offlineRetry: num(process.env.DM_OFFLINE_RETRY_MS, 60000),
  };
}
const intervalo = (cfg) => cfg.minGap + Math.random() * (cfg.maxGap - cfg.minGap);

function getWa() { return require("../whatsapp"); }
const db = () => prisma();
const lista = (v) => (Array.isArray(v) ? v : []).map(String);

// Erro de transporte (número caído, worker fora, RPC que expirou) não é culpa do
// destinatário: o destinatário continua pendente e o número espera.
const TRANSITORIO = /não está conectada|Sessão não encontrada|timed out|timeout|Connection Closed|Connection Terminated/i;

// Laços em andamento: o preparo de cada disparo ("b:<id>") e o envio de cada
// número ("n:<usuário>::<numberId>"). `wake` interrompe a espera atual.
const loops = new Map();
// O que cada número está esperando, para a tela: chave → { nextAt, motivo }.
const esperas = new Map();
const chaveNumero = (userId, numberId) => `${userId}::${numberId}`;

function sleep(ms, ctl) {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(done, Math.min(ms, FATIA_ESPERA_MS));
    if (t.unref) t.unref();
    function done() { clearTimeout(t); ctl.wake = null; resolve(); }
    ctl.wake = done;
  });
}

async function encerrar(id, status, error = undefined) {
  await db().dmBroadcast.updateMany({
    where: { id, status: { in: ATIVOS } },
    data: { status, finishedAt: new Date(), nextAt: null, ...(error !== undefined ? { error } : {}) },
  });
}

// ── Preparo ──────────────────────────────────────────────────────────────────

// Monta a lista de destinatários: membros de cada grupo, sem repetição (o unique
// (broadcastId, jid) + skipDuplicates), pelo número do primeiro grupo em que a
// pessoa aparece. Idempotente — um restart no meio só completa o que faltou.
// Um grupo cancelado no cartão enquanto a lista é montada sai do disparo.
async function preparar(b) {
  const wa = getWa();
  const ids = lista(b.whatsappGroupIds);
  const rows = await db().whatsappGroup.findMany({ where: { userId: b.userId, id: { in: ids } } });
  const fora = [];
  const prontos = [];
  const ainda = async () => {
    const atual = await db().dmBroadcast.findUnique({ where: { id: b.id }, select: { status: true, whatsappGroupIds: true } });
    return atual?.status === "preparing" ? new Set(lista(atual.whatsappGroupIds)) : null;
  };
  const inserir = (w, membros) => db().dmBroadcastRecipient.createMany({
    data: membros.map(m => ({ broadcastId: b.id, numberId: String(w.numberId), jid: m.jid, groupJid: w.jid })),
    skipDuplicates: true,
  });

  for (const gid of ids) {
    const ficam = await ainda();
    if (!ficam) return;
    if (!ficam.has(gid)) continue;
    const w = rows.find(r => r.id === gid);
    if (!w) { fora.push(`${gid} (não está mais cadastrado)`); continue; }
    const s = await Promise.resolve(wa.getSession(b.userId, w.numberId)).catch(() => null);
    if (s?.status !== "connected") { fora.push(`"${w.name}" (número desconectado)`); continue; }
    let membros;
    try {
      membros = await wa.groupMemberJids(b.userId, w.numberId, w.jid);
    } catch (err) {
      fora.push(`"${w.name}" (${err.message})`);
      continue;
    }
    if (membros?.length) await inserir(w, membros);
    prontos.push({ w, membros: membros || [] });
  }

  // Cancelado depois de já ter entrado na lista: quem veio por ele sai, e quem
  // também está num grupo que fica volta por esse outro grupo.
  const ficam = await ainda();
  if (!ficam) return;
  const saiu = prontos.filter(p => !ficam.has(p.w.id));
  if (saiu.length) {
    await db().dmBroadcastRecipient.deleteMany({ where: { broadcastId: b.id, groupJid: { in: saiu.map(p => p.w.jid) } } });
    for (const p of prontos) if (ficam.has(p.w.id) && p.membros.length) await inserir(p.w, p.membros);
  }

  const total = await db().dmBroadcastRecipient.count({ where: { broadcastId: b.id } });
  if (prontos.length === saiu.length || !total) {
    await encerrar(b.id, "failed", fora.length
      ? `Nenhum membro para mandar. Ficaram de fora: ${fora.join(", ")}.`
      : "Nenhum membro para mandar (os grupos só têm você).");
    return;
  }
  await db().dmBroadcast.updateMany({
    where: { id: b.id, status: "preparing" },
    data: {
      status: "running", total, startedAt: new Date(),
      error: fora.length ? `Ficaram de fora: ${fora.join(", ")}.` : null,
    },
  });
}

// Prepara (se for o caso) e põe os números do disparo para enviar.
async function prepararEEnviar(id) {
  let b = await db().dmBroadcast.findUnique({ where: { id } });
  if (b?.status === "preparing") {
    await preparar(b);
    b = await db().dmBroadcast.findUnique({ where: { id } });
  }
  if (b?.status !== "running") return;
  const numeros = await db().dmBroadcastRecipient.findMany({
    where: { broadcastId: id, status: "pending" },
    select: { numberId: true },
    distinct: ["numberId"],
  });
  for (const n of numeros) kickNumero(b.userId, n.numberId);
}

// ── Envio, um laço por número ────────────────────────────────────────────────

// O próximo a receber por este número: o disparo mais antigo primeiro.
function proximo(userId, numberId) {
  return db().dmBroadcastRecipient.findFirst({
    where: { numberId, status: "pending", broadcast: { userId, status: "running" } },
    orderBy: [{ broadcastId: "asc" }, { id: "asc" }],
    include: { broadcast: { select: { text: true } } },
  });
}

// Até quando o número está no teto: a mais antiga das últimas 24h + 24h. null =
// pode enviar agora.
async function liberaEm(userId, numberId, cap) {
  const janela = await db().dmBroadcastRecipient.findMany({
    where: { numberId, status: "sent", sentAt: { gte: new Date(Date.now() - DAY_MS) }, broadcast: { userId } },
    select: { sentAt: true },
    orderBy: { sentAt: "asc" },
    take: cap,
  });
  if (janela.length < cap) return null;
  return janela[0].sentAt.getTime() + DAY_MS;
}

// O intervalo vale entre laços também: um disparo que chega logo depois de outro
// acabar (ou um restart) espera o que faltava desde a última mensagem.
async function primeiraVez(userId, numberId, cfg) {
  const ultimo = await db().dmBroadcastRecipient.findFirst({
    where: { numberId, status: "sent", broadcast: { userId } },
    orderBy: { sentAt: "desc" },
    select: { sentAt: true },
  });
  return ultimo?.sentAt ? ultimo.sentAt.getTime() + intervalo(cfg) : 0;
}

// Espera até `ate` em fatias. Sai antes se acordarem o laço (um cancelar) ou se
// o número não tiver mais nada para enviar: um cancelamento no meio de uma
// espera de horas não pode ficar esperando ela acabar.
async function esperar(ctl, ms, motivo) {
  const ate = Date.now() + ms;
  esperas.set(ctl.chave, { nextAt: new Date(ate), motivo });
  while (Date.now() < ate) {
    await sleep(ate - Date.now(), ctl);
    if (ctl.kicked) return;
    if (!(await proximo(ctl.userId, ctl.numberId))) return;
  }
}

// 5 falhas seguidas: o número pode estar restrito. Para todo disparo em andamento
// que ainda tem alguém para receber por ele — o disparo para inteiro, inclusive a
// parte que iria por outro número, como antes da task 6.
async function pararNumero(userId, numberId, broadcastId, motivo) {
  const rows = await db().dmBroadcastRecipient.findMany({
    where: { numberId, status: "pending", broadcast: { userId, status: "running" } },
    select: { broadcastId: true },
    distinct: ["broadcastId"],
  });
  const ids = new Set([String(broadcastId), ...rows.map(r => String(r.broadcastId))]);
  for (const id of ids) await encerrar(BigInt(id), "failed", motivo);
  acordar(userId);
}

async function finalizarSeAcabou(id) {
  const resta = await db().dmBroadcastRecipient.count({ where: { broadcastId: id, status: "pending" } });
  if (!resta) {
    await db().dmBroadcast.updateMany({
      where: { id, status: "running" },
      data: { status: "done", finishedAt: new Date(), nextAt: null },
    });
  }
}

async function enviarPeloNumero(ctl) {
  const cfg = config();
  const wa = getWa();
  const { userId, numberId } = ctl;
  let falhas = 0;
  ctl.proximaVez = await primeiraVez(userId, numberId, cfg);
  for (;;) {
    ctl.kicked = false;
    if (!(await proximo(userId, numberId))) return;

    // O intervalo é marcado no relógio: acordar o laço (um cancelar) só faz ele
    // olhar de novo quem é o próximo, nunca adianta a próxima mensagem.
    if (Date.now() < ctl.proximaVez) { await sleep(ctl.proximaVez - Date.now(), ctl); continue; }

    const s = await Promise.resolve(wa.getSession(userId, numberId)).catch(() => null);
    if (s?.status !== "connected") {
      await esperar(ctl, cfg.offlineRetry, "número desconectado");
      continue;
    }
    const libera = await liberaEm(userId, numberId, cfg.dailyCap);
    if (libera) {
      await esperar(ctl, libera - Date.now(), `teto de ${cfg.dailyCap} por dia deste número`);
      continue;
    }
    esperas.delete(ctl.chave);

    // Relido na hora de enviar: um cancelar pode ter chegado durante as checagens.
    const prox = await proximo(userId, numberId);
    if (!prox) continue;
    ctl.proximaVez = Date.now() + intervalo(cfg);
    // updateMany, e não update: se a campanha foi apagada no meio do envio, o
    // destinatário sumiu junto, e isso não pode derrubar o laço do número.
    try {
      await wa.sendText(userId, numberId, prox.jid, prox.broadcast.text);
      await db().dmBroadcastRecipient.updateMany({ where: { id: prox.id }, data: { status: "sent", sentAt: new Date(), error: null } });
      await db().dmBroadcast.updateMany({ where: { id: prox.broadcastId }, data: { sent: { increment: 1 } } });
      falhas = 0;
    } catch (err) {
      if (TRANSITORIO.test(err?.message || "")) {
        await esperar(ctl, cfg.offlineRetry, "o WhatsApp não respondeu");
        continue;
      }
      await db().dmBroadcastRecipient.updateMany({ where: { id: prox.id }, data: { status: "failed", error: String(err?.message || err).slice(0, 300) } });
      await db().dmBroadcast.updateMany({ where: { id: prox.broadcastId }, data: { failed: { increment: 1 } } });
      if (++falhas >= MAX_FALHAS_SEGUIDAS) {
        falhas = 0;
        await pararNumero(userId, numberId, prox.broadcastId, `Parado depois de ${MAX_FALHAS_SEGUIDAS} falhas seguidas — o número pode estar restrito pelo WhatsApp. Última: ${err?.message || err}`);
        continue;
      }
    }
    await finalizarSeAcabou(prox.broadcastId);
  }
}

// ── Controle ─────────────────────────────────────────────────────────────────

// Põe o número para enviar (ou acorda o laço que já roda, para olhar de novo).
function kickNumero(userId, numberId) {
  const chave = chaveNumero(userId, numberId);
  const k = `n:${chave}`;
  const atual = loops.get(k);
  if (atual) { atual.kicked = true; atual.wake?.(); return atual.promise; }
  const ctl = { userId, numberId: String(numberId), chave, wake: null, kicked: false, proximaVez: 0, promise: null };
  loops.set(k, ctl);
  ctl.promise = enviarPeloNumero(ctl)
    .catch(err => {
      // Quebrou (banco fora, p.ex.): não sobe outro na hora, para não girar em
      // falso. O próximo disparo neste número, ou um restart, põe ele de novo.
      ctl.kicked = false;
      console.error(`[dm-broadcast] número ${numberId}:`, err.message);
    })
    .finally(() => {
      loops.delete(k);
      esperas.delete(chave);
      // Chegou disparo novo para este número enquanto o laço saía: sobe outro.
      if (ctl.kicked) kickNumero(userId, numberId);
    });
  return ctl.promise;
}

// Põe o disparo para andar: prepara, se ainda não preparou, e chama os números.
function kick(id) {
  const k = `b:${id}`;
  if (loops.has(k)) return loops.get(k).promise;
  const ctl = { promise: null };
  loops.set(k, ctl);
  ctl.promise = prepararEEnviar(BigInt(String(id)))
    .catch(err => console.error(`[dm-broadcast] ${id}:`, err.message))
    .finally(() => loops.delete(k));
  return ctl.promise;
}

// Acorda os laços de envio do usuário, para verem um cancelamento na hora.
function acordar(userId) {
  for (const ctl of loops.values()) {
    if (ctl.userId === userId) { ctl.kicked = true; ctl.wake?.(); }
  }
}

// Cancelar (task 6). Com grupo, para só a parte daquele grupo e os outros grupos
// do disparo continuam; sem grupo, o disparo inteiro. Quem já recebeu, recebeu.
// `groupJid`: o jid do grupo, que é como os destinatários guardam de onde vieram.
async function cancelar(b, { whatsappGroupId = null, groupJid = null } = {}) {
  const id = b.id;
  if (whatsappGroupId == null) {
    await encerrar(id, "canceled");
    await db().dmBroadcastRecipient.updateMany({ where: { broadcastId: id, status: "pending" }, data: { status: "canceled" } });
    acordar(b.userId);
    return;
  }
  if (b.status === "preparing") {
    // Ainda montando a lista: o grupo sai do disparo e o preparo pula ele.
    const ficam = lista(b.whatsappGroupIds).filter(g => g !== String(whatsappGroupId));
    const r = await db().dmBroadcast.updateMany({ where: { id, status: "preparing" }, data: { whatsappGroupIds: ficam } });
    if (r.count) {
      if (!ficam.length) await encerrar(id, "canceled");
      return;
    }
    // O preparo terminou no meio do caminho: cancela como um disparo andando.
  }
  await db().dmBroadcastRecipient.updateMany({
    where: { broadcastId: id, groupJid: String(groupJid ?? whatsappGroupId), status: "pending" },
    data: { status: "canceled" },
  });
  const resta = await db().dmBroadcastRecipient.count({ where: { broadcastId: id, status: "pending" } });
  if (!resta) await encerrar(id, "canceled");
  acordar(b.userId);
}

// O que o número está esperando (teto, número caído), ou null se está enviando.
function estadoNumero(userId, numberId) {
  return esperas.get(chaveNumero(userId, numberId)) || null;
}

// No boot: retoma o que estava no meio.
async function start() {
  try {
    // "waiting" era o status do disparo em espera antes da task 6; agora quem
    // espera é o número, e o disparo segue "running".
    await db().dmBroadcast.updateMany({ where: { status: "waiting" }, data: { status: "running", nextAt: null } });
    const ativos = await db().dmBroadcast.findMany({ where: { status: { in: ATIVOS } }, select: { id: true } });
    for (const b of ativos) kick(b.id);
    if (ativos.length) console.log(`[dm-broadcast] retomando ${ativos.length} disparo(s)`);
  } catch (err) {
    console.error("[dm-broadcast] start:", err.message);
  }
}

// Para os testes: espera até não sobrar laço nenhum (o preparo sobe os números).
async function _ocioso() {
  while (loops.size) await Promise.all([...loops.values()].map(c => c.promise));
}

module.exports = { start, kick, kickNumero, acordar, cancelar, estadoNumero, config, ATIVOS, _ocioso };
