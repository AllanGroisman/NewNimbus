// groupAllows — preferência de aviso POR CAMPANHA (Task 23). Mora em
// scraping.notifications; só silencia (a conta continua mandando) e ausente = ligado.

import "../helpers/env.js";
import { describe, it, expect } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const { groupAllows } = require(path.resolve(__dirname, "..", "..", "backend", "notifications", "user-notifier.js"));

const g = (notifications) => ({ id: 1, name: "X", scraping: notifications === undefined ? {} : { notifications } });

describe("groupAllows", () => {
  it("sem grupo ou sem preferência → libera (campanha antiga segue avisando)", () => {
    expect(groupAllows(null, "queueEmpty")).toBe(true);
    expect(groupAllows({ name: "X" }, "queueEmpty")).toBe(true);
    expect(groupAllows(g(), "queueEmpty")).toBe(true);
    expect(groupAllows(g({ enabled: true }), "productSearch")).toBe(true);
  });

  it("chave geral desligada → barra todos os eventos", () => {
    const grp = g({ enabled: false, events: { productSearch: true } });
    for (const ev of ["campaignStopped", "campaignDeactivated", "campaignReactivated", "productSearch", "queueEmpty"]) {
      expect(groupAllows(grp, ev)).toBe(false);
    }
  });

  it("evento individual desligado → barra só ele", () => {
    const grp = g({ enabled: true, events: { productSearch: false } });
    expect(groupAllows(grp, "productSearch")).toBe(false);
    expect(groupAllows(grp, "queueEmpty")).toBe(true);
    expect(groupAllows(grp, "campaignStopped")).toBe(true);
  });

  it("evento ausente no objeto conta como ligado", () => {
    expect(groupAllows(g({ events: {} }), "campaignStopped")).toBe(true);
  });
});
