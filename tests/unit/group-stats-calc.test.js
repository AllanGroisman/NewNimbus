// Contas da aba Grupos: período em Brasília, previsão de lotação, permanência,
// saídas após envio e mapa de horários.
import { describe, it, expect } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "backend");
const calc = require(path.join(backend, "group-stats", "calc.js"));

const H = 60 * 60 * 1000;
const D = 24 * H;

describe("limitesBR / hojeBR", () => {
  it("o dia de Brasília começa às 03:00 UTC", () => {
    const { desde, ate } = calc.limitesBR("2026-10-01", "2026-10-02");
    expect(desde.toISOString()).toBe("2026-10-01T03:00:00.000Z");
    expect(ate.toISOString()).toBe("2026-10-03T03:00:00.000Z");
  });
  it("02:30 UTC ainda é o dia anterior em Brasília", () => {
    expect(calc.hojeBR(new Date("2026-10-06T02:30:00Z"))).toBe("2026-10-05");
    expect(calc.hojeBR(new Date("2026-10-06T03:30:00Z"))).toBe("2026-10-06");
  });
});

describe("preencheDias", () => {
  it("zera os dias sem evento e marca os de antes da coleta como sem dado", () => {
    const porDia = new Map([["2026-10-03", { entradas: 4 }]]);
    const r = calc.preencheDias("2026-10-01", "2026-10-04", porDia, { entradas: 0, saidas: 0 }, "2026-10-02");
    expect(r).toEqual([
      { date: "2026-10-01", semDados: true },
      { date: "2026-10-02", entradas: 0, saidas: 0 },
      { date: "2026-10-03", entradas: 4, saidas: 0 },
      { date: "2026-10-04", entradas: 0, saidas: 0 },
    ]);
  });
  it("sem coleta nenhuma, todo dia é sem dado", () => {
    expect(calc.preencheDias("2026-10-01", "2026-10-02", new Map(), {}, null).every(d => d.semDados)).toBe(true);
  });
});

describe("previsaoLotacao", () => {
  const serie = (inicio, ritmo, dias = 10) =>
    Array.from({ length: dias }, (_, i) => ({ date: `2026-09-${String(20 + i).padStart(2, "0")}`, members: inicio + ritmo * i }));

  it("crescendo: dias até lotar e a data", () => {
    const p = calc.previsaoLotacao({ serie: serie(800, 10), membros: 890, cap: 1024, hoje: "2026-10-06" });
    expect(p).toMatchObject({ ritmoDia: 10, diasParaLotar: 14, dataPrevista: "2026-10-20", base: "registros", motivo: null });
  });
  it("estável e caindo não têm data", () => {
    expect(calc.previsaoLotacao({ serie: serie(500, 0.1), membros: 501, hoje: "2026-10-06" }).motivo).toBe("estavel");
    expect(calc.previsaoLotacao({ serie: serie(500, -3), membros: 473, hoje: "2026-10-06" }).motivo).toBe("caindo");
  });
  it("devagar demais vira 'mais de um ano'", () => {
    expect(calc.previsaoLotacao({ serie: serie(100, 1), membros: 109, hoje: "2026-10-06" }).motivo).toBe("mais-de-um-ano");
  });
  it("cheio", () => {
    expect(calc.previsaoLotacao({ serie: [], membros: 1024, hoje: "2026-10-06" })).toMatchObject({ diasParaLotar: 0, motivo: "cheio" });
  });
  it("com a duplicação automática o teto é o gatilho dela", () => {
    const p = calc.previsaoLotacao({ serie: serie(900, 10), membros: 990, cap: 1000, hoje: "2026-10-06" });
    expect(p.diasParaLotar).toBe(1);
  });
  it("poucos registros: usa o saldo de eventos; sem nenhum dos dois, null", () => {
    const p = calc.previsaoLotacao({ serie: serie(500, 5, 2), eventos: { saldo: 70, dias: 7 }, membros: 524, hoje: "2026-10-06" });
    expect(p).toMatchObject({ ritmoDia: 10, diasParaLotar: 50, base: "eventos" });
    expect(calc.previsaoLotacao({ serie: [], membros: 500, hoje: "2026-10-06" })).toBe(null);
    expect(calc.previsaoLotacao({ serie: serie(1, 1), membros: NaN })).toBe(null);
  });
  it("4 registros no mesmo par de dias não viram tendência", () => {
    const juntos = [
      { date: "2026-10-05", members: 100 }, { date: "2026-10-05", members: 101 },
      { date: "2026-10-06", members: 140 }, { date: "2026-10-06", members: 141 },
    ];
    expect(calc.previsaoLotacao({ serie: juntos, membros: 141, hoje: "2026-10-06" })).toBe(null);
  });
});

describe("resumoPermanencia", () => {
  const t0 = new Date("2026-10-01T12:00:00Z").getTime();
  const at = (ms) => new Date(t0 + ms);

  it("mediana e faixas contam só a saída voluntária com entrada registrada", () => {
    const linhas = [
      { kind: "left", at: at(30 * 60 * 1000), prevKind: "join_link", prevAt: at(0) },     // 30 min
      { kind: "left", at: at(10 * H), prevKind: "join_link", prevAt: at(0) },             // 10 h
      { kind: "left", at: at(3 * D), prevKind: "join_added", prevAt: at(0) },             // 3 dias
      { kind: "left", at: at(20 * D), prevKind: "join_link", prevAt: at(0) },             // 20 dias
      { kind: "left", at: at(H), prevKind: null, prevAt: null },                          // entrou antes da coleta
      { kind: "removed", at: at(H), prevKind: "join_link", prevAt: at(0) },               // admin tirou
    ];
    const r = calc.resumoPermanencia(linhas);
    expect(r).toMatchObject({ saidas: 5, comEntrada: 4, semEntrada: 1, ate1h: 1, ate24h: 2, ate7d: 3, pctAte24h: 50 });
    expect(r.medianaMs).toBe((10 * H + 3 * D) / 2);
    expect(r.porOrigem.join_link).toEqual({ n: 3, medianaMs: 10 * H });
    expect(r.porOrigem.join_added).toEqual({ n: 1, medianaMs: 3 * D });
  });

  it("quem entrou no período e não saiu ainda está no grupo", () => {
    const r = calc.resumoPermanencia([
      { kind: "join_link", at: at(0), nextKind: null },
      { kind: "join_link", at: at(0), nextKind: "left" },
      { kind: "join_added", at: at(0), nextKind: "removed" },
      { kind: "join_other", at: at(0), nextKind: "join_link" },
    ]);
    expect(r).toMatchObject({ entraram: 4, aindaNoGrupo: 2, saidas: 0, medianaMs: null, pctAte24h: null });
  });
});

describe("saidasAposEnvio", () => {
  const base = new Date("2026-10-01T03:00:00Z").getTime(); // meia-noite BR
  const at = (ms) => new Date(base + ms);
  const desde = new Date(base);
  const ate = new Date(base + D);
  const now = new Date(base + 2 * D);

  it("a saída vai pro envio mais recente antes dela, dentro de 60 min", () => {
    const envios = [{ at: at(10 * H), produto: "Fone" }, { at: at(10 * H + 30 * 60e3), produto: "Air fryer" }];
    const saidas = [
      { at: at(10 * H + 10 * 60e3) },  // → Fone
      { at: at(10 * H + 40 * 60e3) },  // → Air fryer (mais recente)
      { at: at(10 * H + 89 * 60e3) },  // → Air fryer (59 min depois dele)
      { at: at(12 * H) },              // fora da janela
      { at: at(5 * H) },               // antes de qualquer envio
    ];
    const r = calc.saidasAposEnvio(envios, saidas, { desde, ate, now });
    expect(r).toMatchObject({ envios: 2, saidas: 5, saidasAposEnvio: 3, pct: 60, mediaPorEnvio: 1.5, janelaMin: 60 });
    expect(r.piores.map(p => [p.produto, p.saidas])).toEqual([["Air fryer", 2], ["Fone", 1]]);
  });

  it("o limite de 60:00 entra; 60:01 não", () => {
    const envios = [{ at: at(H) }];
    expect(calc.saidasAposEnvio(envios, [{ at: at(2 * H) }], { desde, ate, now }).saidasAposEnvio).toBe(1);
    expect(calc.saidasAposEnvio(envios, [{ at: at(2 * H + 1000) }], { desde, ate, now }).saidasAposEnvio).toBe(0);
  });

  it("envio da véspera ainda pega a saída da meia-noite, mas não conta como envio do período", () => {
    const r = calc.saidasAposEnvio([{ at: at(-20 * 60e3) }], [{ at: at(10 * 60e3) }], { desde, ate, now });
    expect(r).toMatchObject({ envios: 0, saidasAposEnvio: 1, mediaPorEnvio: null });
  });

  it("taxa por hora dentro × fora das janelas", () => {
    // 1 envio → 1 h coberta, 23 h descobertas. 3 saídas dentro, 23 fora.
    const foraDaJanela = [...Array(24).keys()].filter(h => h !== 8); // 23 horas
    const saidas = [
      ...[5, 20, 50].map(m => ({ at: at(8 * H + m * 60e3) })),
      ...foraDaJanela.map(h => ({ at: at(h * H + 30 * 60e3) })),
    ];
    const r = calc.saidasAposEnvio([{ at: at(8 * H) }], saidas, { desde, ate, now });
    expect(r.taxaHora.aposEnvio).toBe(3);
    expect(r.taxaHora.foraDeEnvio).toBe(1);
  });

  it("janelas sobrepostas não contam a mesma hora duas vezes", () => {
    const envios = [{ at: at(8 * H) }, { at: at(8 * H + 30 * 60e3) }]; // cobre 8h00–9h30
    const r = calc.saidasAposEnvio(envios, [{ at: at(9 * H) }], { desde, ate, now });
    expect(r.taxaHora.aposEnvio).toBe(Math.round((1 / 1.5) * 100) / 100);
  });

  it("sem saída: pct nulo, nada nos piores", () => {
    const r = calc.saidasAposEnvio([{ at: at(H) }], [], { desde, ate, now });
    expect(r).toMatchObject({ saidas: 0, pct: null, piores: [] });
  });
});

describe("gradeHorarios", () => {
  it("monta 7×24 com segunda na linha 0 e destaca os picos", () => {
    const g = calc.gradeHorarios([
      { dow: 1, hora: 9, entradas: 5, saidas: 1 },
      { dow: 7, hora: 21, entradas: 8, saidas: 0 },
      { dow: 3, hora: 12, entradas: 2, saidas: 4 },
      { dow: 9, hora: 1, entradas: 99, saidas: 99 },
    ]);
    expect(g.entradas).toHaveLength(7);
    expect(g.entradas[0][9]).toBe(5);
    expect(g.entradas[6][21]).toBe(8);
    expect(g.destaques.entradas.map(d => [d.dow, d.hora, d.n])).toEqual([[7, 21, 8], [1, 9, 5], [3, 12, 2]]);
    expect(g.destaques.saidas.map(d => [d.dow, d.hora])).toEqual([[3, 12], [1, 9]]);
  });
});
