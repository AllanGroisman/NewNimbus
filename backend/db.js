// Cliente Prisma singleton.

require("./config/loadEnv"); // carrega .env + override por modo (prod | ngrok)

let _prisma = null;

// O pool do Prisma tem default `num_cpus * 2 + 1` — nesta VPS de 1 core isso dá
// TRÊS conexões. Não é o bastante para o worker: cada mensagem do WhatsApp
// grava chaves Signal (`baileys_auth`), e uma rajada de reenvios — dezenas de
// participantes de um grupo pedindo a mesma mensagem de volta — esgotava o pool
// com "Timed out fetching a new connection from the connection pool". Isso não
// é só lentidão: uma falha de gravação de chave derruba o socket de propósito
// (`onPersistError` em whatsapp/local.js, para a reconexão reler o banco), e a
// reconexão no meio dos reenvios é justamente o que deixa o "Aguardando
// mensagem" preso no celular do destinatário.
const POOL_SIZE = Number(process.env.PRISMA_CONNECTION_LIMIT) || 10;

function urlWithPool(url) {
  if (!url) return url;
  try {
    const u = new URL(url);
    // Respeita quem já configurou explicitamente na DATABASE_URL.
    if (!u.searchParams.has("connection_limit")) {
      u.searchParams.set("connection_limit", String(POOL_SIZE));
    }
    if (!u.searchParams.has("pool_timeout")) {
      u.searchParams.set("pool_timeout", "20");
    }
    return u.toString();
  } catch {
    // URL fora do formato esperado (ou um provider que não é postgres): melhor
    // subir com o default do Prisma do que não subir.
    return url;
  }
}

function prisma() {
  if (!_prisma) {
    const { PrismaClient } = require("@prisma/client");
    const url = urlWithPool(process.env.DATABASE_URL);
    _prisma = url
      ? new PrismaClient({ datasources: { db: { url } } })
      : new PrismaClient();
  }
  return _prisma;
}

// Espera o Postgres aceitar query antes de o boot seguir.
//
// Sem isso, `docker compose up` + PM2 viravam um crash-loop: o Postgres leva
// alguns segundos pra sair do "the database system is starting up", o warmup do
// auth estourava PrismaClientInitializationError, o processo morria com exit 1 e
// o PM2 subia outro — que relia `node_modules` inteiro do disco e falhava de
// novo. Foram 14 reinícios do server e 16 do worker num boot só, o que num HD
// mecânico é o que mais pesa na inicialização da máquina.
//
// Erro de credencial/URL não fica retentando pra sempre: o número de tentativas
// é limitado, então uma DATABASE_URL errada ainda falha o boot — só que depois
// da janela, com a última mensagem do banco preservada.
const DB_READY_ATTEMPTS = Number(process.env.DB_READY_ATTEMPTS) || 20;
const DB_READY_INTERVAL_MS = Number(process.env.DB_READY_INTERVAL_MS) || 1500;

// A mensagem do Prisma vem multi-linha e a primeira linha é só o boilerplate
// ("Invalid `prisma.$queryRaw()` invocation:"). A causa útil — "the database
// system is starting up", "Can't reach database server", "password
// authentication failed" — está mais abaixo.
function dbErrorSummary(err) {
  const raw = String((err && err.message) || err || "");
  const lines = raw.split("\n").map(l => l.trim()).filter(Boolean);
  const useful = lines.find(l => /Error querying|Can't reach|FATAL|ECONNREFUSED|ETIMEDOUT|authentication/i.test(l));
  return useful || lines[lines.length - 1] || raw;
}

async function waitForReady({
  attempts = DB_READY_ATTEMPTS,
  intervalMs = DB_READY_INTERVAL_MS,
} = {}) {
  // Nos testes o banco já está de pé (ou é mockado) — esperar só atrasaria a suíte.
  if (process.env.NODE_ENV === "test") return;

  let lastErr = null;
  for (let i = 1; i <= attempts; i++) {
    try {
      await prisma().$queryRaw`SELECT 1`;
      if (i > 1) console.log(`[db] Postgres pronto (tentativa ${i}/${attempts})`);
      return;
    } catch (err) {
      lastErr = err;
      if (i === attempts) break;
      console.warn(`[db] Postgres indisponível (${i}/${attempts}), aguardando ${intervalMs}ms — ${dbErrorSummary(err)}`);
      await new Promise(r => setTimeout(r, intervalMs));
    }
  }
  throw lastErr;
}

async function disconnect() {
  if (_prisma) {
    await _prisma.$disconnect();
    _prisma = null;
  }
}

module.exports = { prisma, disconnect, urlWithPool, waitForReady };
