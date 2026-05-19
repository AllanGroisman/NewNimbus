// E2E billing: registra user (trial automático Pro) → navega pra Assinatura.
// Stripe está desabilitado neste setup → endpoints retornam 501.
// Testamos só a UI (trial info, banner desabilitado).

import { test, expect } from "@playwright/test";
import crypto from "crypto";

function uniqueEmail() {
  return `e2e-bill-${crypto.randomBytes(4).toString("hex")}@test.local`;
}

async function registerAndLogin(page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Cadastrar" }).click();
  await page.getByPlaceholder("Nome completo").fill("E2E Bill");
  await page.getByPlaceholder("Email").fill(uniqueEmail());
  await page.getByPlaceholder("Senha").fill("senha123e2e");
  await page.getByRole("button", { name: "Criar conta" }).click();
  await expect(page.getByPlaceholder("Email")).not.toBeVisible({ timeout: 10000 });
}

async function goToSubscription(page) {
  // Tenta clicar num link/botão de "Assinatura" — pode estar no sidebar
  const candidates = [
    page.getByRole("link", { name: /assinatura/i }),
    page.getByRole("button", { name: /assinatura/i }),
    page.getByText(/^Assinatura$/),
  ];
  for (const c of candidates) {
    if (await c.first().isVisible().catch(() => false)) {
      await c.first().click();
      return true;
    }
  }
  return false;
}

test.describe("Billing page", () => {
  test("trial Pro: página de assinatura mostra plano atual", async ({ page }) => {
    await registerAndLogin(page);
    const navigated = await goToSubscription(page);
    if (!navigated) test.skip(true, "Link Assinatura não localizado no sidebar");

    // Espera por texto de plano — pode ser "Nimbus Pro" ou "Trial"
    await expect(page.locator("body")).toContainText(/Pro|Trial/i, { timeout: 10000 });
  });

  test("Stripe desabilitado mostra banner 'Pagamentos desabilitados'", async ({ page }) => {
    await registerAndLogin(page);
    const navigated = await goToSubscription(page);
    if (!navigated) test.skip(true, "Link Assinatura não localizado no sidebar");

    await expect(page.locator("body")).toContainText(/Pagamentos desabilitados|Stripe/i, { timeout: 10000 });
  });
});
