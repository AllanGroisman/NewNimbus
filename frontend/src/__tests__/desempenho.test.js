// Contas da tela Desempenho (src/data/desempenho.js): os períodos têm que bater
// com o jeito que o painel do ML conta, senão os números não conferem com os de lá.

import { describe, it, expect } from "vitest";
import { hojeBR, periodo, conversao, formatBRL, diaCurto } from "../data/desempenho";

// 29/09/2026 às 15h em Brasília.
const AGORA = new Date("2026-09-29T18:00:00Z");

describe("hojeBR", () => {
  it("usa o relógio de Brasília, não o UTC", () => {
    // 02h UTC do dia 30 ainda é 23h do dia 29 em Brasília.
    expect(hojeBR(new Date("2026-09-30T02:00:00Z"))).toBe("2026-09-29");
    expect(hojeBR(AGORA)).toBe("2026-09-29");
  });
});

describe("periodo", () => {
  it("os últimos N dias terminam ontem, como no painel do ML", () => {
    // O "últimos 7 dias" do painel em 29/09 é 22/09 a 28/09.
    expect(periodo("7d", AGORA)).toEqual({ from: "2026-09-22", to: "2026-09-28" });
    expect(periodo("30d", AGORA)).toEqual({ from: "2026-08-30", to: "2026-09-28" });
    expect(periodo("90d", AGORA)).toEqual({ from: "2026-07-01", to: "2026-09-28" });
  });

  it("este mês vai do dia 1º até ontem; no próprio dia 1º, só o dia de hoje", () => {
    expect(periodo("mes", AGORA)).toEqual({ from: "2026-09-01", to: "2026-09-28" });
    expect(periodo("mes", new Date("2026-10-01T15:00:00Z"))).toEqual({ from: "2026-10-01", to: "2026-10-01" });
  });

  it("mês passado é o mês inteiro, inclusive na virada do ano", () => {
    expect(periodo("mes-passado", AGORA)).toEqual({ from: "2026-08-01", to: "2026-08-31" });
    expect(periodo("mes-passado", new Date("2027-01-15T15:00:00Z"))).toEqual({ from: "2026-12-01", to: "2026-12-31" });
    expect(periodo("mes-passado", new Date("2028-03-10T15:00:00Z"))).toEqual({ from: "2028-02-01", to: "2028-02-29" });
  });

  it("id desconhecido cai nos 30 dias", () => {
    expect(periodo("xyz", AGORA)).toEqual(periodo("30d", AGORA));
  });
});

describe("formatos", () => {
  it("conversão sem clique é '—', não 0%", () => {
    expect(conversao(0, 0)).toBe("—");
    expect(conversao(4, 20)).toBe("20%");
    expect(conversao(1, 3)).toBe("33,3%");
  });

  it("reais e dia curto", () => {
    expect(formatBRL(18.5)).toMatch(/R\$\s18,50/);
    expect(formatBRL(null)).toMatch(/R\$\s0,00/);
    expect(diaCurto("2026-09-28")).toBe("28/09");
  });
});
