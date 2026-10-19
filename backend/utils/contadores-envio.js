// Contadores de envio da campanha (sentToday, sentWeek, weekData), no dia e na
// semana de Brasília. Puro, sem banco: o scheduler conta o envio (contaEnvio) e
// o storage corrige na leitura o que ficou velho (contadoresAtuais) — o contador
// só muda quando há envio, então sem isso o "Envios hoje" de ontem seguia na tela.
//
// weekData: 7 posições, 0 = segunda … 6 = domingo (a ordem do MiniBar).

const TZ_BR = "America/Sao_Paulo";

// "AAAA-MM-DD" em Brasília, ou null pra data inválida/ausente ("—" do lastSend).
function diaBR(v) {
  if (v == null || v === "") return null;
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-CA", { timeZone: TZ_BR });
}

function indiceSemana(dia) {
  return (new Date(`${dia}T12:00:00Z`).getUTCDay() + 6) % 7;
}

function segundaDe(dia) {
  const d = new Date(`${dia}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - indiceSemana(dia));
  return d.toISOString().slice(0, 10);
}

const semanaVazia = () => [0, 0, 0, 0, 0, 0, 0];

function semanaDe(weekData) {
  return Array.isArray(weekData) && weekData.length === 7 ? weekData.map(n => Number(n) || 0) : semanaVazia();
}

// Os contadores depois de um envio agora. `ultimoEnvio` é o envio ANTERIOR (o
// history[0] da campanha antes deste): é ele que diz se o dia ou a semana virou.
function contaEnvio({ sentToday, weekData, ultimoEnvio } = {}, now = new Date()) {
  const hoje = diaBR(now);
  const ultimo = diaBR(ultimoEnvio);
  const semana = ultimo && segundaDe(ultimo) === segundaDe(hoje) ? semanaDe(weekData) : semanaVazia();
  semana[indiceSemana(hoje)] += 1;
  return {
    sentToday: ultimo === hoje ? (Number(sentToday) || 0) + 1 : 1,
    sentWeek: semana.reduce((a, b) => a + b, 0),
    weekData: semana,
    lastSend: now.toISOString(),
  };
}

// Os contadores como valem AGORA: último envio de outro dia → hoje é 0; de outra
// semana → a semana zera. Sem último envio conhecido, devolve como veio — não há
// como saber se ficou velho.
function contadoresAtuais({ sentToday, sentWeek, weekData } = {}, ultimoEnvio, now = new Date()) {
  const ultimo = diaBR(ultimoEnvio);
  if (!ultimo) return { sentToday, sentWeek, weekData };
  const hoje = diaBR(now);
  const mesmaSemana = segundaDe(ultimo) === segundaDe(hoje);
  return {
    sentToday: ultimo === hoje ? sentToday : 0,
    sentWeek: mesmaSemana ? sentWeek : 0,
    weekData: mesmaSemana ? weekData : semanaVazia(),
  };
}

module.exports = { diaBR, indiceSemana, segundaDe, contaEnvio, contadoresAtuais };
