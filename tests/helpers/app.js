// Helper unico que importa o backend ja configurado pra testes.
// IMPORTANTE: a ordem aqui e critica:
//   1. env.js seta NODE_ENV + DATABASE_URL + JWT_SECRET antes de tudo
//   2. wa-mock instala mock no require.cache do whatsapp.js
//   3. backend/server.js entao carrega com o mock no lugar

import "./env.js";
import { installMock, calls as waCalls, reset as resetWa } from "./wa-mock.js";
import { installMock as installStripeMock, calls as stripeCalls, reset as resetStripe, setMock as setStripeMock } from "./stripe-mock.js";
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
const { prisma } = require(path.join(backendDir, "db.js"));

function uniqueEmail(prefix = "user") {
  return `${prefix}-${crypto.randomBytes(4).toString("hex")}@test.local`;
}

async function createTestUser(overrides = {}) {
  const email = overrides.email || uniqueEmail();
  const password = overrides.password || "Senha123";
  const name = overrides.name || "Tester";

  // 1. Registra — backend não devolve token (exige verificação de email)
  const regRes = await request(app).post("/api/auth/register").send({ name, email, password, phone: "11999999999" });
  if (regRes.status !== 200) throw new Error(`register falhou: ${regRes.status} ${JSON.stringify(regRes.body)}`);
  const { user } = regRes.body;

  // 2. Busca o token de verificação direto no DB e confirma o email
  const row = await prisma().user.findUnique({ where: { id: user.id }, select: { emailVerifyToken: true } });
  if (!row?.emailVerifyToken) throw new Error(`emailVerifyToken não encontrado para ${email}`);
  const verifyRes = await request(app).post("/api/auth/verify-email").send({ token: row.emailVerifyToken });
  if (verifyRes.status !== 200) throw new Error(`verify-email falhou: ${verifyRes.status} ${JSON.stringify(verifyRes.body)}`);
  const { token } = verifyRes.body;

  return {
    user,
    token,
    email,
    password,
    auth: (method, url) => request(app)[method](url).set("Authorization", `Bearer ${token}`),
  };
}

export {
  app,
  request,
  createTestUser,
  uniqueEmail,
  auth,
  storage,
  catalog,
  scheduler,
  affiliate,
  billing,
  waMock,
  waCalls,
  resetWa,
  stripeMock,
  stripeCalls,
  resetStripe,
  setStripeMock,
};
