// Helpers de autenticação pro E2E.
// - loginAsAdmin: loga pela UI com o admin semeado (DEFAULT_ADMIN_* do backend/.env).
// - createVerifiedUser: cria um usuário comum verificado via API + token no DB.
// - seedToken / clearSession: atalhos de sessão via localStorage.

import { expect } from "@playwright/test";
import crypto from "crypto";
import { prismaFor, E2E_DATABASE_URL } from "./db.js";

const BACKEND_URL = process.env.E2E_BACKEND_URL || "http://localhost:3101";

export function uniqueEmail() {
  return `e2e-${crypto.randomBytes(4).toString("hex")}@test.local`;
}

// Limpa token + navegação salvos (cada teste já roda em contexto isolado, mas
// deixa explícito quando reusamos a mesma página).
export async function clearSession(page) {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.removeItem("nimbus.token");
    localStorage.removeItem("nimbus:nav");
  });
}

// Loga pela UI como o admin semeado e espera o app carregar (Sidebar visível).
export async function loginAsAdmin(page) {
  const email = process.env.E2E_ADMIN_EMAIL;
  const password = process.env.E2E_ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error("E2E_ADMIN_EMAIL/PASSWORD ausentes — playwright.config lê do backend/.env");
  }
  await page.goto("/");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Senha").fill(password);
  await page.locator('button[type="submit"]').click();
  await expect(page.getByRole("button", { name: "Visão Geral" })).toBeVisible({ timeout: 25000 });
}

export async function logout(page) {
  await page.getByRole("button", { name: /sair/i }).first().click();
  await expect(page.getByPlaceholder("Email")).toBeVisible({ timeout: 10000 });
}

// Cria um usuário comum (não-admin) já verificado: register → pega o
// emailVerifyToken no DB de E2E → verify-email → devolve o JWT.
export async function createVerifiedUser(request, overrides = {}) {
  const email = overrides.email || uniqueEmail();
  const password = overrides.password || "Senha123";
  const name = overrides.name || "Tester E2E";

  let res = await request.post(`${BACKEND_URL}/api/auth/register`, {
    data: { name, email, password, phone: "11999999999" },
  });
  if (!res.ok()) throw new Error(`register falhou: ${res.status()} ${await res.text()}`);
  const { user } = await res.json();

  const db = prismaFor(E2E_DATABASE_URL);
  let verifyToken;
  try {
    const row = await db.user.findUnique({ where: { id: user.id }, select: { emailVerifyToken: true } });
    verifyToken = row?.emailVerifyToken;
  } finally {
    await db.$disconnect().catch(() => {});
  }
  if (!verifyToken) throw new Error(`emailVerifyToken não encontrado para ${email}`);

  res = await request.post(`${BACKEND_URL}/api/auth/verify-email`, { data: { token: verifyToken } });
  if (!res.ok()) throw new Error(`verify-email falhou: ${res.status()} ${await res.text()}`);
  const { token: jwt } = await res.json();

  return { email, password, name, jwt, userId: user.id };
}

// Injeta um JWT no localStorage e recarrega (entra no app sem passar pela UI).
export async function seedToken(page, jwt) {
  await page.goto("/");
  await page.evaluate((t) => localStorage.setItem("nimbus.token", t), jwt);
  await page.reload();
}
