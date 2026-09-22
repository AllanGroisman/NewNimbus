// Grupos líderes de uma campanha de repasse.
//
// Formato atual: scraping.repasse = { leaders: [{ numberId, jid, name }, ...] }
// Formato antigo (um líder só): { leaderNumberId, leaderJid, leaderName } —
// campanha que ainda não foi salva desde a mudança chega assim do backend.
// Espelha backend/repasse/leaders.js.

export function leadersOf(scraping) {
  const rp = scraping?.repasse;
  if (!rp) return [];
  const raw = Array.isArray(rp.leaders)
    ? rp.leaders
    : [{ numberId: rp.leaderNumberId, jid: rp.leaderJid, name: rp.leaderName }];
  const out = [];
  const seen = new Set();
  for (const l of raw) {
    if (!l || !l.numberId || !l.jid) continue;
    const key = `${l.numberId}::${l.jid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ numberId: String(l.numberId), jid: String(l.jid), name: l.name || null });
  }
  return out;
}

// Substitui a lista de líderes mantendo o resto do scraping intacto (e some
// com as chaves do formato antigo).
export function withLeaders(scraping, leaders) {
  const { repasse, ...rest } = scraping || {};
  // messageMode mora junto dos líderes e não pode sumir ao trocar a lista.
  const next = { leaders };
  if (repasse?.messageMode) next.messageMode = repasse.messageMode;
  return { ...rest, repasse: next };
}
