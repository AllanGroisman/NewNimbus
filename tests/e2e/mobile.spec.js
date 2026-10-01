// Celular (task 5): o sistema tem que caber num telefone de 360px.
//
// As duas causas do "a página abre com zoom" eram:
//   1. conteúdo mais largo que a tela — o navegador deixa arrastar pro lado e é
//      preciso tirar o zoom pra ver tudo;
//   2. input com fonte menor que 16px — o iPhone amplia a página ao focar.
// Este spec passa por todas as rotas (cliente e admin) e pelas abas de uma
// campanha e falha se alguma das duas voltar. Roda só no projeto "mobile" do
// playwright.config.js. Os screenshots de cada tela ficam em test-results/ pra
// conferir a olho.

import { test, expect } from "@playwright/test";
import { PAGE_TO_PATH } from "../../frontend/src/data/constants.js";
import { createVerifiedUser } from "./helpers/auth.js";
import { prismaFor, E2E_DATABASE_URL } from "./helpers/db.js";

const BACKEND_URL = process.env.E2E_BACKEND_URL || "http://localhost:3101";

// Admin próprio do spec: cria um usuário verificado, promove no banco de E2E e
// loga de novo (o papel vai dentro do token). Não depende do admin semeado pelo
// DEFAULT_ADMIN_*, que só existe quando o .env tem uma senha forte o bastante.
async function criarAdmin(request) {
  const u = await createVerifiedUser(request);
  const db = prismaFor(E2E_DATABASE_URL);
  try {
    await db.user.update({ where: { id: u.userId }, data: { role: "admin" } });
  } finally {
    await db.$disconnect().catch(() => {});
  }
  return u;
}

// Loga por API e entra com o token: no celular a sidebar fica escondida, e o
// login pela UI dos outros specs procura botões dela.
async function entrarComoAdmin(page, request) {
  const { email, password } = await criarAdmin(request);
  const res = await request.post(`${BACKEND_URL}/api/auth/login`, { data: { email, password } });
  expect(res.ok(), `login falhou: ${res.status()}`).toBeTruthy();
  const { token } = await res.json();
  await page.goto("/");
  await page.evaluate((t) => localStorage.setItem("nimbus.token", t), token);
  await page.reload();
  await expect(page.getByRole("button", { name: "Abrir menu" })).toBeVisible({ timeout: 25000 });
  await pularTour(page);
}

// Conta nova começa com o tour de boas-vindas por cima de tudo.
async function pularTour(page) {
  // O tour leva uns segundos pra localizar o 1º alvo (pula os que estão na
  // sidebar, escondida no celular) — isVisible() não espera, waitFor sim.
  const sair = page.getByRole("button", { name: "Sair do tour" });
  try {
    await sair.waitFor({ state: "visible", timeout: 10000 });
    await sair.click();
    await expect(sair).toBeHidden();
    // "Já vi o tour" vai no autosave do estado (debounce de 800ms): recarregar
    // antes disso faria o tour voltar na próxima tela.
    await page.waitForTimeout(1500);
  } catch { /* conta sem tour pendente */ }
}

async function esperarAssentar(page) {
  // O app faz poll a cada 3s; nos intervalos a rede fica quieta.
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
}

// Quanto a página passa da largura da tela, e quem está passando. Tira antes a
// rede de segurança do .main-content (overflow-x: clip), senão ela esconderia o
// problema em vez de deixar o teste achar.
async function medirLargura(page) {
  return page.evaluate(() => {
    const st = document.createElement("style");
    st.textContent = ".main-content { overflow-x: visible !important; }";
    document.head.appendChild(st);
    const vw = document.documentElement.clientWidth;
    const excesso = document.documentElement.scrollWidth - vw;
    const culpados = [];
    if (excesso > 1) {
      for (const el of document.querySelectorAll("body *")) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.right <= vw + 1) continue;
        // Dentro de um contêiner que rola ou corta sozinho, não empurra a página.
        let p = el.parentElement;
        let contido = false;
        while (p && p !== document.body) {
          const ox = getComputedStyle(p).overflowX;
          if (ox === "auto" || ox === "scroll" || ox === "hidden" || ox === "clip") {
            if (!p.classList.contains("main-content")) { contido = true; break; }
          }
          p = p.parentElement;
        }
        if (contido) continue;
        const cls = typeof el.className === "string" && el.className ? `.${el.className.trim().split(/\s+/).join(".")}` : "";
        culpados.push(`${el.tagName.toLowerCase()}${cls} até ${Math.round(r.right)}px — "${(el.textContent || "").trim().slice(0, 50)}"`);
      }
    }
    st.remove();
    return { excesso, culpados: culpados.slice(0, 10) };
  });
}

async function inputsPequenos(page) {
  return page.evaluate(() => [...document.querySelectorAll("input, select, textarea")]
    .filter(el => el.offsetParent !== null)
    .filter(el => !["checkbox", "radio", "range", "color", "file", "hidden"].includes(el.type))
    .filter(el => parseFloat(getComputedStyle(el).fontSize) < 16)
    .map(el => el.outerHTML.slice(0, 100)));
}

// Screenshot da página inteira. No Chromium o fullPage do Playwright desliga a
// emulação de toque (a página passa a responder pointer: fine), e o resto do
// teste rodaria como desktop estreito — religamos o toque logo depois. A sessão
// CDP fica aberta: fechada, o Chromium desfaz o que ela ligou.
const sessoes = new WeakMap();
async function fotografar(page, nome) {
  await page.screenshot({ path: test.info().outputPath(`${nome}.png`), fullPage: true });
  if (!sessoes.has(page)) sessoes.set(page, await page.context().newCDPSession(page));
  await sessoes.get(page).send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
}

async function conferirTela(page, nome) {
  await esperarAssentar(page);
  await fotografar(page, nome);
  const { excesso, culpados } = await medirLargura(page);
  expect.soft(excesso, `${nome}: ${excesso}px mais larga que a tela\n${culpados.join("\n")}`).toBeLessThanOrEqual(1);
  expect.soft(await inputsPequenos(page), `${nome}: input com fonte < 16px (zoom no iPhone)`).toEqual([]);
}

test.describe("Celular", () => {
  test("login cabe na tela", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByPlaceholder("Email")).toBeVisible({ timeout: 25000 });
    await conferirTela(page, "login");
  });

  test("o ☰ fica à esquerda e a gaveta abre do mesmo lado", async ({ page, request }) => {
    await entrarComoAdmin(page, request);
    const botao = page.getByRole("button", { name: "Abrir menu" });
    const b = await botao.boundingBox();
    expect(b.x).toBeLessThan(60);

    await botao.click();
    const gaveta = page.getByRole("dialog", { name: "Menu" });
    await expect(gaveta).toBeVisible();
    await page.waitForTimeout(300); // animação de entrada
    expect((await gaveta.boundingBox()).x).toBeLessThanOrEqual(1);

    await page.keyboard.press("Escape");
    await expect(gaveta).toBeHidden();

    // Navegar pela gaveta fecha ela e troca o título da barra.
    await botao.click();
    await gaveta.getByRole("button", { name: /Configurações/ }).click();
    await expect(gaveta).toBeHidden();
    await expect(page.locator(".mobile-only").getByText("Configurações", { exact: true })).toBeVisible();
  });

  test("nenhuma tela passa da largura do celular", async ({ page, request }) => {
    test.setTimeout(300000);
    await entrarComoAdmin(page, request);
    for (const [id, path] of Object.entries(PAGE_TO_PATH)) {
      await page.goto(path);
      await expect(page.locator(".main-content")).toBeVisible({ timeout: 15000 });
      await conferirTela(page, id);
    }
  });

  test("campanha: abas, fila e modal cabem na tela", async ({ page, request }) => {
    test.setTimeout(180000);
    await entrarComoAdmin(page, request);

    await page.getByRole("button", { name: /Nova campanha|Criar campanha/ }).first().click();
    await page.getByText("🔎 Original").click();
    await page.getByPlaceholder("Ex: Tech BR").fill("Campanha Celular");
    await page.getByText("Gamer", { exact: false }).click();
    await page.getByRole("button", { name: "Criar campanha", exact: true }).click();
    await expect(page.getByRole("button", { name: "Gerenciar" })).toBeVisible({ timeout: 10000 });
    await pularTour(page);

    const abas = page.locator('[data-tour^="tab-"]');
    const total = await abas.count();
    for (let i = 0; i < total; i++) {
      const nome = (await abas.nth(i).getAttribute("data-tour")).replace("tab-", "");
      await abas.nth(i).click();
      await conferirTela(page, `campanha-${nome}`);
    }

    // Modal com formulário: no toque ele não foca o campo (o teclado abriria
    // por cima), e a caixa cabe na tela.
    await page.getByRole("button", { name: /^Fila/ }).click();
    await page.getByRole("button", { name: /Adicionar link manualmente/ }).first().click();
    const modal = page.getByRole("dialog", { name: "Adicionar produto manualmente" });
    await expect(modal).toBeVisible();
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("INPUT");
    const m = await modal.boundingBox();
    const vp = page.viewportSize();
    expect(m.x).toBeGreaterThanOrEqual(0);
    expect(m.x + m.width).toBeLessThanOrEqual(vp.width);
    await conferirTela(page, "campanha-modal-manual");
  });
});
