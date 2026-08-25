// Resumo do log de repasse. O que estes testes protegem é a frase que o painel
// precisa poder escrever: "o ML não aprova nada desde as 14h — 90 tentativas
// seguidas falharam, por CAPTCHA". Cada pedaço dessa frase é um campo aqui.

import "../helpers/env.js";
import { describe, it, expect } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const backend = path.resolve(__dirname, "..", "..", "backend");
const { buildSummary, clampHours } = require(path.join(backend, "repasse", "summary.js"));

// Prisma de mentira: devolve as linhas conforme a "forma" da chamada (quais
// colunas do groupBy). Assim o teste roda sem banco e sem depender de fixtures.
function fakePrisma({ byOutcome = [], byKind = [], byStoreOutcome = [], byStoreKind = [], lastOk = [], counts = {}, hourly = [] }) {
  const calls = { count: [] };
  const client = {
    repasseCaptureLog: {
      groupBy: async ({ by }) => {
        const key = by.join(",");
        if (key === "outcome") return byOutcome;
        if (key === "errorKind") return byKind;
        if (key === "store,outcome") return byStoreOutcome;
        if (key === "store,errorKind") return byStoreKind;
        if (key === "store") return lastOk;
        throw new Error(`groupBy inesperado: ${key}`);
      },
      count: async ({ where }) => {
        calls.count.push(where);
        return counts[where.store] ?? 0;
      },
    },
    $queryRaw: async () => hourly,
  };
  const fn = () => client;
  fn.calls = calls;
  return fn;
}

const c = n => ({ _count: { _all: n } });

describe("clampHours", () => {
  it("padrão 24h; prende no mínimo de 1h e no máximo de 7 dias", () => {
    expect(clampHours(undefined)).toBe(24);
    expect(clampHours("abc")).toBe(24);
    expect(clampHours("1")).toBe(1);
    expect(clampHours("0")).toBe(1);
    expect(clampHours("-5")).toBe(1);
    expect(clampHours("168")).toBe(168);
    expect(clampHours("99999")).toBe(168);
  });
});

describe("buildSummary", () => {
  const cenarioML = {
    byOutcome: [{ outcome: "discarded", ...c(90) }, { outcome: "queued", ...c(10) }],
    byKind: [
      { errorKind: "captcha", ...c(88), _max: { createdAt: new Date("2026-08-25T17:52:00Z") } },
      { errorKind: "timeout", ...c(2), _max: { createdAt: new Date("2026-08-25T15:00:00Z") } },
    ],
    byStoreOutcome: [
      { store: "Mercado Livre", outcome: "discarded", ...c(90) },
      { store: "Amazon", outcome: "queued", ...c(10) },
    ],
    byStoreKind: [
      { store: "Mercado Livre", errorKind: "captcha", ...c(88) },
      { store: "Mercado Livre", errorKind: "timeout", ...c(2) },
    ],
    lastOk: [
      { store: "Mercado Livre", _max: { createdAt: new Date("2026-08-25T14:03:00Z") } },
      { store: "Amazon", _max: { createdAt: new Date("2026-08-25T17:00:00Z") } },
    ],
    counts: { "Mercado Livre": 90, Amazon: 0 },
  };

  it("conta o total e a quebra por resultado", async () => {
    const s = await buildSummary(fakePrisma(cenarioML), { hours: 24 });
    expect(s.total).toBe(100);
    expect(s.byOutcome).toEqual({ discarded: 90, queued: 10 });
    expect(s.hours).toBe(24);
  });

  it("ordena os motivos do mais frequente pro menos", async () => {
    const s = await buildSummary(fakePrisma(cenarioML), { hours: 24 });
    expect(s.byErrorKind.map(k => k.kind)).toEqual(["captcha", "timeout"]);
    expect(s.byErrorKind[0].count).toBe(88);
    expect(s.byErrorKind[0].lastAt).toEqual(new Date("2026-08-25T17:52:00Z"));
  });

  it("dá o diagnóstico da loja parada: 0%, desde quando, quantas falhas e por quê", async () => {
    const s = await buildSummary(fakePrisma(cenarioML), { hours: 24 });
    const ml = s.byStore.find(x => x.store === "Mercado Livre");
    expect(ml.successRate).toBe(0);
    expect(ml.lastOkAt).toBe("2026-08-25T14:03:00.000Z");
    expect(ml.failuresSinceLastOk).toBe(90);
    expect(ml.topErrorKind).toBe("captcha");
  });

  it("loja saudável fica com 100% e sem falhas acumuladas", async () => {
    const s = await buildSummary(fakePrisma(cenarioML), { hours: 24 });
    const amz = s.byStore.find(x => x.store === "Amazon");
    expect(amz.successRate).toBe(100);
    expect(amz.failuresSinceLastOk).toBe(0);
    expect(amz.topErrorKind).toBeNull();
  });

  it("cooldown e duplicata não contam como falha na taxa", async () => {
    // Se contassem, uma campanha que só repete produto pareceria quebrada.
    const s = await buildSummary(fakePrisma({
      byStoreOutcome: [
        { store: "Shopee", outcome: "queued", ...c(5) },
        { store: "Shopee", outcome: "duplicate", ...c(20) },
        { store: "Shopee", outcome: "cooldown", ...c(10) },
      ],
      lastOk: [{ store: "Shopee", _max: { createdAt: new Date("2026-08-25T17:00:00Z") } }],
    }), { hours: 24 });
    expect(s.byStore[0].successRate).toBe(100);
    expect(s.byStore[0].total).toBe(35);
  });

  it("sem tentativa que conte, a taxa é null e não 0% (0% seria alarme falso)", async () => {
    const s = await buildSummary(fakePrisma({
      byStoreOutcome: [{ store: "Shopee", outcome: "duplicate", ...c(3) }],
    }), { hours: 24 });
    expect(s.byStore[0].successRate).toBeNull();
  });

  it("loja sem nenhuma linha não aparece no resumo", async () => {
    const s = await buildSummary(fakePrisma(cenarioML), { hours: 24 });
    expect(s.byStore.map(x => x.store)).toEqual(["Mercado Livre", "Amazon"]);
  });

  it("o último sucesso é procurado FORA da janela — parou há dias ≠ nunca funcionou", async () => {
    const prisma = fakePrisma(cenarioML);
    await buildSummary(prisma, { hours: 1 });
    // A contagem de falhas desde o último ok não pode herdar o corte da janela.
    for (const where of prisma.calls.count) {
      expect(where.createdAt?.gte).toBeUndefined();
    }
  });

  it("leva o catálogo de motivos junto, pra UI não manter cópia", async () => {
    const s = await buildSummary(fakePrisma(cenarioML), { hours: 24 });
    expect(s.kinds.captcha.label).toBeTruthy();
    expect(s.kinds["login-wall"].action).toMatch(/cookie/i);
  });
});
