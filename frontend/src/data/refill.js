// Máximo de produtos na fila de uma campanha (`scraping.batchSize`). "Fila" aqui
// é o mesmo buffer que o backend usa pra decidir teto e limiar: os itens da fila
// MAIS os que estão aguardando revisão (backend/scheduler.js → refillQueue e
// autoRefillDue). Toda tela que mostra "na fila" conta os dois, senão o número da
// tela discorda do número que decide o preenchimento.
export const DEFAULT_BATCH = 20;
export const MAX_BATCH = 50;

export function queueMax(scraping) {
  const n = Number(scraping?.batchSize);
  return n > 0 ? Math.min(MAX_BATCH, n) : DEFAULT_BATCH;
}

// Mensagem do "Completar fila agora". O preenchimento completa a fila até o
// máximo da campanha, então o número que importa é `queueSize de limit` — e
// quando entra menos do que cabia, o motivo é o que evita o "por que só 3?".
//
// `queueSize`/`pendingSize` vêm do que ficou GRAVADO (o backend lê de volta
// depois de escrever), não do que ele tentou gravar.
export function refillResultMsg(r) {
  const limite = r.limit ? ` de ${r.limit}` : "";
  const destino = r.target === "pending"
    ? `${r.pendingSize}${limite} aguardando revisão`
    : `fila em ${r.queueSize}${limite}`;

  if (r.full) {
    return { type: "warn", text: `A fila já está cheia — ${destino}.` };
  }

  const motivos = [];
  if (r.skippedSent > 0) motivos.push(`${r.skippedSent} já na fila ou enviados`);
  if (r.skippedAffiliate > 0) motivos.push(`${r.skippedAffiliate} sem link de afiliado`);
  if (r.removed > 0) motivos.push(`${r.removed} duplicado${r.removed !== 1 ? "s" : ""} removido${r.removed !== 1 ? "s" : ""}`);
  const cauda = motivos.length ? ` · ${motivos.join(", ")}` : "";

  if (!r.added) {
    return { type: "warn", text: `Nada novo no catálogo que passe nos filtros · ${destino}${cauda}` };
  }
  const alvo = r.target === "pending" ? "aguardando revisão" : "na fila";
  return { type: "ok", text: `+${r.added} ${alvo} · ${destino}${cauda}` };
}
