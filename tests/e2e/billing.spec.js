// Fluxo externo (só UI): Assinatura — planos renderizam; Stripe desabilitado no
// E2E mostra o aviso "Pagamentos desabilitados". Usa um usuário comum em trial
// (não-admin) pra evitar o banner de bypass do admin.

import { test, expect } from "@playwright/test";
import { createVerifiedUser, seedToken } from "./helpers/auth.js";
import { gotoPage } from "./helpers/nav.js";

test.describe("Assinatura (UI)", () => {
  test("planos renderizam e Stripe aparece desabilitado", async ({ page, request }) => {
    const u = await createVerifiedUser(request);
    await seedToken(page, u.jwt);
    await expect(page.getByRole("button", { name: "Visão Geral" })).toBeVisible({ timeout: 15000 });

    await gotoPage(page, "Assinatura");
    await expect(page.getByText("Básico", { exact: true })).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("Pro", { exact: true })).toBeVisible();
    await expect(page.getByText("Business", { exact: true })).toBeVisible();

    // Stripe desabilitado no E2E.
    await expect(page.getByText(/Pagamentos desabilitados/i)).toBeVisible();
  });
});
