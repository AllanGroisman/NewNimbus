// A porteira do agente local: o que ele manda de fora vira LISTA FECHADA no banco.
//
// Contexto (27/08/2026): a vitrine do cupom não abre para navegador automatizado
// — a sonda levou CAPTCHA até rodando fora da VPS. Quem percorre a vitrine agora é
// um Chrome de verdade, na máquina do admin — a extensão em `extension/` — e o
// que ela colhe entra por uma rota HTTP.
//
// Isso inverte a confiança: até aqui os produtos vinham de dentro do processo, e
// agora vêm de um payload. E o dado que ele carimba é o mais caro que existe
// nesta tabela — `origem: "vitrine"` é o único que autoriza o sistema a dizer
// "esse cupom NÃO cobre seu produto" (coupons/quick-check.js). Um link torto
// passando aqui vira cupom vinculado a produto que não é dele.
import "../helpers/env.js";
import { describe, it, expect } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const sync = require(path.resolve(__dirname, "..", "..", "backend", "coupons", "sync.js"));

const bom = (over = {}) => ({
  name: "Patinete Elétrico",
  link: "https://www.mercadolivre.com.br/patinete/p/MLB51133040",
  price: 6401,
  img: "https://http2.mlstatic.com/D_NQ_NP_1.webp",
  ...over,
});

describe("validarProdutosDaVitrine", () => {
  it("deixa passar o produto completo, já normalizado para o catálogo", () => {
    const { produtos, descartados } = sync.validarProdutosDaVitrine([bom()]);
    expect(descartados).toHaveLength(0);
    expect(produtos).toHaveLength(1);
    expect(produtos[0]).toMatchObject({ name: "Patinete Elétrico", price: 6401, store: "Mercado Livre" });
  });

  it("só copia os campos do catálogo — o payload de fora não escolhe coluna", () => {
    const { produtos } = sync.validarProdutosDaVitrine([bom({ origem: "vitrine", couponCampaignId: "999", id: 7 })]);
    expect(produtos[0].origem).toBeUndefined();
    expect(produtos[0].couponCampaignId).toBeUndefined();
    expect(produtos[0].id).toBeUndefined();
  });

  it("o que quebra caro: link de fora do Mercado Livre é descartado", () => {
    const { produtos, descartados } = sync.validarProdutosDaVitrine([
      bom({ link: "https://exemplo.com/produto" }),
      bom({ link: "https://www.mercadolivre.com.br.evil.com/p/MLB1" }),
      bom({ link: "http://127.0.0.1:3001/api/admin" }),
    ]);
    expect(produtos).toHaveLength(0);
    expect(descartados.map(d => d.motivo)).toEqual([
      "link não é do Mercado Livre", "link não é do Mercado Livre", "link não é do Mercado Livre",
    ]);
  });

  it("sem nome ou sem preço não entra — card lido pela metade não é produto", () => {
    const { produtos, descartados } = sync.validarProdutosDaVitrine([
      bom({ name: "   " }),
      bom({ price: null, link: "https://www.mercadolivre.com.br/b/p/MLB2" }),
      bom({ price: 0, link: "https://www.mercadolivre.com.br/c/p/MLB3" }),
      bom({ price: "6401", link: "https://www.mercadolivre.com.br/d/p/MLB4" }),
    ]);
    expect(produtos).toHaveLength(0);
    expect(descartados.map(d => d.motivo)).toEqual(["sem nome", "sem preço", "sem preço", "sem preço"]);
  });

  it("um card ruim no meio não derruba a vitrine inteira", () => {
    const { produtos, descartados } = sync.validarProdutosDaVitrine([
      bom({ link: "https://www.mercadolivre.com.br/a/p/MLB1" }),
      null,
      bom({ link: "https://www.mercadolivre.com.br/b/p/MLB2" }),
    ]);
    expect(produtos).toHaveLength(2);
    expect(descartados).toHaveLength(1);
  });

  it("repetido entra uma vez só (a paginação do ML repete card entre páginas)", () => {
    const { produtos, descartados } = sync.validarProdutosDaVitrine([bom(), bom(), bom()]);
    expect(produtos).toHaveLength(1);
    expect(descartados.map(d => d.motivo)).toEqual(["repetido", "repetido"]);
  });

  it("recusa o que não é lista, e o lote acima do teto", () => {
    expect(() => sync.validarProdutosDaVitrine(null)).toThrow(/lista de produtos/i);
    expect(() => sync.validarProdutosDaVitrine({ products: [] })).toThrow(/lista de produtos/i);
    const gigante = Array.from({ length: sync.MAX_PRODUTOS_DA_VITRINE + 1 }, (_, i) =>
      bom({ link: `https://www.mercadolivre.com.br/x/p/MLB${i}` }));
    expect(() => sync.validarProdutosDaVitrine(gigante)).toThrow(/teto/i);
  });
});
