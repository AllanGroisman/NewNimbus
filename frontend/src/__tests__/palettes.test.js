import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PALETTES, DEFAULT_PALETTE, isValidPalette, PAGE_TO_PATH, sidebarItems } from "../data/constants";

// A lista de paletas vive em três lugares que precisam concordar: aqui
// (PALETTES), os blocos data-palette do index.css e a whitelist do backend.
// Se um sair de sincronia, o admin consegue salvar uma paleta que a tela não
// sabe pintar — ou pior, o backend recusa uma opção que o menu oferece.
const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, "../index.css"), "utf8");
const serverJs = readFileSync(resolve(here, "../../../backend/server.js"), "utf8");

describe("paletas", () => {
  it("toda paleta do menu tem bloco correspondente no index.css", () => {
    for (const p of PALETTES) {
      expect(css, `falta o bloco [data-palette="${p.id}"] no index.css`)
        .toContain(`[data-palette="${p.id}"]`);
    }
  });

  it("cada bloco de paleta define os tons crus dos dois temas", () => {
    // Sem um deles, o tema correspondente cai em var() vazio e a tela fica sem cor.
    const obrigatorias = [
      "--pal-primary", "--pal-primary-dark", "--pal-primary-light",
      "--pal-l-brand", "--pal-l-bg-1", "--pal-l-bg-2", "--pal-l-text-1",
      "--pal-l-text-2", "--pal-l-border-2", "--pal-l-border-3",
      "--pal-d-brand", "--pal-d-bg-1", "--pal-d-bg-2", "--pal-d-text-1",
      "--pal-d-text-2", "--pal-d-border-2", "--pal-d-border-3",
    ];
    for (const p of PALETTES) {
      const inicio = css.indexOf(`[data-palette="${p.id}"]`);
      const bloco = css.slice(inicio, css.indexOf("}", inicio));
      for (const v of obrigatorias) {
        expect(bloco, `paleta "${p.id}" não define ${v}`).toContain(`${v}:`);
      }
    }
  });

  it("backend aceita exatamente as paletas que o menu oferece", () => {
    const m = serverJs.match(/const PALETTE_IDS = \[([^\]]+)\]/);
    expect(m, "PALETTE_IDS não encontrado no server.js").toBeTruthy();
    const doBackend = m[1].split(",").map(s => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    expect(doBackend.sort()).toEqual(PALETTES.map(p => p.id).sort());
  });

  it("backend usa a mesma paleta padrão do frontend", () => {
    expect(serverJs).toContain(`const DEFAULT_PALETTE = "${DEFAULT_PALETTE}"`);
  });

  it("a paleta padrão existe na lista", () => {
    expect(isValidPalette(DEFAULT_PALETTE)).toBe(true);
    expect(isValidPalette("inexistente")).toBe(false);
  });

  it("o script anti-piscada do index.html conhece todas as paletas", () => {
    // Ele roda antes do React e tem a lista escrita à mão; se ficar defasado,
    // a paleta nova abre na cor errada e só corrige depois da resposta da API.
    const html = readFileSync(resolve(here, "../../index.html"), "utf8");
    for (const p of PALETTES) {
      expect(html, `index.html não reconhece a paleta "${p.id}"`).toContain(`"${p.id}"`);
    }
  });
});

describe("página Layout", () => {
  it("está no menu como item de admin e tem rota própria", () => {
    const item = sidebarItems.find(i => i.id === "admin-layout");
    expect(item).toBeTruthy();
    expect(item.adminOnly).toBe(true);
    expect(PAGE_TO_PATH["admin-layout"]).toBe("/admin/layout");
  });
});
