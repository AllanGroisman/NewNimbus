// Fluxo: criar / editar / excluir campanha (GroupDashboard).

import { test, expect } from "@playwright/test";
import { loginAsAdmin } from "./helpers/auth.js";

async function createCampaign(page, name) {
  // Abre o modal "Nova campanha" (botão varia entre vazio/com campanhas).
  const novo = page.getByRole("button", { name: /Nova campanha|Criar campanha/ }).first();
  await novo.click();
  await page.getByPlaceholder("Ex: Tech BR").fill(name);
  // Categorias no modal são <div> clicáveis (não <button>) → seleciona por texto.
  await page.getByText("Gamer", { exact: false }).click();
  // exact: o submit é "Criar campanha"; sem isso casaria também o CTA "+ Criar campanha".
  await page.getByRole("button", { name: "Criar campanha", exact: true }).click();
  // Entrou no GroupDashboard.
  await expect(page.getByRole("button", { name: "Gerenciar" })).toBeVisible({ timeout: 10000 });
}

test.describe("Campanha", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("cria campanha e abre o painel da campanha", async ({ page }) => {
    await createCampaign(page, "Campanha E2E");
    // exact: "Visão geral" (tab) senão casa também o sidebar "Visão Geral" (case-insensitive).
    await expect(page.getByRole("button", { name: "Visão geral", exact: true })).toBeVisible();
    await expect(page.getByText("Campanha E2E").first()).toBeVisible();
  });

  test("navega pelas abas da campanha", async ({ page }) => {
    await createCampaign(page, "Campanha Abas");
    for (const tab of ["Gerenciar", "Modelos Mensagens", "Janelas de envio", "Histórico"]) {
      await page.getByRole("button", { name: new RegExp(`^${tab}`) }).click();
    }
    // Aba "Janelas de envio": adiciona uma janela.
    await page.getByRole("button", { name: /Janelas de envio/ }).click();
    await page.getByRole("button", { name: "+ Adicionar janela" }).click();
  });

  test("exclui campanha e ela some após reload", async ({ page }) => {
    await createCampaign(page, "Campanha Apagar");
    await page.getByRole("button", { name: "Gerenciar" }).click();
    await page.getByRole("button", { name: "Excluir campanha" }).click();
    await page.getByRole("button", { name: "Sim, excluir" }).click();
    // Voltou pra lista; recarrega e confirma que sumiu.
    await expect(page.getByRole("button", { name: "Visão Geral" })).toBeVisible({ timeout: 10000 });
    await page.reload();
    await expect(page.getByRole("button", { name: "Visão Geral" })).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("Campanha Apagar")).toHaveCount(0);
  });
});
