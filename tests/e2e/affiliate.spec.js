// Fluxo: configuração de afiliados (Mercado Livre, Amazon, Shopee).
// SALVAR é interno (sem chamada externa) → fluxo salvar→configurado→Apagar é
// determinístico. Usa os códigos REAIS da conta (DB de dev, read-only) quando
// disponíveis; senão usa valores válidos de teste. O botão "Testar" (chamada
// externa) não é asserido com rigor.

import { test, expect } from "@playwright/test";
import { loginAsAdmin } from "./helpers/auth.js";
import { gotoPage } from "./helpers/nav.js";
import { getRealAffiliateCreds } from "./helpers/seed.js";

let real = null;
test.beforeAll(async () => {
  real = await getRealAffiliateCreds().catch(() => null);
});

test.describe("Afiliados", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("Mercado Livre: salvar → configurado → Apagar", async ({ page }) => {
    await gotoPage(page, "Mercado Livre"); // primeira ocorrência = página do usuário
    const tag = real?.ml?.tag || "e2e-ml-tag";
    const cookie = real?.ml?.cookie || "_d2id=e2e-cookie-teste-1234567890";
    await page.getByPlaceholder(/^ex: pb/).fill(tag);
    await page.getByPlaceholder(/Cole aqui o conteúdo de document.cookie/).fill(cookie);
    await page.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByRole("button", { name: "Apagar" })).toBeVisible({ timeout: 10000 });
    await page.getByRole("button", { name: "Apagar" }).click();
    await expect(page.getByRole("button", { name: "Apagar" })).toHaveCount(0, { timeout: 10000 });
  });

  test("Amazon: salvar → configurado → Apagar", async ({ page }) => {
    await gotoPage(page, "Amazon");
    const tag = real?.amazon?.tag || "e2eteste-20";
    await page.getByPlaceholder(/^ex: pedroguterres/).fill(tag);
    await page.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByRole("button", { name: "Apagar" })).toBeVisible({ timeout: 10000 });
    await page.getByRole("button", { name: "Apagar" }).click();
    await expect(page.getByRole("button", { name: "Apagar" })).toHaveCount(0, { timeout: 10000 });
  });

  test("Shopee: salvar → configurado → Apagar", async ({ page }) => {
    await gotoPage(page, "Shopee");
    const appId = real?.shopee?.appId || "12345678";
    const appSecret = real?.shopee?.appSecret || "0123456789abcdef0123";
    await page.getByPlaceholder("ex: 12345678").fill(appId);
    await page.getByPlaceholder(/cole o App Secret/i).fill(appSecret);
    await page.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByRole("button", { name: "Apagar" })).toBeVisible({ timeout: 10000 });
    await page.getByRole("button", { name: "Apagar" }).click();
    await expect(page.getByRole("button", { name: "Apagar" })).toHaveCount(0, { timeout: 10000 });
  });
});
