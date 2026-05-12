// Cliente Prisma singleton + helper de seleção de backend.
// Lazy: só instancia o PrismaClient se STORAGE_BACKEND=pg.

require("dotenv").config();

const BACKEND = (process.env.STORAGE_BACKEND || "json").toLowerCase();

let _prisma = null;

function prisma() {
  if (BACKEND !== "pg") {
    throw new Error("[db] Prisma só está disponível quando STORAGE_BACKEND=pg");
  }
  if (!_prisma) {
    const { PrismaClient } = require("@prisma/client");
    _prisma = new PrismaClient();
  }
  return _prisma;
}

function isPg() {
  return BACKEND === "pg";
}

function backendName() {
  return BACKEND;
}

async function disconnect() {
  if (_prisma) {
    await _prisma.$disconnect();
    _prisma = null;
  }
}

module.exports = { prisma, isPg, backendName, disconnect };
