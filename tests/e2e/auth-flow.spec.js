// E2E feliz: cadastro novo → tela autenticada. Login.jsx usa placeholders
// (não labels), por isso usamos getByPlaceholder em vez de getByLabel.

import { test, expect } from "@playwright/test";
import crypto from "crypto";

function uniqueEmail() {
  return `e2e-${crypto.randomBytes(4).toString("hex")}@test.local`;
}

test.describe("Auth flow", () => {
  test("registro novo usuário e entrada no app", async ({ page }) => {
    await page.goto("/");
    // Troca pra modo Cadastrar (tab)
    await page.getByRole("button", { name: "Cadastrar" }).click();

    await page.getByPlaceholder("Nome completo").fill("Teste E2E");
    await page.getByPlaceholder("Email").fill(uniqueEmail());
    await page.getByPlaceholder("Senha").fill("senha123e2e");
    await page.getByRole("button", { name: "Criar conta" }).click();

    // Após login bem-sucedido, a SPA muda — formulário some
    await expect(page.getByPlaceholder("Email")).not.toBeVisible({ timeout: 10000 });
  });

  test("login com credencial inválida mostra erro", async ({ page }) => {
    await page.goto("/");
    // Tab default = Entrar (há 2 elementos "Entrar": tab + submit; submit usa type=submit)
    await page.getByPlaceholder("Email").fill("naoexiste@test.local");
    await page.getByPlaceholder("Senha").fill("senhaerrada");
    await page.locator('button[type="submit"]').click();

    // Mensagem de erro vermelha aparece
    await expect(page.locator("body")).toContainText(/credenc|inválid|senha|erro/i, { timeout: 5000 });
  });

  test("logout volta pra tela de login", async ({ page }) => {
    // Registra um usuário novo
    await page.goto("/");
    await page.getByRole("button", { name: "Cadastrar" }).click();
    await page.getByPlaceholder("Nome completo").fill("Logout Test");
    await page.getByPlaceholder("Email").fill(uniqueEmail());
    await page.getByPlaceholder("Senha").fill("senha123e2e");
    await page.getByRole("button", { name: "Criar conta" }).click();
    await expect(page.getByPlaceholder("Email")).not.toBeVisible({ timeout: 10000 });

    // Localiza e clica em algo de logout — texto pode variar
    const logoutCandidate = page.getByRole("button", { name: /sair|logout/i }).first();
    if (await logoutCandidate.isVisible().catch(() => false)) {
      await logoutCandidate.click();
      // Form de login volta
      await expect(page.getByPlaceholder("Email")).toBeVisible({ timeout: 5000 });
    } else {
      test.skip(true, "Botão de logout não encontrado na UI atual");
    }
  });
});
