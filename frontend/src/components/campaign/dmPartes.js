// Mensagem no privado no cartão do grupo destino (task 6): o que a faixa
// DmProgresso mostra, fora do componente para o GroupsTab e os testes usarem.
//
// A parte de cada grupo vem pronta do servidor (backend/dm-broadcast/progress.js):
// { whatsappGroupId, total, sent, failed, canceled, pending, fase, nextAt, motivo }.
// Terminada, a faixa mostra o resultado por 24h ou até ser dispensada no ×. Os
// dispensados ficam no navegador: é só conveniência, e sem localStorage a faixa
// volta a aparecer, nada mais.

const DAY_MS = 24 * 60 * 60 * 1000;
const DISPENSADOS_KEY = "nimbus.dmDispensados";
const DISPENSADOS_MAX = 100;

export function hora(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  const hoje = new Date().toDateString() === d.toDateString();
  const hm = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  return hoje ? hm : `${d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })} às ${hm}`;
}

export const parteAtiva = (p) => !!p && p.fase !== "finished";
export const chaveDaParte = (b, p) => `${b.id}:${p.whatsappGroupId}`;

// O que a parte de um grupo está fazendo, em poucas palavras.
export function textoDaParte(p, b) {
  switch (p.fase) {
    case "preparing": return "Montando a lista de membros…";
    case "queued": return "Na fila — outro envio deste número vai antes";
    case "waiting": return `Aguardando${p.nextAt ? ` até ${hora(p.nextAt)}` : ""}${p.motivo ? ` (${p.motivo})` : ""}`;
    case "sending": return "Enviando…";
    default:
      if (b.status === "failed") return `Parou: ${b.error || "erro desconhecido"}`;
      if (p.canceled > 0 || b.status === "canceled") return "Cancelado";
      return "Concluído";
  }
}

// Qual parte cada cartão mostra (Map whatsappGroupId → { parte, broadcast }):
// a que está andando; se nenhuma, a do envio mais recente daquele grupo, se
// terminou há menos de 24h e não foi dispensada. `lista` vem do mais novo para o
// mais velho, como o servidor devolve.
export function partesPorGrupo(lista, dispensados = [], agora = Date.now()) {
  const out = new Map();
  const jaViuTerminada = new Set();
  for (const b of lista || []) {
    for (const p of b.grupos || []) {
      const id = p.whatsappGroupId;
      if (parteAtiva(p)) {
        if (!parteAtiva(out.get(id)?.parte)) out.set(id, { parte: p, broadcast: b });
        continue;
      }
      if (out.has(id) || jaViuTerminada.has(id)) continue;
      jaViuTerminada.add(id);
      const fim = b.finishedAt ? new Date(b.finishedAt).getTime() : agora;
      if (agora - fim > DAY_MS || dispensados.includes(chaveDaParte(b, p))) continue;
      out.set(id, { parte: p, broadcast: b });
    }
  }
  return out;
}

export function lerDispensados() {
  try {
    const v = JSON.parse(localStorage.getItem(DISPENSADOS_KEY) || "[]");
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

export function gravarDispensados(lista) {
  const novo = lista.slice(-DISPENSADOS_MAX);
  try { localStorage.setItem(DISPENSADOS_KEY, JSON.stringify(novo)); } catch { /* sem storage: some só nesta sessão */ }
  return novo;
}
