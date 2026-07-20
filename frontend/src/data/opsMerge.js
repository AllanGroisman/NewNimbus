// Merge dos campos "operacionais" de campanhas (escritos pelo scheduler no
// backend e lidos pelo polling do frontend a cada 3s) sobre o estado local.
//
// Regra de ouro: preservar a IDENTIDADE (referência) quando nada muda. O
// polling roda a cada 3s; se ele sempre criasse um objeto/array novo, a
// referência de `groups` mudaria toda vez, e como `groups` é dependência do
// efeito de autosave, isso dispararia um PUT /api/state a cada poll — mesmo
// sem o usuário ter editado nada. Retornar a mesma referência quando não há
// mudança corta esse ciclo.

export const OPS_FIELDS = ["queue", "pending", "history", "sentToday", "sentWeek", "weekData", "lastSend", "avgDiscount"];

// Compara dois valores de campo. Igualdade por referência é o caminho rápido;
// senão compara por conteúdo (JSON) pra não trocar a referência quando o
// backend devolveu um array/objeto equivalente porém novo.
export function fieldChanged(a, b) {
  if (a === b) return false;
  try {
    return JSON.stringify(a) !== JSON.stringify(b);
  } catch {
    return true; // valor não serializável — trata como mudança (conservador)
  }
}

// Aplica os campos de ops de `ops` sobre `group`. Só considera um campo se o
// backend o enviou (`!== undefined`) E o valor realmente mudou. Retorna a
// MESMA referência de `group` se nada mudou.
export function mergeGroupOps(group, ops) {
  if (!ops) return group;
  let changed = false;
  const next = { ...group };
  for (const f of OPS_FIELDS) {
    if (ops[f] !== undefined && fieldChanged(group[f], ops[f])) {
      next[f] = ops[f];
      changed = true;
    }
  }
  return changed ? next : group;
}

// Aplica ops (lista por id) sobre uma lista de grupos. Retorna a MESMA
// referência de array se nenhum grupo mudou.
export function mergeGroupsOps(groups, opsList) {
  const opsById = new Map((opsList || []).map(o => [o.id, o]));
  let changedAny = false;
  const next = groups.map(g => {
    const m = mergeGroupOps(g, opsById.get(g.id));
    if (m !== g) changedAny = true;
    return m;
  });
  return changedAny ? next : groups;
}
