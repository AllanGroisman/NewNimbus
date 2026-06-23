// Fluxo admin (feature nova): filtros da Shopee — pré-seleção (listType) +
// desconto mínimo. Salva, recarrega e confirma persistência.

import { test, expect } from "@playwright/test";
import { loginAsAdmin } from "./helpers/auth.js";
import { gotoPage } from "./helpers/nav.js";

// input do NumField fica como irmão do <label> dentro do mesmo <div>.
function numFieldByLabel(page, labelText) {
  return page.getByText(labelText, { exact: true }).locator("xpath=following-sibling::input");
}

test.describe("Admin · Filtros Shopee", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
    await gotoPage(page, "Shopee", { admin: true }); // última ocorrência = página admin
    await expect(page.getByText("Pré-seleção da Shopee")).toBeVisible({ timeout: 10000 });
  });

  test("escolhe pré-seleção + desconto mínimo, salva e persiste", async ({ page }) => {
    const select = page.getByRole("combobox").first();
    await select.selectOption({ label: "Top performance" });
    const minDiscount = numFieldByLabel(page, "Desconto mínimo (%)");
    await minDiscount.fill("15");

    await page.getByRole("button", { name: "Salvar filtros" }).click();
    await expect(page.getByText(/Filtros salvos/)).toBeVisible({ timeout: 10000 });

    // Recarrega e confirma persistência.
    await page.reload();
    await gotoPage(page, "Shopee", { admin: true });
    await expect(page.getByText("Pré-seleção da Shopee")).toBeVisible();
    await expect(page.getByRole("combobox").first()).toHaveValue("2"); // 2 = Top performance
    await expect(numFieldByLabel(page, "Desconto mínimo (%)")).toHaveValue("15");
  });

  test("'Aplicar recomendados' preenche e mantém o listType", async ({ page }) => {
    const select = page.getByRole("combobox").first();
    await select.selectOption({ label: "Maior comissão" }); // value 1
    await page.getByRole("button", { name: "Aplicar recomendados" }).click();
    // Preencheu campos recomendados e NÃO zerou o listType escolhido.
    await expect(numFieldByLabel(page, "Rating mínimo (0 a 5)")).toHaveValue("4");
    await expect(select).toHaveValue("1");
  });
});
