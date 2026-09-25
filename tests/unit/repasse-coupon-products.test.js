// Os produtos que chegaram com um cupom no repasse, ligados a ele como vínculo
// fraco (backend/repasse/coupon-products.js).
//
// O que se protege: só código APROVADO e com a campanha aqui liga alguma coisa
// (o vínculo tem FK para a campanha, e ligar produto a palavra que o ML recusou
// seria mentir no catálogo); cada link vira um item com as chaves que o resto do
// sistema usa; e o produto que o catálogo não tem entra com os dados da captura.
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

let estado;
const fakePrisma = {
  mlCouponCode: { findUnique: async () => estado.code },
  mlCoupon: { findUnique: async () => estado.cupom },
  catalogProduct: { findFirst: async () => estado.noCatalogo },
  $queryRaw: async () => estado.links,
};
const falso = (file, exports) => {
  require.cache[file] = { id: file, filename: file, loaded: true, children: [], paths: [], exports };
};
falso(DB_JS, { prisma: () => fakePrisma, disconnect: async () => {} });
falso(PG_JS, {
  vincularDoRepasse: async (campaignId, itens) => {
    estado.vinculou.push({ campaignId, itens });
    return { vinculados: itens.length, novos: itens.length };
  },
});
falso(CATALOG_PG_JS, {
  upsertProducts: async (ps) => { estado.catalogo.push(...ps); return { inserted: ps.length }; },
});

const { ligarProdutosDoRepasse } = require(path.join(BACKEND, "repasse", "coupon-products.js"));
const { chavesCandidatas } = require(path.join(BACKEND, "coupons", "quick-check.js"));

const A = "https://produto.mercadolivre.com.br/MLB-5643170848-tnis-adidas-_JM";
const B = "https://www.mercadolivre.com.br/airfryer-wap/p/MLB67328409";

beforeEach(() => {
  estado = {
    code: { verdict: "valid", campaignId: "13663633" },
    cupom: { expiresAt: new Date(Date.now() + 864e5) },
    noCatalogo: null,
    links: [
      { url: A, productName: "Tênis adidas", productImg: null, price: 199.9, originalPrice: 299.9, discount: 33, sold: 120 },
      { url: B, productName: "Airfryer WAP", productImg: null, price: 349, originalPrice: null, discount: null, sold: null },
    ],
    vinculou: [],
    catalogo: [],
  };
});

describe("ligarProdutosDoRepasse", () => {
  it("liga cada link do código aprovado, com as chaves do resto do sistema", async () => {
    const r = await ligarProdutosDoRepasse("melhorcupom");

    expect(r).toMatchObject({ campaignId: "13663633", produtos: 2, novos: 2, noCatalogo: 2 });
    expect(estado.vinculou).toEqual([{
      campaignId: "13663633",
      itens: [
        { productKeys: chavesCandidatas(A), productUrl: A },
        { productKeys: chavesCandidatas(B), productUrl: B },
      ],
    }]);
  });

  it("produto novo entra no catálogo com os dados da captura", async () => {
    await ligarProdutosDoRepasse("MELHORCUPOM");
    expect(estado.catalogo[0]).toMatchObject({
      name: "Tênis adidas", link: A, price: 199.9, originalPrice: 299.9, discount: 33, store: "Mercado Livre",
    });
  });

  it("produto que o catálogo já tem não é regravado", async () => {
    estado.noCatalogo = { key: "x" };
    const r = await ligarProdutosDoRepasse("MELHORCUPOM");
    expect(estado.catalogo).toEqual([]);
    expect(r.noCatalogo).toBe(0);
    expect(estado.vinculou[0].itens).toHaveLength(2);
  });

  it("link que não é página de produto fica de fora (e não vira produto falso)", async () => {
    estado.links = [
      { url: "https://meli.la/2cnhGxa", productName: "?" },
      { url: "https://www.mercadolivre.com.br/ofertas", productName: "Ofertas do dia" },
      estado.links[0],
    ];
    await ligarProdutosDoRepasse("MELHORCUPOM");
    expect(estado.vinculou[0].itens.map(i => i.productUrl)).toEqual([A]);
    expect(estado.catalogo.map(p => p.link)).toEqual([A]);
  });

  it.each([
    ["código não aprovado", () => { estado.code = { verdict: "indeterminado", campaignId: "13663633" }; }, "nao-aprovado"],
    ["código nunca testado", () => { estado.code = null; }, "nao-aprovado"],
    ["campanha fora do sistema", () => { estado.cupom = null; }, "campanha-fora"],
    ["campanha vencida", () => { estado.cupom = { expiresAt: new Date(Date.now() - 1000) }; }, "vencido"],
  ])("%s → não liga nada", async (_nome, preparar, motivo) => {
    preparar();
    expect(await ligarProdutosDoRepasse("MELHORCUPOM")).toEqual({ pulado: motivo });
    expect(estado.vinculou).toEqual([]);
    expect(estado.catalogo).toEqual([]);
  });
});
