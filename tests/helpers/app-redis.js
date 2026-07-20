// Variante de app.js pra testes em redis mode.
//
// Diferenças do app.js padrão:
//   1. Importa env-redis.js (seta QUEUE_BACKEND=redis)
//   2. Inicia a queue (BullMQ) com producer+consumer
//   3. Registra os handlers de send (scheduler.processSendJob) e control
//      (inline — handleControlJob é privado em worker.js, replicamos aqui)
//   4. Expõe queue + helpers de truncate de filas
//
// Uso: `import { app, request, ... } from "../helpers/app-redis.js";`

import "./env-redis.js";
import { installMock, calls as waCalls, reset as resetWa } from "./wa-mock.js";
import { installMock as installStripeMock } from "./stripe-mock.js";

const waMock = installMock();
const stripeMock = installStripeMock();

import request from "supertest";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

const backendDir = path.resolve(__dirname, "..", "..", "backend");

const { app } = require(path.join(backendDir, "server.js"));
const auth = require(path.join(backendDir, "auth"));
const storage = require(path.join(backendDir, "storage"));
const catalog = require(path.join(backendDir, "catalog"));
const scheduler = require(path.join(backendDir, "scheduler.js"));
const affiliate = require(path.join(backendDir, "scraping", "affiliate.js"));
const billing = require(path.join(backendDir, "billing"));
const queueMod = require(path.join(backendDir, "infra", "queue.js"));
const wa = require(path.join(backendDir, "whatsapp")); // mock (instalado acima)
const appConfig = require(path.join(backendDir, "config"));

let _initialized = false;
let _testSendHandler = null; // permite testes overridarem o handler de send (pra simular falhas)

async function setupQueue() {
  if (_initialized) return;
  // Baseline limpa ANTES de criar os workers — seguro dar flushdb aqui porque
  // nenhum Worker BullMQ está vivo ainda. Entre testes NÃO se pode fazer isso
  // (ver cleanQueues): flushdb apaga os markers internos do BullMQ e desincroniza
  // os workers vivos, deixando jobs presos em "waiting".
  await flushRedis();
  await appConfig.warmup();
  await queueMod.init({ producer: true, consumer: true });
  queueMod.setSendHandler(async (job) => {
    if (_testSendHandler) return _testSendHandler(job);
    return scheduler.processSendJob(job);
  });
  // Handler de control — réplica simples de worker.handleControlJob.
  queueMod.setControlHandler(async (job) => {
    const { op, args = [] } = job.data || {};
    const fn = wa[op];
    if (typeof fn !== "function") throw new Error(`wa.${op} não existe (mock)`);
    return fn(...args);
  });
  _initialized = true;
}

function setSendHandler(fn) {
  _testSendHandler = fn;
}

async function teardownQueue() {
  if (!_initialized) return;
  await queueMod.close();
  _initialized = false;
  _testSendHandler = null;
}

// Limpa todas as keys do Redis (flushdb bruto). SÓ é seguro quando NÃO há
// Worker BullMQ vivo (ex.: baseline no setupQueue, antes dos workers). Entre
// testes, use cleanQueues() — flushdb embaixo de um worker vivo apaga os
// markers internos do BullMQ e trava o consumo de jobs.
async function flushRedis() {
  const IORedis = require(path.join(backendDir, "node_modules", "ioredis"));
  const client = new IORedis(process.env.REDIS_URL || "redis://localhost:6379");
  try {
    await client.flushdb();
  } finally {
    client.disconnect();
  }
}

// Limpeza entre testes SEM quebrar os workers vivos: usa a própria API do
// BullMQ (drain + clean) via handles efêmeros das mesmas filas. drain remove
// waiting+delayed; clean remove os estados terminais. Diferente do flushdb,
// não toca nos markers, então o worker continua consumindo normalmente.
const QUEUE_NAMES = ["nimbus.send-message", "nimbus.control"]; // = SEND_QUEUE/CONTROL_QUEUE em infra/queue.js
async function cleanQueues() {
  if (!queueMod.isRedis()) return;
  const { Queue } = require(path.join(backendDir, "node_modules", "bullmq"));
  const IORedis = require(path.join(backendDir, "node_modules", "ioredis"));
  const connection = new IORedis(process.env.REDIS_URL || "redis://localhost:6379", {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  try {
    for (const name of QUEUE_NAMES) {
      const q = new Queue(name, { connection });
      try {
        await q.drain(true); // remove waiting + delayed
        for (const st of ["completed", "failed", "wait", "active", "delayed", "paused"]) {
          try { await q.clean(0, 100000, st); } catch { /* estado pode não existir */ }
        }
      } finally {
        await q.close();
      }
    }
  } finally {
    connection.disconnect();
  }
}

function uniqueEmail(prefix = "user") {
  return `${prefix}-${crypto.randomBytes(4).toString("hex")}@test.local`;
}

async function createTestUser(overrides = {}) {
  const email = overrides.email || uniqueEmail();
  const password = overrides.password || "Senha123";
  const name = overrides.name || "Tester";

  // 1. Registra — sem token (exige verificação de email)
  const regRes = await request(app).post("/api/auth/register").send({ name, email, password, phone: "11999999999" });
  if (regRes.status !== 200) throw new Error(`register falhou: ${regRes.status} ${JSON.stringify(regRes.body)}`);
  const { user } = regRes.body;

  // 2. Verifica email via DB direto → obtém token JWT
  const { prisma } = require(path.join(backendDir, "db.js"));
  const row = await prisma().user.findUnique({ where: { id: user.id }, select: { emailVerifyToken: true } });
  if (!row?.emailVerifyToken) throw new Error(`emailVerifyToken não encontrado para ${email}`);
  const verifyRes = await request(app).post("/api/auth/verify-email").send({ token: row.emailVerifyToken });
  if (verifyRes.status !== 200) throw new Error(`verify-email falhou: ${verifyRes.status} ${JSON.stringify(verifyRes.body)}`);
  const { token } = verifyRes.body;

  return {
    user, token, email, password,
    auth: (method, url) => request(app)[method](url).set("Authorization", `Bearer ${token}`),
  };
}

export {
  app, request, createTestUser, uniqueEmail,
  auth, storage, catalog, scheduler, affiliate, billing, queueMod, wa,
  waMock, waCalls, resetWa, stripeMock,
  setupQueue, teardownQueue, flushRedis, cleanQueues, setSendHandler,
};
