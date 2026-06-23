// Fluxo: Visão Geral + navegação + persistência de navegação no F5.

import { test, expect } from "@playwright/test";
import { loginAsAdmin } from "./helpers/auth.js";
import { gotoPage } from "./helpers/nav.js";

test.describe("Dashboard e navegação", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("Visão Geral mostra estado inicial de campanhas", async ({ page }) => {
    // Sem campanhas → CTA de criar a primeira.
    await expect(page.getByText(/Crie sua primeira campanha|Campanhas/i).first()).toBeVisible();
  });

  test("navega entre páginas pelo Sidebar (sem URL)", async ({ page }) => {
    await gotoPage(page, "Assinatura");
    await expect(page.getByText(/Assinatura|Plano|Stripe|Trial/i).first()).toBeVisible();

    await gotoPage(page, "Configurações");
    await expect(page.getByText(/Conta|Aparência|Tema|Segurança/i).first()).toBeVisible();

    await gotoPage(page, "Shopee");
    await expect(page.getByText(/App ID/i).first()).toBeVisible();
  });

  test("persiste a página atual ao dar F5 (nimbus:nav)", async ({ page }) => {
    await gotoPage(page, "Configurações");
    await expect(page.getByText(/Aparência|Tema|Conta/i).first()).toBeVisible();
    await page.reload();
    // Continua em Configurações (não volta pra Visão Geral).
    await expect(page.getByText(/Aparência|Tema|Conta/i).first()).toBeVisible({ timeout: 10000 });
  });
});
