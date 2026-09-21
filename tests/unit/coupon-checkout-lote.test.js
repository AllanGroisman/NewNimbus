// A ordem da fila da sonda em lote (coupons/checkout-lote.js:ordemPorCategoria).
//
// O que protege: toda categoria entra no lote (a 1ª rodada dá uma vaga a cada
// uma — é assim que uma categoria sem histórico é explorada), as que renderam cupom
// ganham mais vagas depois, e a que nunca rendeu desce mas não some: a ausência de
// cupom não é resposta.

import "../helpers/env.js";
import { describe, it, expect } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { ordemPorCategoria, rendimento } = require(path.resolve(__dirname, "..", "..", "backend", "coupons", "checkout-lote.js"));

const fila = (cat, n) => Array.from({ length: n }, (_, i) => ({ key: `${cat}${i + 1}`, category: cat }));
const chaves = (xs) => xs.map(x => x.key);

describe("ordemPorCategoria", () => {
  it("sem histórico, reveza entre as categorias", () => {
    const r = ordemPorCategoria([...fila("a", 3), ...fila("b", 3)], {}, 4);
    // Todas empatam em 0,5: duas vagas por rodada depois da primeira.
    expect(chaves(r)).toEqual(["a1", "b1", "a2", "a3"]);
  });

  it("a categoria que rendeu cupom vem na frente e ganha mais vagas; a que nunca rendeu ainda entra", () => {
    const hist = { boa: { sondados: 10, comCupom: 9 }, ruim: { sondados: 10, comCupom: 0 } };
    const r = ordemPorCategoria([...fila("ruim", 5), ...fila("boa", 5), ...fila("nova", 5)], hist, 9);
    expect(chaves(r).slice(0, 3)).toEqual(["boa1", "nova1", "ruim1"]);
    // Rodada 2: boa leva 3 vagas (0,83 × 3), nova 2 (0,5 × 3), ruim 1.
    expect(chaves(r).slice(3)).toEqual(["boa2", "boa3", "boa4", "nova2", "nova3", "ruim2"]);
  });

  it("corta no limite e não inventa linha quando a fila acaba", () => {
    expect(ordemPorCategoria(fila("a", 2), {}, 10)).toHaveLength(2);
    expect(ordemPorCategoria([], {}, 10)).toEqual([]);
  });

  it("rendimento suavizado: sem histórico é 0,5", () => {
    expect(rendimento()).toBe(0.5);
    expect(rendimento({ sondados: 8, comCupom: 0 })).toBeCloseTo(0.1);
  });
});
