// Preferências de tela do admin (backend/admin-prefs.js) — iguais para todos os
// admins. O que importa: gravar uma chave não apaga as outras (dois admins mexendo
// em filtros diferentes), e a tela não consegue encher o app_config.

import "../helpers/env.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const backend = (...p) => require(path.resolve(__dirname, "..", "..", "backend", ...p));

const prefs = backend("admin-prefs.js");
const appConfig = backend("config", "index.js");

beforeEach(() => appConfig.del(prefs.CONFIG_KEY));
afterEach(() => appConfig.del(prefs.CONFIG_KEY));

describe("admin-prefs", () => {
  it("sem nada guardado devolve objeto vazio", () => {
    expect(prefs.lerTodas()).toEqual({});
  });

  it("gravar uma chave mantém as outras", () => {
    prefs.gravar("admin.repasse.horas", 168);
    prefs.gravar("cupons.mlFiltros", { q: "jbl", onlyValid: true });
    expect(prefs.lerTodas()).toEqual({ "admin.repasse.horas": 168, "cupons.mlFiltros": { q: "jbl", onlyValid: true } });
  });

  it("null apaga a chave", () => {
    prefs.gravar("a", 1);
    prefs.gravar("b", 2);
    prefs.gravar("a", null);
    expect(prefs.lerTodas()).toEqual({ b: 2 });
  });

  it("recusa chave com caractere estranho ou comprida demais", () => {
    expect(() => prefs.gravar("../x", 1)).toThrow(/Chave/);
    expect(() => prefs.gravar("a".repeat(81), 1)).toThrow(/Chave/);
    expect(() => prefs.gravar("", 1)).toThrow(/Chave/);
  });

  it("recusa valor grande demais, com status 400", () => {
    let erro;
    try { prefs.gravar("grande", "x".repeat(prefs.MAX_BYTES_VALOR)); } catch (e) { erro = e; }
    expect(erro?.status).toBe(400);
    expect(prefs.lerTodas()).toEqual({});
  });

  it("tem teto de chaves, mas deixa atualizar as que já existem", () => {
    for (let i = 0; i < prefs.MAX_CHAVES; i++) prefs.gravar(`k${i}`, i);
    expect(() => prefs.gravar("mais-uma", 1)).toThrow(/demais/);
    prefs.gravar("k0", "novo");
    expect(prefs.lerTodas().k0).toBe("novo");
  });
});
