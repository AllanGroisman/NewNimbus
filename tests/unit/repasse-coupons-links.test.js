// Os produtos que chegaram com cada cupom do repasse (Admin › Cupom › Repasse,
// linha aberta) e o último teste no checkout feito em cada um.
//
// O que se protege aqui é a costura das duas metades: o link vem do log de
// captura e o resultado vem do diário do teste, que só sabe de qual produto se
// trata porque o registrarCheckout grava a `url` nele.
//
// `backend/db.js` e `coupons/pg.js` entram por require.cache — os unitários não
// tocam em Postgres.
import "../helpers/env.js";
import { describe, it, expect, beforeEach } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const BACKEND = path.resolve(__dirname, "..", "..", "backend");
const DB_JS = path.join(BACKEND, "db.js");
const PG_JS = path.join(BACKEND, "coupons", "pg.js");
const CATALOG_PG_JS = path.join(BACKEND, "catalog", "pg.js");

let rawResults = [];
let rawCalls = [];
let criados = [];
let codigo = null;
let vinculos = [];
const fakePrisma = {
  mlCouponCode: { findUnique: async () => codigo },
  mlCouponProduct: { findMany: async ({ where }) => vinculos.filter(v => where.productKey.in.includes(v.productKey)) },
  $queryRaw: async (strings, ...values) => { rawCalls.push({ sql: strings.join("?"), values }); return rawResults.shift() || []; },
  repasseCouponAutotest: { create: async ({ data }) => { criados.push(data); return data; } },
};
require.cache[DB_JS] = {
  id: DB_JS, filename: DB_JS, loaded: true, children: [], paths: [],
  exports: { prisma: () => fakePrisma, disconnect: async () => {} },
};
require.cache[PG_JS] = {
  id: PG_JS, filename: PG_JS, loaded: true, children: [], paths: [],
  exports: { recordCodeCheck: async (f) => ({ ...f, checkedAt: new Date(), checkCount: 1 }) },
};

require.cache[CATALOG_PG_JS] = {
  id: CATALOG_PG_JS, filename: CATALOG_PG_JS, loaded: true, children: [], paths: [],
  exports: { resolveKeys: async () => new Map() },
};

const { linksDoCupom } = require(path.join(BACKEND, "repasse", "coupons.js"));
const autotest = require(path.join(BACKEND, "repasse", "coupon-autotest.js"));

const A = "https://produto.mercadolivre.com.br/MLB-1-caixa-_JM";
const B = "https://produto.mercadolivre.com.br/MLB-2-fone-_JM";

beforeEach(() => {
  rawResults = [];
  rawCalls = [];
  criados = [];
  codigo = null;
  vinculos = [];
});

describe("linksDoCupom", () => {
  it("junta a cada link o último teste feito nele", async () => {
    const em = new Date("2026-09-25T10:00:00Z");
    rawResults = [
      [
        { url: A, capturas: 3n, ultima: em, aproveitado: true, productName: "Caixa", productImg: "img", price: 99.9 },
        { url: B, capturas: 1n, ultima: em, aproveitado: false, productName: null, productImg: null, price: null },
      ],
      [{ url: A, verdict: "valid", message: "Aplicado no checkout", em }],
    ];

    const r = await linksDoCupom(" jbl20 ");

    expect(r).toEqual([
      { url: A, productName: "Caixa", productImg: "img", price: 99.9, capturas: 3, ultima: em, aproveitado: true,
        ultimoTeste: { verdict: "valid", message: "Aplicado no checkout", em }, vinculo: null },
      { url: B, productName: null, productImg: null, price: null, capturas: 1, ultima: em, aproveitado: false, ultimoTeste: null, vinculo: null },
    ]);
    // Código normalizado nas duas consultas, e o diário filtrado pelos links achados.
    expect(rawCalls[0].values).toContain("JBL20");
    expect(rawCalls[1].values).toEqual(expect.arrayContaining(["JBL20", [A, B]]));
  });

  it("diz qual vínculo cada produto tem com a campanha do código, ficando o mais forte", async () => {
    const { chavesCandidatas } = require(path.join(BACKEND, "coupons", "quick-check.js"));
    const em = new Date();
    codigo = { campaignId: "13663633" };
    const [chaveA] = chavesCandidatas(A);
    vinculos = [{ productKey: chaveA, origem: "repasse" }, { productKey: chaveA, origem: "checkout" }];
    rawResults = [[
      { url: A, capturas: 1n, ultima: em, aproveitado: true },
      { url: B, capturas: 1n, ultima: em, aproveitado: true },
    ], []];

    const r = await linksDoCupom("JBL20");
    expect(r.map(p => p.vinculo)).toEqual(["checkout", null]);
  });

  it("sem link, não consulta o diário", async () => {
    rawResults = [[]];
    expect(await linksDoCupom("JBL20")).toEqual([]);
    expect(rawCalls).toHaveLength(1);
  });

  it("código vazio não vai ao banco", async () => {
    expect(await linksDoCupom("  ")).toEqual([]);
    expect(rawCalls).toHaveLength(0);
  });
});

describe("registrarCheckout grava o produto testado no diário", () => {
  it("a url do teste vai para a linha do diário", async () => {
    await autotest.registrarCheckout({ code: "jbl20", url: B, material: { notProductPage: true } });
    const teste = criados.find(c => c.action === "test");
    expect(teste).toMatchObject({ code: "JBL20", url: B });
  });
});
