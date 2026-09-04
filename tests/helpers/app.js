// Helper unico que importa o backend ja configurado pra testes.
// IMPORTANTE: a ordem aqui e critica:
//   1. env.js seta NODE_ENV + DATABASE_URL + JWT_SECRET antes de tudo
//   2. wa-mock instala mock no require.cache do whatsapp.js
//   3. backend/server.js entao carrega com o mock no lugar

import "./env.js";
import { installMock, calls as waCalls, reset as resetWa, connect as waConnect, failSend as waFailSend } from "./wa-mock.js";
import { installMock as installStripeMock, calls as stripeCalls, reset as resetStripe, setMock as setStripeMock } from "./stripe-mock.js";
import { installMock as installMailerMock, calls as mailerCalls, reset as resetMailer } from "./mailer-mock.js";
import { installMock as installEmailMock, calls as emailCalls, reset as resetEmail, byKind as emailByKind } from "./email-mock.js";
import { seedSubscription } from "./pg-helpers.js";
const waMock = installMock();
const stripeMock = installStripeMock();
const mailerMock = installMailerMock();
const emailMock = installEmailMock();

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

// CPF válido e aleatório — os 9 primeiros dígitos sorteados, os 2 últimos
// calculados. Toda conta real tem CPF (uma conta = um CPF), então os testes
// precisam de um documento diferente por usuário.
function randomCpf() {
  const base = Array.from({ length: 9 }, () => crypto.randomInt(0, 10));
  for (const [len, pos] of [[9, 10], [10, 11]]) {
    let soma = 0;
    for (let i = 0; i < len; i++) soma += base[i] * (pos - i);
    const resto = (soma * 10) % 11;
    base.push(resto === 10 ? 0 : resto);
  }
  const cpf = base.join("");
  // Sequência repetida é recusada pela validação — sorteia de novo.
  return /^(\d)\1{10}$/.test(cpf) ? randomCpf() : cpf;
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

  // 3. CPF: toda conta tem o seu. `cpf: null` nos overrides simula as contas
  // criadas antes da regra, que o sistema faz preencher na primeira entrada.
  const cpf = overrides.cpf === undefined ? randomCpf() : overrides.cpf;
  // Via auth.setCpf (e não prisma direto) porque é ele quem invalida o cache
  // de usuário do requireAuth — sem isso as rotas ainda veriam a conta sem CPF.
  if (cpf) await auth.setCpf(user.id, cpf);

  // 4. Opcional: assinatura ativa ("basic" | "pro" | "business"). Sem isso o
  // usuário fica no plano free (0 campanhas/números) e leva 402 ao salvar estado.
  if (overrides.plan && overrides.plan !== "free") {
    await seedSubscription(user.id, overrides.plan);
  }

  return {
    user,
    token,
    email,
    password,
    cpf,
    auth: (method, url) => request(app)[method](url).set("Authorization", `Bearer ${token}`),
  };
}

export {
  app,
  request,
  createTestUser,
  seedSubscription,
  uniqueEmail,
  randomCpf,
  auth,
  storage,
  catalog,
  scheduler,
  affiliate,
  billing,
  waMock,
  waCalls,
  resetWa,
  waConnect,
  waFailSend,
  stripeMock,
  stripeCalls,
  resetStripe,
  setStripeMock,
  mailerMock,
  mailerCalls,
  resetMailer,
  emailMock,
  emailCalls,
  resetEmail,
  emailByKind,
};
