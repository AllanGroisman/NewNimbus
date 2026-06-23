// Fluxo admin: Usuários, Backups, Notificações + gating (usuário comum não vê admin).

import { test, expect } from "@playwright/test";
import { loginAsAdmin, createVerifiedUser, seedToken } from "./helpers/auth.js";
import { gotoPage } from "./helpers/nav.js";

test.describe("Admin · diversos", () => {
  test("Usuários lista o admin (e um usuário criado)", async ({ page, request }) => {
    const novo = await createVerifiedUser(request);
    await loginAsAdmin(page);
    await gotoPage(page, "Usuários", { admin: true });
    await expect(page.getByText(process.env.E2E_ADMIN_EMAIL, { exact: false })).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(novo.email, { exact: false })).toBeVisible({ timeout: 10000 });
  });

  test("Backups e Notificações renderizam", async ({ page }) => {
    await loginAsAdmin(page);
    await gotoPage(page, "Backups", { admin: true });
    await expect(page.getByText(/Backup/i).first()).toBeVisible({ timeout: 10000 });
    await gotoPage(page, "Notificações", { admin: true });
    await expect(page.getByText(/Notifica/i).first()).toBeVisible({ timeout: 10000 });
  });

  test("usuário comum NÃO vê a seção admin (gating)", async ({ page, request }) => {
    const u = await createVerifiedUser(request);
    await seedToken(page, u.jwt);
    // Logado como usuário comum.
    await expect(page.getByRole("button", { name: "Visão Geral" })).toBeVisible({ timeout: 15000 });
    // Itens admin não aparecem.
    await expect(page.getByRole("button", { name: "Scraping" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Usuários" })).toHaveCount(0);
  });
});
