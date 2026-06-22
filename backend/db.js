// Cliente Prisma singleton.

require("./config/loadEnv"); // carrega .env + override por modo (prod | ngrok)

let _prisma = null;

function prisma() {
  if (!_prisma) {
    const { PrismaClient } = require("@prisma/client");
    _prisma = new PrismaClient();
  }
  return _prisma;
}

async function disconnect() {
  if (_prisma) {
    await _prisma.$disconnect();
    _prisma = null;
  }
}

module.exports = { prisma, disconnect };
