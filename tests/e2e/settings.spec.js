// Fluxo: Configurações (conta, aparência/tema, segurança).
// Seções são botões (Conta/Segurança/Notificações/Aparência/Zona de perigo).
// Os inputs da conta não têm placeholder/label associado → usamos role textbox.

import { test, expect } from "@playwright/test";
import { loginAsAdmin } from "./helpers/auth.js";
import { gotoPage } from "./helpers/nav.js";

test.describe("Configurações", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
    await gotoPage(page, "Configurações");
  });

  test("troca o tema e o documento reflete a mudança", async ({ page }) => {
    await page.getByRole("button", { name: "Aparência" }).click();
    await page.getByRole("button", { name: "Escuro" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark", { timeout: 5000 });
    await page.getByRole("button", { name: "Claro" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light", { timeout: 5000 });
  });

  test("edita o nome da conta e persiste", async ({ page }) => {
    await page.getByRole("button", { name: "Conta", exact: true }).click();
    const novoNome = `Admin E2E ${Date.now() % 10000}`;
    const nomeInput = page.getByRole("textbox").first(); // 1º = Nome completo
    await nomeInput.fill(novoNome);
    await page.getByRole("button", { name: "Salvar alterações" }).click();
    await page.reload();
    await gotoPage(page, "Configurações");
    await page.getByRole("button", { name: "Conta", exact: true }).click();
    await expect(page.getByRole("textbox").first()).toHaveValue(novoNome, { timeout: 8000 });
  });

  test("seção Segurança mostra troca de senha", async ({ page }) => {
    await page.getByRole("button", { name: "Segurança" }).click();
    await expect(page.getByText(/senha/i).first()).toBeVisible();
  });
});
