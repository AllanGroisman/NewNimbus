// Helper unico que importa o backend ja configurado pra testes.
// IMPORTANTE: a ordem aqui e critica:
//   1. env.js setta NIMBUS_DATA_DIR + NODE_ENV antes de tudo
//   2. wa-mock instala mock no require.cache do whatsapp.js
//   3. backend/server.js entao carrega com o mock no lugar

import "./env.js";
import { installMock, calls as waCalls, reset as resetWa } from "./wa-mock.js";
const waMock = installMock();

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
  waMock,
  waCalls,
  resetWa,
};
