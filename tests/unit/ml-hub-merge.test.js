// Juntar as ofertas do Hub de Afiliados com as da vitrine pública do ML.
// A dedup é pela CHAVE DO CATÁLOGO (o MLB do produto) e não pelo link, porque o
// mesmo produto aparece nos dois lugares com URLs diferentes — se fosse por link,
// o catálogo receberia o item duas vezes e ele sairia repetido nas campanhas.

import "../helpers/env.js";
import { describe, it, expect } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const backend = (...p) => require(path.resolve(__dirname, "..", "..", "backend", ...p));

const { mergeNewProducts } = backend("scraping", "scraper.js");
const { productKey } = backend("catalog", "product-key.js");

const vitrine = [
  { name: "Panela de pressão", link: "https://www.mercadolivre.com.br/panela-de-pressao/p/MLB51161616", price: 56.99, store: "Mercado Livre" },
  { name: "Fone bluetooth", link: "https://www.mercadolivre.com.br/fone-bluetooth/p/MLB99999999", price: 89.9, store: "Mercado Livre" },
];

describe("mergeNewProducts", () => {
  it("produto que já veio da vitrine não entra de novo, mesmo com URL diferente", () => {
    const doHub = [{
      // Mesmo MLB, URL diferente (slug do Hub).
      name: "Panela Pipoca Pipoqueira N°20",
      link: "https://www.mercadolivre.com.br/panela-pipoca-pipoqueira-n20-preto/p/MLB51161616",
      price: 56.99, store: "Mercado Livre", hub: true,
    }];
    expect(productKey(doHub[0])).toBe(productKey(vitrine[0]));
    expect(mergeNewProducts(vitrine, doHub)).toEqual([]);
  });

  it("produto que só existe no Hub entra", () => {
    const doHub = [{ name: "Kit ferramentas", link: "https://www.mercadolivre.com.br/kit-ferramentas/p/MLB77777777", price: 199, store: "Mercado Livre", hub: true }];
    const novos = mergeNewProducts(vitrine, doHub);
    expect(novos).toHaveLength(1);
    expect(novos[0].hub).toBe(true);
  });

  it("o próprio Hub repetindo o mesmo produto só entra uma vez", () => {
    const item = { name: "Kit ferramentas", link: "https://www.mercadolivre.com.br/kit/p/MLB77777777", price: 199, store: "Mercado Livre" };
    const novos = mergeNewProducts(vitrine, [item, { ...item, link: `${item.link}?utm=x` }]);
    expect(novos).toHaveLength(1);
  });

  it("Hub vazio ou fora do ar não mexe na coleta da vitrine", () => {
    expect(mergeNewProducts(vitrine, [])).toEqual([]);
    expect(mergeNewProducts(vitrine, null)).toEqual([]);
    expect(vitrine).toHaveLength(2);
  });

  it("card sem link é descartado", () => {
    expect(mergeNewProducts(vitrine, [{ name: "Sem link", price: 10 }])).toEqual([]);
  });
});
