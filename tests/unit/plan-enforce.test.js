// Pausa por plano — o que acontece com campanhas/números quando o cliente
// cancela ou baixa de plano (task 34). Regra: nada é apagado, o excedente é
// PAUSADO e o cliente escolhe o que fica ativo.
//
// Aqui testamos só a função pura `computePlanPaused` (sem banco).

import { describe, it, expect } from "vitest";
import "../helpers/env.js";
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const enforce = require(path.resolve(__dirname, "..", "..", "backend", "billing", "enforce.js"));
const limits = require(path.resolve(__dirname, "..", "..", "backend", "billing", "limits.js"));

const EMPTY = { groups: [], numbers: [] };
// Ids de campanha são Date.now() no frontend — números maiores = mais novas.
const g = (id, extra = {}) => ({ id, name: `G${id}`, categories: ["gamer"], whatsappGroupIds: [], ...extra });
const state = (groups, numbers = []) => ({ groups, numbers });

const PRO = limits.getLimits({ planId: "pro", status: "active" });
const BASIC = limits.getLimits({ planId: "basic", status: "active" });
const FREE = limits.getLimits(null);

describe("computePlanPaused — downgrade", () => {
  it("mantém as mais antigas ativas e pausa o excedente", () => {
    const s = state([g(1), g(2), g(3), g(4), g(5)]);
    const r = enforce.computePlanPaused(s, BASIC, EMPTY);
    expect(r.groups.sort()).toEqual([2, 3, 4, 5]); // sobra a campanha 1
  });

  it("é idempotente — rodar de novo não muda nada", () => {
    const s = state([g(1), g(2), g(3)]);
    const first = enforce.computePlanPaused(s, BASIC, EMPTY);
    const second = enforce.computePlanPaused(s, BASIC, first);
    expect(second.groups.sort()).toEqual(first.groups.sort());
  });

  it("free pausa tudo (0 campanhas, 0 números)", () => {
    const s = state([g(1), g(2)], [{ id: "n1" }, { id: "n2" }]);
    const r = enforce.computePlanPaused(s, FREE, EMPTY);
    expect(r.groups.sort()).toEqual([1, 2]);
    expect(r.numbers.sort()).toEqual(["n1", "n2"]);
  });

  it("respeita a escolha do cliente: quem já estava pausado continua pausado", () => {
    const s = state([g(1), g(2), g(3)]);
    // Cliente escolheu manter a 3 ativa em vez da 1.
    const r = enforce.computePlanPaused(s, BASIC, { groups: [1, 2], numbers: [] });
    expect(r.groups.sort()).toEqual([1, 2]);
  });
});

describe("computePlanPaused — limites por campanha", () => {
  it("pausa campanha com mais grupos de WhatsApp do que o plano permite", () => {
    const big = g(1, { whatsappGroupIds: ["a", "b", "c", "d"] }); // basic permite 3
    const s = state([big, g(2)]);
    const r = enforce.computePlanPaused(s, BASIC, EMPTY);
    expect(r.groups).toContain(1);
    expect(r.groups).not.toContain(2); // a vaga sobrou pra 2
  });

  it("pausa campanha com mais categorias do que o plano permite", () => {
    const big = g(1, { categories: ["a", "b", "c"] }); // basic permite 2
    const r = enforce.computePlanPaused(state([big]), BASIC, EMPTY);
    expect(r.groups).toEqual([1]);
  });
});

describe("computePlanPaused — upgrade e limpeza", () => {
  it("despausa sozinho quando o plano cresce, da mais antiga pra mais nova", () => {
    const s = state([g(1), g(2), g(3), g(4), g(5), g(6)]);
    const r = enforce.computePlanPaused(s, PRO, { groups: [2, 3, 4, 5, 6], numbers: [] });
    expect(r.groups).toEqual([6]); // pro cabe 5 ativas
  });

  it("não despausa campanha que continua fora dos limites por campanha", () => {
    const big = g(2, { categories: ["a", "b", "c"] });
    const r = enforce.computePlanPaused(state([g(1), big]), BASIC, { groups: [2], numbers: [] });
    expect(r.groups).toEqual([2]);
  });

  it("descarta ids de itens que não existem mais", () => {
    const r = enforce.computePlanPaused(state([g(1)]), PRO, { groups: [99], numbers: ["sumiu"] });
    expect(r).toEqual({ groups: [], numbers: [] });
  });
});

describe("computePlanPaused — números de WhatsApp", () => {
  it("pausa os excedentes mantendo os mais antigos", () => {
    const s = state([], [{ id: "100" }, { id: "200" }, { id: "300" }]);
    const r = enforce.computePlanPaused(s, BASIC, EMPTY); // basic = 1 número
    expect(r.numbers.sort()).toEqual(["200", "300"]);
  });

  it("libera todos quando o plano comporta", () => {
    const s = state([], [{ id: "100" }, { id: "200" }]);
    const r = enforce.computePlanPaused(s, PRO, { groups: [], numbers: ["200"] });
    expect(r.numbers).toEqual([]);
  });
});
