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

async function disconnect() {
  if (_prisma) {
    await _prisma.$disconnect();
    _prisma = null;
  }
}

module.exports = { prisma, disconnect, urlWithPool };
