// Playwright config — E2E tests rodam o backend e frontend de verdade.
//
// Pré-requisitos:
//   - Docker compose UP (Postgres + Redis)
//   - DB nimbus_test_e2e migrado (criada pelo globalSetup abaixo)
//   - Frontend dependencies instaladas (npm install em frontend/)
//
// Cada run usa um DB isolado (nimbus_test_e2e) pra não tocar dev/test data.

import { defineConfig } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

// Portas dedicadas pra E2E — não conflita com dev (3001/5173)
const BACKEND_PORT = 3101;
const FRONTEND_PORT = 5273;
const DATABASE_URL = "postgresql://nimbus:nimbus_dev@localhost:5432/nimbus_test_e2e?schema=public";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false, // testes compartilham backend; serializa pra evitar races
  workers: 1,
  retries: 0,
  timeout: 60000,
  expect: { timeout: 5000 },
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${FRONTEND_PORT}`,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  globalSetup: "./e2e/global-setup.js",
  webServer: [
    {
      command: `node server.js`,
      cwd: path.join(root, "backend"),
      port: BACKEND_PORT,
      reuseExistingServer: false,
      timeout: 60000,
      env: {
        NODE_ENV: "test",
        STORAGE_BACKEND: "pg",
        QUEUE_BACKEND: "memory",
        DATABASE_URL,
        PORT: String(BACKEND_PORT),
        LOG_LEVEL: "warn",
        ADMIN_EMAILS: "",
        // Stripe envs vazias → endpoints retornam 501; UI ainda renderiza
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
