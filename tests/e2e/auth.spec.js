// Fluxo: autenticação (cadastro, login, logout, recuperar senha).
// Login.jsx usa placeholders (não labels) → getByPlaceholder. Há dois "Entrar"
// (tab + submit) → desambigua via button[type="submit"].

import { test, expect } from "@playwright/test";
import { loginAsAdmin, logout, uniqueEmail } from "./helpers/auth.js";

test.describe("Autenticação", () => {
  test("cadastro cai na tela de 'confirme seu email' (não loga direto)", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Cadastrar" }).click();
    await page.getByPlaceholder("Nome completo").fill("Teste E2E");
    // Telefone é obrigatório no cadastro; o campo mascara enquanto digita.
    await page.getByPlaceholder("WhatsApp (com DDD)").fill("11999999999");
    const email = uniqueEmail();
    await page.getByPlaceholder("Email").fill(email);
    // exact: "Senha" senão casa também "Confirmar senha".
    await page.getByPlaceholder("Senha", { exact: true }).fill("Senha123");
    await page.getByPlaceholder("Confirmar senha").fill("Senha123");
    await page.getByRole("button", { name: "Criar conta" }).click();

    // Backend exige verificação → tela "Confirme seu email".
    await expect(page.getByText(/Confirme seu email/i)).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/Enviamos um link de confirmação/i)).toBeVisible();
  });

  test("login inválido mostra erro", async ({ page }) => {
    await page.goto("/");
    await page.getByPlaceholder("Email").fill("naoexiste@test.local");
    await page.getByPlaceholder("Senha").fill("senhaerrada");
    await page.locator('button[type="submit"]').click();
    await expect(page.locator("body")).toContainText(/credenc|inválid|incorret|erro|não/i, { timeout: 5000 });
  });

  test("login do admin carrega o app", async ({ page }) => {
    await loginAsAdmin(page);
    await expect(page.getByRole("button", { name: "Visão Geral" })).toBeVisible();
    // Admin enxerga a seção admin (ex.: Scraping).
    await expect(page.getByRole("button", { name: "Scraping" })).toBeVisible();
  });

  test("logout volta pra tela de login", async ({ page }) => {
    await loginAsAdmin(page);
    await logout(page);
    await expect(page.getByPlaceholder("Email")).toBeVisible();
  });

  test("tela de recuperar senha renderiza", async ({ page }) => {
    await page.goto("/");
    await page.getByText("Esqueci minha senha").click();
    await expect(page.getByText(/Recuperar acesso/i)).toBeVisible();
    await expect(page.getByRole("button", { name: "Enviar link de reset" })).toBeVisible();
  });
});
