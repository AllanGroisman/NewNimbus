// Travas de loja (admin tranca uma loja e ela some pros usuários).
// Módulo puro sobre appConfig — sem rede. Cada teste limpa a chave antes.

import "../helpers/env.js";
import { describe, it, expect, beforeEach } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const backend = (...p) => require(path.resolve(__dirname, "..", "..", "backend", ...p));

const storeLocks = backend("scraping", "store-locks.js");
const appConfig = backend("config");
const scheduler = backend("scheduler.js");

beforeEach(() => {
  appConfig.set(storeLocks.STORE_LOCKS_KEY, {});
});

describe("readStoreLocks", () => {
  it("devolve as três lojas destrancadas quando não há nada salvo", () => {
    const locks = storeLocks.readStoreLocks();
    expect(Object.keys(locks).sort()).toEqual(["amazon", "ml", "shopee"]);
    for (const id of ["ml", "amazon", "shopee"]) {
      expect(locks[id].locked).toBe(false);
      expect(locks[id].message).toBe(storeLocks.DEFAULT_MESSAGE);
    }
  });

  it("valor corrompido no appConfig cai no default em vez de quebrar", () => {
    appConfig.set(storeLocks.STORE_LOCKS_KEY, { ml: "trancada", shopee: null });
    const locks = storeLocks.readStoreLocks();
    expect(locks.ml.locked).toBe(false);
    expect(locks.shopee.message).toBe(storeLocks.DEFAULT_MESSAGE);
  });
});

describe("writeStoreLock", () => {
  it("tranca a loja e guarda a mensagem", () => {
    storeLocks.writeStoreLock("shopee", { locked: true, message: "Volta semana que vem" });
    expect(storeLocks.isStoreLocked("shopee")).toBe(true);
    expect(storeLocks.lockMessage("shopee")).toBe("Volta semana que vem");
    // As outras não são afetadas
    expect(storeLocks.isStoreLocked("ml")).toBe(false);
    expect(storeLocks.lockMessage("ml")).toBe(null);
  });

  it("aceita o label da loja além do id", () => {
    storeLocks.writeStoreLock("Mercado Livre", { locked: true });
    expect(storeLocks.isStoreLocked("ml")).toBe(true);
    expect(storeLocks.lockedStoreIds()).toEqual(["ml"]);
  });

  it("patch parcial preserva o campo não enviado", () => {
    storeLocks.writeStoreLock("amazon", { locked: true, message: "Em manutenção" });
    storeLocks.writeStoreLock("amazon", { locked: false });
    expect(storeLocks.readStoreLocks().amazon.message).toBe("Em manutenção");
    storeLocks.writeStoreLock("amazon", { message: "  " }); // só espaços → volta pro default
    expect(storeLocks.readStoreLocks().amazon.message).toBe(storeLocks.DEFAULT_MESSAGE);
  });

  it("rejeita loja desconhecida", () => {
    expect(() => storeLocks.writeStoreLock("magalu", { locked: true })).toThrow(/desconhecida/i);
  });

  it("lockMessage devolve null quando a loja está liberada, mesmo com mensagem salva", () => {
    storeLocks.writeStoreLock("ml", { locked: false, message: "Em breve" });
    expect(storeLocks.lockMessage("ml")).toBe(null);
  });
});

describe("scheduler.activeSources", () => {
  it("tira a loja trancada e mantém as outras", () => {
    storeLocks.writeStoreLock("shopee", { locked: true });
    expect(scheduler.activeSources(["Mercado Livre", "Shopee"])).toEqual(["ml"]);
  });

  it("devolve [] quando todas as lojas da campanha estão trancadas", () => {
    storeLocks.writeStoreLock("ml", { locked: true });
    expect(scheduler.activeSources(["Mercado Livre"])).toEqual([]);
  });

  it("sem trava, é igual a resolveSources", () => {
    const raw = ["Mercado Livre", "Amazon"];
    expect(scheduler.activeSources(raw)).toEqual(scheduler.resolveSources(raw));
  });
});
