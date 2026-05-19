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

// Limpa todas as keys do Redis (nimbus.* + bull.*). Usar entre testes pra
// resetar filas sem fechar conexão.
async function flushRedis() {
  const IORedis = require(path.join(backendDir, "node_modules", "ioredis"));
  const client = new IORedis(process.env.REDIS_URL || "redis://localhost:6379");
  try {
    await client.flushdb();
  } finally {
    client.disconnect();
  }
}

function uniqueEmail(prefix = "user") {
  return `${prefix}-${crypto.randomBytes(4).toString("hex")}@test.local`;
}

async function createTestUser(overrides = {}) {
  const email = overrides.email || uniqueEmail();
  const password = overrides.password || "senha123";
  const name = overrides.name || "Tester";
  const res = await request(app).post("/api/auth/register").send({ name, email, password, phone: "11999999999" });
  if (res.status !== 200) throw new Error(`register falhou: ${res.status} ${JSON.stringify(res.body)}`);
  const { user, token } = res.body;
  return {
    user, token, email, password,
    auth: (method, url) => request(app)[method](url).set("Authorization", `Bearer ${token}`),
  };
}

export {
  app, request, createTestUser, uniqueEmail,
  auth, storage, catalog, scheduler, affiliate, billing, queueMod, wa,
  waMock, waCalls, resetWa, stripeMock,
  setupQueue, teardownQueue, flushRedis, setSendHandler,
};
