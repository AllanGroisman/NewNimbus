// Contas puras da aba Grupos: períodos que terminam hoje, textos de duração,
// saldo e previsão, e a ordem da lista.
import { describe, it, expect } from "vitest";
import { periodoGrupos, formatDuracao, formatSaldo, textoPrevisao, textoRitmo, rotuloHorario, ordenaGrupos } from "../data/grupos";

// 29/09 às 23h em Brasília (já é 30/09 em UTC).
const AGORA = new Date("2026-09-30T02:00:00Z");

describe("periodoGrupos", () => {
  it("os períodos terminam hoje em Brasília, com o dia de hoje contando", () => {
    expect(periodoGrupos("hoje", AGORA)).toEqual({ from: "2026-09-29", to: "2026-09-29" });
    expect(periodoGrupos("7d", AGORA)).toEqual({ from: "2026-09-23", to: "2026-09-29" });
    expect(periodoGrupos("30d", AGORA)).toEqual({ from: "2026-08-31", to: "2026-09-29" });
    expect(periodoGrupos("90d", AGORA).to).toBe("2026-09-29");
  });
  it("id desconhecido cai em hoje", () => {
    expect(periodoGrupos("??", AGORA)).toEqual({ from: "2026-09-29", to: "2026-09-29" });
  });
});

describe("formatDuracao", () => {
  it("minutos, horas até 2 dias, depois dias", () => {
    expect(formatDuracao(20 * 1000)).toBe("1 min");
    expect(formatDuracao(40 * 60e3)).toBe("40 min");
    expect(formatDuracao(5 * 3600e3)).toBe("5 h");
    expect(formatDuracao(30 * 3600e3)).toBe("30 h");
    expect(formatDuracao(3 * 86400e3)).toBe("3 dias");
    expect(formatDuracao(null)).toBe("—");
  });
});

describe("formatSaldo", () => {
  it("sinal explícito, com o menos tipográfico", () => {
    expect(formatSaldo(3)).toBe("+3");
    expect(formatSaldo(-1200)).toBe("−1.200");
    expect(formatSaldo(0)).toBe("0");
  });
});

describe("textoPrevisao / textoRitmo", () => {
  it("com previsão mostra dias e data", () => {
    const p = { ritmoDia: 12.5, diasParaLotar: 14, dataPrevista: "2026-10-20", motivo: null };
    expect(textoPrevisao(p)).toBe("Lota em ~14 dias (20/10)");
    expect(textoRitmo(p)).toBe("+12,5/dia");
    expect(textoPrevisao({ ...p, diasParaLotar: 1 })).toBe("Lota em até 1 dia (20/10)");
  });
  it("sem previsão diz por quê", () => {
    expect(textoPrevisao(null)).toBe("Sem dados pra prever");
    expect(textoPrevisao({ motivo: "estavel" })).toBe("Estável");
    expect(textoPrevisao({ motivo: "caindo", ritmoDia: -3 })).toBe("Perdendo membros");
    expect(textoRitmo({ ritmoDia: -3 })).toBe("−3/dia");
    expect(textoPrevisao({ motivo: "cheio" })).toBe("Cheio");
    expect(textoPrevisao({ motivo: "mais-de-um-ano" })).toBe("Mais de um ano pra lotar");
  });
});

describe("rotuloHorario", () => {
  it("1 = segunda, 7 = domingo", () => {
    expect(rotuloHorario({ dow: 1, hora: 9 })).toBe("seg 9h");
    expect(rotuloHorario({ dow: 7, hora: 21 })).toBe("dom 21h");
  });
});

describe("ordenaGrupos", () => {
  it("os que estão enchendo primeiro, depois os maiores", () => {
    const r = ordenaGrupos([
      { nome: "B", membros: 300 },
      { nome: "A", membros: 950, enchendo: true },
      { nome: "C", membros: null },
      { nome: "D", membros: 600 },
    ]);
    expect(r.map(g => g.nome)).toEqual(["A", "D", "B", "C"]);
  });
});
