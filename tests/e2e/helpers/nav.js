// Navegação por cliques no Sidebar (a app é SPA sem router).
// Alguns rótulos se repetem (Mercado Livre / Amazon / Shopee aparecem como página
// do usuário E como página admin) — a seção admin é renderizada DEPOIS, então
// `admin: true` clica na última ocorrência.

import { expect } from "@playwright/test";

export async function gotoPage(page, label, { admin = false } = {}) {
  // Sem exact: os botões do Sidebar têm ícone + label no nome acessível
  // (ex.: "◈ Shopee"), então casamos por substring.
  const btn = page.getByRole("button", { name: label });
  await (admin ? btn.last() : btn.first()).click();
}

// Abre uma campanha pela lista de campanhas do Sidebar.
export async function openCampaign(page, name) {
  await page.getByRole("button", { name }).first().click();
  await expect(page.getByRole("button", { name: "Gerenciar" })).toBeVisible({ timeout: 10000 });
}
