// Playwright config — E2E rodam o backend e o frontend de verdade.
//
// Pré-requisitos:
//   - Docker compose UP (Postgres)
//   - DB nimbus_test_e2e migrado (criado pelo globalSetup)
//   - Frontend dependencies instaladas (npm install em frontend/)
//   - npx playwright install chromium (1ª vez)
//
// Cada run usa um DB isolado (nimbus_test_e2e), recriado do zero pelo globalSetup.
// Pra ASSISTIR: `npm run test:e2e:ui` (passo-a-passo) ou `npm run test:e2e:headed`
// (opcional: E2E_SLOWMO=400 deixa cada ação visível).

import { defineConfig } from "@playwright/test";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

// Portas dedicadas pra E2E — não conflita com dev (3001/5173)
const BACKEND_PORT = 3101;
const FRONTEND_PORT = 5273;
const DATABASE_URL = "postgresql://nimbus:nimbus_dev@localhost:5432/nimbus_test_e2e?schema=public";

// Lê chaves do backend/.env sem dependência externa (admin semeado + DB de dev).
function readEnvFile(file) {
  const out = {};
  try {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch { /* sem .env → usa defaults abaixo */ }
  return out;
}
const backendEnv = readEnvFile(path.join(root, "backend", ".env"));
const ADMIN_EMAIL = backendEnv.DEFAULT_ADMIN_EMAIL || "admin@test.local";
const ADMIN_PASSWORD = backendEnv.DEFAULT_ADMIN_PASSWORD || "admin12345";
const ADMIN_NAME = backendEnv.DEFAULT_ADMIN_NAME || "Admin";

// Expõe pros specs/helpers (workers herdam process.env do processo de config).
process.env.E2E_ADMIN_EMAIL = ADMIN_EMAIL;
process.env.E2E_ADMIN_PASSWORD = ADMIN_PASSWORD;
process.env.E2E_BACKEND_URL = `http://localhost:${BACKEND_PORT}`;
process.env.E2E_DATABASE_URL = DATABASE_URL;
process.env.E2E_DEV_DATABASE_URL = backendEnv.DATABASE_URL || "";

const SLOWMO = Number(process.env.E2E_SLOWMO || 0);

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false, // testes compartilham backend; serializa pra evitar races
  workers: 1,
  retries: 1, // E2E real tem flake ocasional (rede/recursos) — 1 retry estabiliza
  timeout: 60000,
  expect: { timeout: 5000 },
  reporter: process.env.CI ? [["list"]] : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: `http://localhost:${FRONTEND_PORT}`,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    launchOptions: { slowMo: SLOWMO },
  },
  // OBS: o setup do DB roda como passo separado nos scripts test:e2e* (node
  // e2e/global-setup.js && playwright test) — NÃO como globalSetup, pois o
  // webServer (backend) sobe e precisa do DB já criado/migrado de antemão.
  webServer: [
    {
      command: `node server.js`,
      cwd: path.join(root, "backend"),
      port: BACKEND_PORT,
      reuseExistingServer: false,
      timeout: 60000,
      env: {
        // IMPORTANTE: config/loadEnv.js usa dotenv override:true, então o .env do
        // backend venceria envs passadas aqui. Usamos o sistema de modos: NIMBUS_MODE=e2e
        // carrega backend/.env.e2e (porta 3101, queue=memory, DB e2e, Stripe off),
        // que sobrepõe o .env. O DEFAULT_ADMIN_* continua vindo do .env (admin real).
        NODE_ENV: "test",
        NIMBUS_MODE: "e2e",
      },
    },
    {
      command: `npx vite --host --port ${FRONTEND_PORT}`,
      cwd: path.join(root, "frontend"),
      port: FRONTEND_PORT,
      reuseExistingServer: false,
      timeout: 60000,
      env: {
        // Vite proxy aponta pra 3001 por padrão (vite.config.js). Override via env.
        VITE_BACKEND_URL: `http://localhost:${BACKEND_PORT}`,
      },
    },
  ],
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
});
