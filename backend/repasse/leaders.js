// Grupos líderes de uma campanha de repasse.
//
// O dado vive dentro de `Group.scraping` (jsonb), sem tabela própria:
//
//   scraping.repasse = { leaders: [{ numberId, jid, name }, ...] }
//
// Formato antigo (uma campanha = um líder), ainda encontrado em campanhas que
// não foram salvas desde a mudança:
//
//   scraping.repasse = { leaderNumberId, leaderJid, leaderName }
//
// Todo mundo lê pelo `leadersOf`; a conversão pro array acontece no primeiro
// save da campanha (storage/pg.js), então não precisa de migration.

// Sempre um array de { numberId, jid, name }. Descarta entrada sem numberId ou
// jid (líder órfão não indexa nada) e deduplica por numberId::jid.
function leadersOf(scraping) {
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

// Devolve o `scraping` com `repasse` no formato novo, sem as chaves legadas.
// Só mexe em campanha de repasse — nas de scraping o campo nem existe.
function normalizeRepasse(scraping) {
  const sc = scraping || {};
  if (sc.kind !== "repasse") return sc;
  const repasse = { leaders: leadersOf(sc) };
  // Formato da mensagem (repasse/original-message.js) mora junto dos líderes.
  if (sc.repasse?.messageMode === "original" || sc.repasse?.messageMode === "template") {
    repasse.messageMode = sc.repasse.messageMode;
  }
  return { ...sc, repasse };
}

module.exports = { leadersOf, normalizeRepasse };
