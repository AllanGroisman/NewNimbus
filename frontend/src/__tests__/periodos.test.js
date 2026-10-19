// Contas de período (src/data/periodos.js): presets, a seta ‹ ›, o "período
// anterior" da variação e as datas escolhidas à mão. O anterior tem que ser o
// que a seta abriria — é assim que ele cai no mesmo cache do backend.

import { describe, it, expect } from "vitest";
import {
  resolvePeriodo, deslocaPeriodo, periodoAnterior, comoPreset, ajustaAoLimite,
  validaPersonalizado, rotuloPeriodo, inicioShopee, variacao,
} from "../data/periodos";

// 19/10/2026 (segunda) às 15h em Brasília.
const AGORA = new Date("2026-10-19T18:00:00Z");

describe("resolvePeriodo", () => {
  it("presets terminam ontem; com terminaHoje, terminam hoje", () => {
    expect(resolvePeriodo({ id: "7d" }, { now: AGORA })).toEqual({ id: "7d", from: "2026-10-12", to: "2026-10-18" });
    expect(resolvePeriodo({ id: "7d" }, { terminaHoje: true, now: AGORA })).toEqual({ id: "7d", from: "2026-10-13", to: "2026-10-19" });
    expect(resolvePeriodo({ id: "hoje" }, { now: AGORA })).toEqual({ id: "hoje", from: "2026-10-19", to: "2026-10-19" });
    expect(resolvePeriodo({ id: "ontem" }, { now: AGORA })).toEqual({ id: "ontem", from: "2026-10-18", to: "2026-10-18" });
    expect(resolvePeriodo({ id: "mes" }, { now: AGORA })).toEqual({ id: "mes", from: "2026-10-01", to: "2026-10-18" });
    expect(resolvePeriodo({ id: "mes" }, { terminaHoje: true, now: AGORA })).toEqual({ id: "mes", from: "2026-10-01", to: "2026-10-19" });
    expect(resolvePeriodo({ id: "mes-passado" }, { now: AGORA })).toEqual({ id: "mes-passado", from: "2026-09-01", to: "2026-09-30" });
  });

  it("datas livres passam como vieram; id desconhecido é null", () => {
    expect(resolvePeriodo({ id: "custom", from: "2026-09-10", to: "2026-09-12" })).toEqual({ id: "custom", from: "2026-09-10", to: "2026-09-12" });
    expect(resolvePeriodo({ id: "xyz" }, { now: AGORA })).toBeNull();
  });
});

describe("deslocaPeriodo / periodoAnterior", () => {
  it("anda pelo próprio tamanho", () => {
    expect(deslocaPeriodo({ from: "2026-10-12", to: "2026-10-18" }, -1)).toEqual({ id: "custom", from: "2026-10-05", to: "2026-10-11" });
    expect(deslocaPeriodo({ from: "2026-10-05", to: "2026-10-11" }, 1)).toEqual({ id: "custom", from: "2026-10-12", to: "2026-10-18" });
    expect(deslocaPeriodo({ from: "2026-10-18", to: "2026-10-18" }, -1)).toMatchObject({ from: "2026-10-17", to: "2026-10-17" });
  });

  it("mês anda por mês de calendário — inteiro vira inteiro, 'Este mês' vira os mesmos dias", () => {
    expect(periodoAnterior({ id: "mes-passado", from: "2026-09-01", to: "2026-09-30" })).toEqual({ from: "2026-08-01", to: "2026-08-31" });
    expect(periodoAnterior({ id: "custom", from: "2026-03-01", to: "2026-03-31" })).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(periodoAnterior({ id: "mes", from: "2026-10-01", to: "2026-10-18" })).toEqual({ from: "2026-09-01", to: "2026-09-18" });
    // 1 a 31/03 de "Este mês" vira 1 a 28/02 (fevereiro não tem 31).
    expect(periodoAnterior({ id: "mes", from: "2026-03-01", to: "2026-03-31" })).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    // Vira o ano.
    expect(periodoAnterior({ id: "mes-passado", from: "2026-01-01", to: "2026-01-31" })).toEqual({ from: "2025-12-01", to: "2025-12-31" });
    // Voltar e avançar a partir de "Este mês" continua por mês.
    const volta = deslocaPeriodo({ id: "mes", from: "2026-10-01", to: "2026-10-18" }, -1);
    expect(deslocaPeriodo(volta, 1)).toMatchObject({ from: "2026-10-01", to: "2026-10-18" });
  });

  it("respeita os limites: não passa do máximo, corta no mínimo, null quando não anda", () => {
    expect(deslocaPeriodo({ from: "2026-10-12", to: "2026-10-18" }, 1, { max: "2026-10-18" })).toBeNull();
    // Encosta no máximo mantendo o tamanho.
    expect(deslocaPeriodo({ from: "2026-10-05", to: "2026-10-14" }, 1, { max: "2026-10-18" })).toEqual({ id: "custom", from: "2026-10-09", to: "2026-10-18" });
    expect(deslocaPeriodo({ from: "2026-07-05", to: "2026-07-11" }, -1, { min: "2026-07-01" })).toEqual({ id: "custom", from: "2026-07-01", to: "2026-07-04" });
    expect(deslocaPeriodo({ from: "2026-07-01", to: "2026-07-11" }, -1, { min: "2026-07-01" })).toBeNull();
    // Mês pra frente até o máximo vira mês até o máximo.
    expect(deslocaPeriodo({ from: "2026-09-01", to: "2026-09-30" }, 1, { max: "2026-10-18" })).toMatchObject({ from: "2026-10-01", to: "2026-10-18" });
  });
});

describe("comoPreset / ajustaAoLimite", () => {
  it("intervalo igual a um preset vira o preset", () => {
    expect(comoPreset({ from: "2026-10-12", to: "2026-10-18" }, ["ontem", "7d"], { now: AGORA })).toEqual({ id: "7d" });
    expect(comoPreset({ from: "2026-10-11", to: "2026-10-17" }, ["ontem", "7d"], { now: AGORA })).toEqual({ id: "custom", from: "2026-10-11", to: "2026-10-17" });
  });

  it("preset que a outra loja não tem vira o mais parecido; datas livres encostam no limite", () => {
    const ml = { presets: ["ontem", "7d", "30d"], max: "2026-10-18", now: AGORA };
    expect(ajustaAoLimite({ id: "hoje" }, ml)).toEqual({ id: "ontem" });
    expect(ajustaAoLimite({ id: "7d" }, ml)).toEqual({ id: "7d" });
    expect(ajustaAoLimite({ id: "custom", from: "2026-10-15", to: "2026-10-19" }, ml)).toEqual({ id: "custom", from: "2026-10-15", to: "2026-10-18" });
    expect(ajustaAoLimite({ id: "custom", from: "2026-10-19", to: "2026-10-19" }, ml)).toEqual({ id: "ontem" });
    const shopee = { presets: ["hoje", "7d"], min: "2026-07-01", max: "2026-10-19", now: AGORA };
    expect(ajustaAoLimite({ id: "custom", from: "2026-05-01", to: "2026-07-10" }, shopee)).toEqual({ id: "custom", from: "2026-07-01", to: "2026-07-10" });
  });
});

describe("validaPersonalizado", () => {
  it("as duas datas, em ordem e dentro dos limites", () => {
    expect(validaPersonalizado("", "2026-10-01")).toMatch(/duas datas/);
    expect(validaPersonalizado("2026-10-05", "2026-10-01")).toMatch(/depois da final/);
    expect(validaPersonalizado("2026-10-01", "2026-10-19", { max: "2026-10-18" })).toBe("Escolha até 18/10/2026.");
    expect(validaPersonalizado("2026-06-01", "2026-07-02", { min: "2026-07-01" })).toBe("Os dados começam em 01/07/2026.");
    expect(validaPersonalizado("2026-01-01", "2026-10-18", { maxDias: 180 })).toMatch(/até 180 dias/);
    expect(validaPersonalizado("2026-10-10", "2026-10-10", { max: "2026-10-18", maxDias: 180 })).toBeNull();
  });
});

describe("rotuloPeriodo", () => {
  it("dia único pelo nome; intervalo de datas; ano só quando não é o atual", () => {
    expect(rotuloPeriodo({ from: "2026-10-19", to: "2026-10-19" }, AGORA)).toBe("Hoje");
    expect(rotuloPeriodo({ from: "2026-10-18", to: "2026-10-18" }, AGORA)).toBe("Ontem");
    expect(rotuloPeriodo({ from: "2026-10-15", to: "2026-10-15" }, AGORA)).toBe("qui, 15/10");
    expect(rotuloPeriodo({ from: "2026-10-12", to: "2026-10-18" }, AGORA)).toBe("12/10 a 18/10");
    expect(rotuloPeriodo({ from: "2025-12-20", to: "2026-01-05" }, AGORA)).toBe("20/12/2025 a 05/01/2026");
  });
});

describe("inicioShopee", () => {
  it("é o mesmo limite do backend (o mais recente entre 120 dias e o dia 1º de 3 meses atrás)", () => {
    expect(inicioShopee("2026-09-29")).toBe("2026-06-01");
    expect(inicioShopee("2026-10-31")).toBe("2026-07-03");
    expect(inicioShopee("2027-01-15")).toBe("2026-10-01");
  });
});

describe("variacao", () => {
  it("% arredondado com a direção; sem anterior ou anterior zero não compara", () => {
    expect(variacao(20, 10)).toEqual({ pct: 100, direcao: "sobe" });
    expect(variacao(18.5, 37)).toEqual({ pct: -50, direcao: "desce" });
    expect(variacao(3, 3)).toEqual({ pct: 0, direcao: "igual" });
    expect(variacao(5, 0)).toBeNull();
    expect(variacao(5, null)).toBeNull();
    expect(variacao(5, undefined)).toBeNull();
  });
});
