// Fluxo admin: Scraping — catálogo (listar/filtrar/apagar) e rodar/cancelar.
// O catálogo é pré-semeado no DB de E2E (sem depender de scraping real).

import { test, expect } from "@playwright/test";
import { loginAsAdmin } from "./helpers/auth.js";
import { gotoPage } from "./helpers/nav.js";
import { seedCatalog, clearCatalog } from "./helpers/seed.js";

test.describe("Admin · Scraping", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("lista, filtra e apaga o catálogo", async ({ page }) => {
    await clearCatalog();
    await seedCatalog(6); // 6 de cada loja → 18 produtos
    await gotoPage(page, "Scraping", { admin: true });
    await expect(page.getByText("Catálogo de produtos")).toBeVisible();

    await page.getByRole("button", { name: /Atualizar/ }).click();
    await expect(page.getByText("Produto ML 1", { exact: true })).toBeVisible({ timeout: 10000 });

    // Filtra por nome.
    await page.getByPlaceholder("Buscar nome...").fill("Produto ML 1");
    await expect(page.getByText("Produto ML 1", { exact: true })).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("Produto Amazon 1", { exact: true })).toHaveCount(0);

    // Limpa o filtro e apaga tudo (window.confirm → aceitar).
    await page.getByPlaceholder("Buscar nome...").fill("");
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: /Apagar todos/ }).click();
    await expect(page.getByText(/Catálogo vazio/)).toBeVisible({ timeout: 10000 });
  });

  test("rodar e cancelar scraping", async ({ page }) => {
    await gotoPage(page, "Scraping", { admin: true });
    await page.getByRole("button", { name: /Rodar agora/ }).click();

    // Tenta cancelar se o botão aparecer (o scraping real pode terminar rápido).
    const cancelar = page.getByRole("button", { name: /Cancelar scraping/ });
    const apareceu = await cancelar.waitFor({ state: "visible", timeout: 8000 }).then(() => true).catch(() => false);
    if (apareceu) {
      page.once("dialog", (d) => d.accept().catch(() => {}));
      await cancelar.click();
    }
    // De qualquer forma, deve voltar ao estado idle ("Rodar agora").
    await expect(page.getByRole("button", { name: /Rodar agora/ })).toBeVisible({ timeout: 90000 });
  });

  test("pausar, ver pausado e descartar", async ({ page }) => {
    await gotoPage(page, "Scraping", { admin: true });
    await page.getByRole("button", { name: /Rodar agora/ }).click();

    // O scraping real pode terminar antes de dar tempo de pausar.
    const pausar = page.getByRole("button", { name: /Pausar/ });
    const apareceu = await pausar.waitFor({ state: "visible", timeout: 8000 }).then(() => true).catch(() => false);
    if (apareceu) {
      await pausar.click();
      const retomar = page.getByRole("button", { name: /Retomar/ });
      const pausou = await retomar.waitFor({ state: "visible", timeout: 90000 }).then(() => true).catch(() => false);
      if (pausou) {
        await expect(page.getByText(/Scraping pausado em \d+ de \d+ passos/)).toBeVisible();
        await page.getByRole("button", { name: /Descartar pausado/ }).click();
      }
    }
    // Sem run pausado, volta ao idle ("Rodar agora") — não deixa estado pro próximo teste.
    await expect(page.getByRole("button", { name: /Rodar agora/ })).toBeVisible({ timeout: 90000 });
  });
});
