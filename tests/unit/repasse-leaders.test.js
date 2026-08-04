// Repasse — normalização dos grupos líderes de uma campanha. O dado vive em
// scraping.repasse e tem dois formatos: o array atual e o líder único antigo.

import "../helpers/env.js";
import { describe, it, expect } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { leadersOf, normalizeRepasse } = require(path.resolve(__dirname, "..", "..", "backend", "repasse", "leaders.js"));

describe("leadersOf", () => {
  it("lê o formato atual (array)", () => {
    const sc = { kind: "repasse", repasse: { leaders: [
      { numberId: "n1", jid: "111@g.us", name: "Ofertas A" },
      { numberId: "n2", jid: "222@g.us", name: "Ofertas B" },
    ] } };
    expect(leadersOf(sc)).toEqual([
      { numberId: "n1", jid: "111@g.us", name: "Ofertas A" },
      { numberId: "n2", jid: "222@g.us", name: "Ofertas B" },
    ]);
  });

  it("lê o formato antigo (líder único) como array de um", () => {
    const sc = { kind: "repasse", repasse: { leaderNumberId: "n1", leaderJid: "111@g.us", leaderName: "Ofertas A" } };
    expect(leadersOf(sc)).toEqual([{ numberId: "n1", jid: "111@g.us", name: "Ofertas A" }]);
  });

  it("devolve vazio sem repasse, sem líder e no formato antigo em branco", () => {
    expect(leadersOf(undefined)).toEqual([]);
    expect(leadersOf({ kind: "scraping" })).toEqual([]);
    expect(leadersOf({ kind: "repasse", repasse: { leaders: [] } })).toEqual([]);
    expect(leadersOf({ kind: "repasse", repasse: { leaderNumberId: null, leaderJid: null, leaderName: null } })).toEqual([]);
  });

  it("descarta entrada sem numberId ou sem jid", () => {
    const sc = { kind: "repasse", repasse: { leaders: [
      { numberId: "n1", jid: "111@g.us", name: "ok" },
      { numberId: "n1", name: "sem jid" },
      { jid: "333@g.us", name: "sem número" },
      null,
    ] } };
    expect(leadersOf(sc).map(l => l.jid)).toEqual(["111@g.us"]);
  });

  it("deduplica por numberId::jid, mantendo o primeiro", () => {
    const sc = { kind: "repasse", repasse: { leaders: [
      { numberId: "n1", jid: "111@g.us", name: "primeiro" },
      { numberId: "n1", jid: "111@g.us", name: "repetido" },
      { numberId: "n2", jid: "111@g.us", name: "mesmo grupo, outro número" },
    ] } };
    const out = leadersOf(sc);
    expect(out).toHaveLength(2);
    expect(out[0].name).toBe("primeiro");
    expect(out[1].numberId).toBe("n2");
  });

  it("name ausente vira null e ids viram string", () => {
    const sc = { kind: "repasse", repasse: { leaders: [{ numberId: 7, jid: "111@g.us" }] } };
    expect(leadersOf(sc)).toEqual([{ numberId: "7", jid: "111@g.us", name: null }]);
  });
});

describe("normalizeRepasse", () => {
  it("converte o formato antigo e some com as chaves legadas", () => {
    const sc = { kind: "repasse", auto: true, repasse: { leaderNumberId: "n1", leaderJid: "111@g.us", leaderName: "A" } };
    expect(normalizeRepasse(sc)).toEqual({
      kind: "repasse",
      auto: true,
      repasse: { leaders: [{ numberId: "n1", jid: "111@g.us", name: "A" }] },
    });
  });

  it("não mexe em campanha de scraping", () => {
    const sc = { kind: "scraping", filters: { minDiscount: 25 } };
    expect(normalizeRepasse(sc)).toBe(sc);
  });

  it("é idempotente", () => {
    const sc = { kind: "repasse", repasse: { leaders: [{ numberId: "n1", jid: "111@g.us", name: "A" }] } };
    expect(normalizeRepasse(normalizeRepasse(sc))).toEqual(sc);
  });
});
