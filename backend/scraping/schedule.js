// Agendamento dos scrapers globais (admin-scraper e scrap-tester).
//
// Dois modos:
//   "interval" (default) — roda a cada N minutos contados do último run;
//   "times"              — roda nos horários do dia escolhidos pelo admin.
//
// Mesma mecânica que o preenchimento automático por horários das campanhas
// (scheduler.js: refillTimes/autoRefillDue), com uma diferença: aqui o "já rodei
// esse horário" sai do lastRun persistido em app_config, não de um Map em
// memória — o agendamento sobrevive ao restart do backend.
//
// Tudo em hora LOCAL do servidor, como o resto do agendamento do projeto
// (UTC viraria o dia às 21h no horário de Brasília).

const MAX_TIMES = 12;
// Um horário só dispara se passou há no máximo isso. Sem essa janela, subir o
// processo às 23h refaria todos os horários do dia de uma vez.
const GRACE_MIN = 15;

// Horários "HH:MM" válidos, sem repetidos e em ordem.
function normalizeTimes(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set();
  for (const t of list) {
    const s = String(t || "").trim();
    if (/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) seen.add(s);
  }
  return [...seen].sort().slice(0, MAX_TIMES);
}

function scheduleMode(cfg) {
  return cfg && cfg.scheduleMode === "times" ? "times" : "interval";
}

function minutesOf(hm) {
  const [h, m] = String(hm).split(":");
  return Number(h) * 60 + Number(m);
}

// Data local de hoje (ou de hoje + dayOffset) no horário "HH:MM".
function atTime(now, hm, dayOffset = 0) {
  const d = new Date(now);
  d.setDate(d.getDate() + dayOffset);
  const [h, m] = String(hm).split(":");
  d.setHours(Number(h), Number(m), 0, 0);
  return d;
}

// Quando o próximo run deve acontecer.
// Devolve { at: Date, slot: "HH:MM"|null } ou null quando não há nada agendado
// (modo horários sem nenhum horário válido).
function nextRun(cfg, lastRunISO, now = new Date()) {
  const lastMs = lastRunISO ? new Date(lastRunISO).getTime() : 0;

  if (scheduleMode(cfg) !== "times") {
    const intervalMs = Math.max(1, Number(cfg.intervalMinutes) || 0) * 60 * 1000;
    const dueAt = lastMs ? lastMs + intervalMs : now.getTime() + intervalMs;
    return { at: new Date(Math.max(dueAt, now.getTime())), slot: null };
  }

  const times = normalizeTimes(cfg.times);
  if (!times.length) return null;

  const nowMin = minutesOf(now.toTimeString().slice(0, 5));

  // O horário mais recente que já passou hoje e ainda está dentro da graça —
  // roda agora, a menos que o último run já tenha coberto esse horário.
  let due = null;
  for (const t of times) {
    const tMin = minutesOf(t);
    if (tMin <= nowMin && nowMin - tMin <= GRACE_MIN) due = t;
  }
  if (due && (!lastMs || lastMs < atTime(now, due).getTime())) {
    return { at: new Date(now), slot: due };
  }

  // Senão, o próximo horário ainda por vir hoje; se não houver, o primeiro de amanhã.
  const upcoming = times.find(t => minutesOf(t) > nowMin);
  return upcoming
    ? { at: atTime(now, upcoming), slot: upcoming }
    : { at: atTime(now, times[0], 1), slot: times[0] };
}

module.exports = { MAX_TIMES, GRACE_MIN, normalizeTimes, scheduleMode, nextRun };
