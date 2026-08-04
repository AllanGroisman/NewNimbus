// Aplicação dos limites do plano SEM travar o cliente.
//
// Regra: o limite vale sobre os itens ATIVOS. Quando o plano encolhe (cancelou,
// baixou de plano, cartão falhou), nada é apagado — o excedente fica "pausado
// pelo plano": continua visível e editável, mas não envia e não conta contra o
// limite. O cliente troca quais ficam ativos quando quiser (rota de seleção).
//
// Este módulo é o único lugar que decide o que fica pausado. É idempotente:
// rodar duas vezes seguidas não muda nada.

const storage = require("../storage");
const limitsMod = require("./limits");
const { leadersOf } = require("../repasse/leaders");

// Campanha "conforme" = cabe nos limites POR campanha do plano. Uma campanha
// com 15 grupos de WhatsApp não pode ficar ativa no Básico (limite 3), mesmo
// que seja a única — ela é pausada até o cliente enxugar ou subir de plano.
function groupConforms(group, planLimits) {
  const cats = Array.isArray(group?.categories) ? group.categories.length : 0;
  const waGroups = Array.isArray(group?.whatsappGroupIds) ? group.whatsappGroupIds.length : 0;
  const leaders = leadersOf(group?.scraping).length;
  return cats <= planLimits.categoriesPerGroup
    && waGroups <= planLimits.whatsappGroupsPerCampaign
    && leaders <= planLimits.leadersPerCampaign;
}

// Ordem de preferência: mais antigo primeiro. Ids são Date.now() do frontend,
// então o número é a data de criação; o que não for numérico vai pro fim
// mantendo a ordem em que veio do banco.
function byAge(items, idOf) {
  return items
    .map((item, index) => ({ item, index, key: Number(idOf(item)) }))
    .sort((a, b) => {
      const ak = Number.isFinite(a.key) ? a.key : Infinity;
      const bk = Number.isFinite(b.key) ? b.key : Infinity;
      if (ak !== bk) return ak - bk;
      return a.index - b.index;
    })
    .map(x => x.item);
}

function sameSet(a, b) {
  if (a.length !== b.length) return false;
  const set = new Set(a.map(String));
  return b.every(v => set.has(String(v)));
}

// Decide a pausa por plano a partir do estado + limites. Função pura — o
// wrapper `reconcileLimits` cuida de carregar e gravar.
function computePlanPaused(state, planLimits, previous) {
  const groups = Array.isArray(state?.groups) ? state.groups : [];
  const numbers = Array.isArray(state?.numbers) ? state.numbers : [];
  const prev = previous || { groups: [], numbers: [] };

  const existingGroupIds = new Set(groups.map(g => Number(g.id)));
  const existingNumberIds = new Set(numbers.map(n => String(n.id)));
  // 1. Descarta ids de itens que não existem mais.
  const pausedGroups = new Set(
    (prev.groups || []).map(Number).filter(id => existingGroupIds.has(id)),
  );
  const pausedNumbers = new Set(
    (prev.numbers || []).map(String).filter(id => existingNumberIds.has(id)),
  );

  // 2. Campanha ativa fora dos limites por campanha é pausada.
  for (const g of groups) {
    if (!groupConforms(g, planLimits)) pausedGroups.add(Number(g.id));
  }

  // 3. Excedente: pausa da mais nova pra mais antiga até caber no limite.
  const groupsByAge = byAge(groups, g => g.id);
  let activeGroups = groupsByAge.filter(g => !pausedGroups.has(Number(g.id)));
  while (activeGroups.length > planLimits.groups) {
    const victim = activeGroups.pop();
    pausedGroups.add(Number(victim.id));
  }
  // 4. Sobrou espaço (upgrade/reativação): despausa da mais antiga pra mais
  //    nova, só as conformes.
  for (const g of groupsByAge) {
    if (activeGroups.length >= planLimits.groups) break;
    if (!pausedGroups.has(Number(g.id))) continue;
    if (!groupConforms(g, planLimits)) continue;
    pausedGroups.delete(Number(g.id));
    activeGroups.push(g);
  }

  // Mesma lógica pros números de WhatsApp (não têm limite "por item").
  const numbersByAge = byAge(numbers, n => n.id);
  let activeNumbers = numbersByAge.filter(n => !pausedNumbers.has(String(n.id)));
  while (activeNumbers.length > planLimits.numbers) {
    const victim = activeNumbers.pop();
    pausedNumbers.add(String(victim.id));
  }
  for (const n of numbersByAge) {
    if (activeNumbers.length >= planLimits.numbers) break;
    if (!pausedNumbers.has(String(n.id))) continue;
    pausedNumbers.delete(String(n.id));
    activeNumbers.push(n);
  }

  return { groups: [...pausedGroups], numbers: [...pausedNumbers] };
}

// Recalcula e grava a pausa por plano do usuário. Chamada depois de qualquer
// mudança de assinatura (webhook/reconcile) e depois de salvar o estado.
// `opts.state` evita recarregar quando o caller já tem o estado em mãos.
async function reconcileLimits(userId, sub, userRole, opts = {}) {
  const state = opts.state || await storage.loadState(userId);
  const previous = state.planPaused || await storage.loadPlanPaused(userId);

  // Admin não tem limite de plano — nunca fica pausado, e limpa pausa antiga
  // (conta que virou admin depois). Sem isso os limites do Business valeriam
  // pra ele (ex.: 5 números) e pausariam item de admin.
  if (userRole === "admin") {
    const empty = { groups: [], numbers: [] };
    const had = (previous.groups || []).length || (previous.numbers || []).length;
    if (had) await storage.savePlanPaused(userId, empty);
    return { planPaused: empty, changed: !!had };
  }

  const planLimits = limitsMod.getLimits(sub, userRole);
  const next = computePlanPaused(state, planLimits, previous);

  const changed = !sameSet(previous.groups || [], next.groups)
    || !sameSet(previous.numbers || [], next.numbers);
  if (changed) await storage.savePlanPaused(userId, next);
  return { planPaused: next, changed };
}

// Versão "não explode": usada em caminhos onde falhar não pode derrubar a
// resposta (webhook do Stripe, GET /billing/me).
async function reconcileLimitsSafe(userId, sub, userRole, opts = {}) {
  try {
    return await reconcileLimits(userId, sub, userRole, opts);
  } catch (err) {
    return { planPaused: null, changed: false, error: err.message };
  }
}

// Aplica a escolha do cliente ("quais ficam ativos"). Recebe as listas de
// ATIVOS; grava o complemento como pausado. Valida antes: quantidade dentro do
// limite e campanha conforme. Depois de gravar, roda o reconcile pra preencher
// vaga que sobrou (mantém o estado sempre determinístico).
async function setActiveSelection(userId, sub, userRole, selection) {
  const state = await storage.loadState(userId);
  const groups = Array.isArray(state.groups) ? state.groups : [];
  const numbers = Array.isArray(state.numbers) ? state.numbers : [];
  const planLimits = limitsMod.getLimits(sub, userRole);

  const wantedGroups = [...new Set((selection?.groups || []).map(Number).filter(Number.isFinite))];
  const wantedNumbers = [...new Set((selection?.numbers || []).map(String).filter(Boolean))];

  const unknownGroup = wantedGroups.find(id => !groups.some(g => Number(g.id) === id));
  if (unknownGroup !== undefined) {
    return { ok: false, status: 400, error: "Campanha não encontrada." };
  }
  const unknownNumber = wantedNumbers.find(id => !numbers.some(n => String(n.id) === id));
  if (unknownNumber !== undefined) {
    return { ok: false, status: 400, error: "Número não encontrado." };
  }

  const groupsCheck = limitsMod.checkLimit(sub, "groups", wantedGroups.length, userRole);
  if (!groupsCheck.ok) return { ok: false, status: 402, ...groupsCheck };
  const numbersCheck = limitsMod.checkLimit(sub, "numbers", wantedNumbers.length, userRole);
  if (!numbersCheck.ok) return { ok: false, status: 402, ...numbersCheck };

  for (const id of wantedGroups) {
    const g = groups.find(x => Number(x.id) === id);
    if (groupConforms(g, planLimits)) continue;
    const cats = limitsMod.checkLimit(sub, "categoriesPerGroup", (g.categories || []).length, userRole);
    if (!cats.ok) return { ok: false, status: 402, ...cats, groupId: id, groupName: g.name };
    const waGroups = limitsMod.checkLimit(sub, "whatsappGroupsPerCampaign", (g.whatsappGroupIds || []).length, userRole);
    if (!waGroups.ok) return { ok: false, status: 402, ...waGroups, groupId: id, groupName: g.name };
    const leaders = limitsMod.checkLimit(sub, "leadersPerCampaign", leadersOf(g.scraping).length, userRole);
    if (!leaders.ok) return { ok: false, status: 402, ...leaders, groupId: id, groupName: g.name };
  }

  const paused = {
    groups: groups.map(g => Number(g.id)).filter(id => !wantedGroups.includes(id)),
    numbers: numbers.map(n => String(n.id)).filter(id => !wantedNumbers.includes(id)),
  };
  await storage.savePlanPaused(userId, paused);
  const { planPaused } = await reconcileLimits(userId, sub, userRole);
  return { ok: true, planPaused };
}

// Helpers de leitura usados pelo gating das rotas e pelo scheduler.
function isGroupPlanPaused(planPaused, groupId) {
  return (planPaused?.groups || []).some(id => Number(id) === Number(groupId));
}

function isNumberPlanPaused(planPaused, numberId) {
  return (planPaused?.numbers || []).some(id => String(id) === String(numberId));
}

module.exports = {
  groupConforms,
  computePlanPaused,
  reconcileLimits,
  reconcileLimitsSafe,
  setActiveSelection,
  isGroupPlanPaused,
  isNumberPlanPaused,
};
