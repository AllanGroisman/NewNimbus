// Contadores de envio da campanha (Envios hoje / semana) no dia de Brasília:
// conta no envio e zera na leitura o que ficou de outro dia ou semana.
import { describe, it, expect } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "backend");
const { contaEnvio, contadoresAtuais, diaBR, segundaDe } = require(path.join(backend, "utils", "contadores-envio.js"));

// 2026-10-15 é quinta (índice 3); 2026-10-18 domingo; 2026-10-19 segunda.
const QUI_15H = new Date("2026-10-15T18:00:00Z");

describe("diaBR / segundaDe", () => {
  it("02:30 UTC ainda é o dia anterior em Brasília", () => {
    expect(diaBR("2026-10-16T02:30:00Z")).toBe("2026-10-15");
    expect(diaBR("2026-10-16T03:30:00Z")).toBe("2026-10-16");
  });
  it("data inválida ou o '—' do lastSend → null", () => {
    expect(diaBR("—")).toBeNull();
    expect(diaBR(null)).toBeNull();
    expect(diaBR("")).toBeNull();
  });
  it("a semana começa na segunda", () => {
    expect(segundaDe("2026-10-15")).toBe("2026-10-12");
    expect(segundaDe("2026-10-18")).toBe("2026-10-12");
    expect(segundaDe("2026-10-19")).toBe("2026-10-19");
  });
});

describe("contaEnvio", () => {
  it("segundo envio do mesmo dia soma 1", () => {
    const r = contaEnvio({ sentToday: 4, weekData: [1, 0, 2, 4, 0, 0, 0], ultimoEnvio: "2026-10-15T12:00:00Z" }, QUI_15H);
    expect(r.sentToday).toBe(5);
    expect(r.weekData).toEqual([1, 0, 2, 5, 0, 0, 0]);
    expect(r.sentWeek).toBe(8);
    expect(r.lastSend).toBe(QUI_15H.toISOString());
  });

  it("primeiro envio do dia volta pra 1 (o bug: seguia somando o de ontem)", () => {
    const r = contaEnvio({ sentToday: 12, weekData: [0, 0, 12, 0, 0, 0, 0], ultimoEnvio: "2026-10-14T20:00:00Z" }, QUI_15H);
    expect(r.sentToday).toBe(1);
    expect(r.weekData).toEqual([0, 0, 12, 1, 0, 0, 0]);
    expect(r.sentWeek).toBe(13);
  });

  it("a virada é à meia-noite de Brasília, não de UTC", () => {
    // 23:30 de Brasília do dia 15 (02:30Z do 16) e depois 00:30 do dia 16 (03:30Z).
    const antes = contaEnvio({ sentToday: 3, weekData: [0, 0, 0, 3, 0, 0, 0], ultimoEnvio: "2026-10-15T20:00:00Z" }, new Date("2026-10-16T02:30:00Z"));
    expect(antes.sentToday).toBe(4);
    const depois = contaEnvio({ ...antes, ultimoEnvio: "2026-10-16T02:30:00Z" }, new Date("2026-10-16T03:30:00Z"));
    expect(depois.sentToday).toBe(1);
    expect(depois.weekData).toEqual([0, 0, 0, 4, 1, 0, 0]);
  });

  it("semana nova zera a semana antes de contar", () => {
    const r = contaEnvio({ sentToday: 2, weekData: [5, 5, 5, 5, 5, 5, 2], ultimoEnvio: "2026-10-18T22:00:00Z" }, new Date("2026-10-19T12:00:00Z"));
    expect(r.sentToday).toBe(1);
    expect(r.weekData).toEqual([1, 0, 0, 0, 0, 0, 0]);
    expect(r.sentWeek).toBe(1);
  });

  it("sem envio anterior (ou weekData torto) começa do zero", () => {
    const r = contaEnvio({ sentToday: 7, weekData: "lixo" }, QUI_15H);
    expect(r.sentToday).toBe(1);
    expect(r.weekData).toEqual([0, 0, 0, 1, 0, 0, 0]);
  });
});

describe("contadoresAtuais", () => {
  const ops = { sentToday: 6, sentWeek: 9, weekData: [3, 0, 0, 6, 0, 0, 0] };

  it("envio de hoje: mantém tudo", () => {
    expect(contadoresAtuais(ops, "2026-10-15T10:00:00Z", QUI_15H)).toEqual(ops);
  });

  it("último envio ontem: hoje é 0, a semana fica", () => {
    expect(contadoresAtuais(ops, "2026-10-14T10:00:00Z", QUI_15H)).toEqual({ ...ops, sentToday: 0 });
  });

  it("último envio na semana passada: tudo zerado", () => {
    expect(contadoresAtuais(ops, "2026-10-11T10:00:00Z", QUI_15H)).toEqual({ sentToday: 0, sentWeek: 0, weekData: [0, 0, 0, 0, 0, 0, 0] });
  });

  it("sem último envio conhecido: devolve como veio", () => {
    expect(contadoresAtuais(ops, "—", QUI_15H)).toEqual(ops);
    expect(contadoresAtuais(ops, undefined, QUI_15H)).toEqual(ops);
  });

  it("aceita Date (a linha do Prisma)", () => {
    expect(contadoresAtuais(ops, new Date("2026-10-14T10:00:00Z"), QUI_15H).sentToday).toBe(0);
  });
});
