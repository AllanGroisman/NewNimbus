// Fluxo externo (só UI): WhatsApp — abre o modal de adicionar número e inicia o
// QR. NÃO assere "conectado" (precisa de aparelho real).

import { test, expect } from "@playwright/test";
import { loginAsAdmin } from "./helpers/auth.js";
import { gotoPage } from "./helpers/nav.js";

test.describe("WhatsApp (UI)", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
    await gotoPage(page, "WhatsApp");
  });

  test("abre o modal de adicionar número e inicia o QR", async ({ page }) => {
    await page.getByRole("button", { name: "+ Adicionar número" }).first().click();
    await expect(page.getByText("Adicionar novo número")).toBeVisible({ timeout: 10000 });
    await page.getByPlaceholder("Ex: Principal, Trabalho...").fill("E2E");

    // O WhatsappQR inicia a sessão → mostra "Conectando..." e depois o QR.
    await expect(page.getByText(/Conectando ao WhatsApp/i)).toBeVisible({ timeout: 10000 });
    // QR é best-effort (depende do Baileys gerar a tempo) — não falha se não vier.
    const qr = page.getByAltText("QR Code WhatsApp");
    await qr.waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  });

  test("oferece o modo código de 8 dígitos com campo de telefone", async ({ page }) => {
    // Só a UI: pedir o código de verdade exigiria o Baileys falando com o WhatsApp.
    await page.getByRole("button", { name: "+ Adicionar número" }).first().click();
    await expect(page.getByText("Adicionar novo número")).toBeVisible({ timeout: 10000 });

    await page.getByRole("button", { name: "Código de 8 dígitos" }).click();
    await expect(page.getByPlaceholder("(11) 99999-9999")).toBeVisible();
    await expect(page.getByRole("button", { name: "Gerar código" })).toBeVisible();
  });
});
