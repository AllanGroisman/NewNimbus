// Retenção GFS simples dos backups remotos:
//   - mantém TODOS os dumps das últimas `hourlyWindowH` horas (default 48h)
//   - mais antigos: mantém 1 por dia (o mais recente do dia) até `retainDays` (30)
//   - o resto é descartado
//
// Substitui a rotação antiga por contagem fixa (BACKUP_RETAIN_REMOTE=30), que
// com upload de hora em hora guardaria só ~30 horas de histórico — insuficiente
// pra recuperar de um problema percebido dias depois.

const NAME_RE = /^db-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.sql\.gz$/;

// Timestamp (ms, hora local — mesma timezone do `date` que gera o nome) ou null.
function parseStamp(name) {
  const m = NAME_RE.exec(name);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  const t = new Date(y, mo - 1, d, h, mi, s).getTime();
  return Number.isNaN(t) ? null : t;
}

// Decide o destino de cada snapshot. Nomes fora do padrão nunca são deletados.
function computeRemoteKeep(names, now = Date.now(), opts = {}) {
  const hourlyWindowMs = (opts.hourlyWindowH ?? 48) * 60 * 60 * 1000;
  const retainMs = (opts.retainDays ?? 30) * 24 * 60 * 60 * 1000;

  const keep = [];
  const drop = [];
  const dailyCandidates = [];

  for (const name of names) {
    const t = parseStamp(name);
    if (t == null) { keep.push(name); continue; }
    const age = now - t;
    if (age <= hourlyWindowMs) { keep.push(name); continue; }
    if (age > retainMs) { drop.push(name); continue; }
    dailyCandidates.push({ name, t });
  }

  // Fora da janela horária: sobrevive só o mais recente de cada dia.
  const newestByDay = new Map();
  for (const c of dailyCandidates) {
    const day = c.name.slice(3, 11); // YYYYMMDD do próprio nome
    const cur = newestByDay.get(day);
    if (!cur || c.t > cur.t) newestByDay.set(day, c);
  }
  const survivors = new Set([...newestByDay.values()].map((c) => c.name));
  for (const c of dailyCandidates) {
    (survivors.has(c.name) ? keep : drop).push(c.name);
  }

  return { keep, drop };
}

module.exports = { computeRemoteKeep, parseStamp };
