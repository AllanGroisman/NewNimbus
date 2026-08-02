// Conversão dos cards do Hub de Afiliados (JSON "polycard" da API interna do ML)
// pro formato de produto do catálogo. polycardToProduct é pura — a fixture é um
// recorte REAL da captura de 02/08/2026 (backend/logs/ml-hub/2026-08-02T18-23-05-928Z).
// Se o ML mudar o formato dos cards, é aqui que quebra primeiro.

import "../helpers/env.js";
import { describe, it, expect } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { polycardToProduct } = require(path.resolve(__dirname, "..", "..", "backend", "scraping", "ml-hub.js"));
const fixture = require(path.resolve(__dirname, "..", "fixtures", "ml-hub-cards.json"));

const { context, cards } = fixture;
const byId = (id) => cards.find(c => c.metadata.id === id);

describe("polycardToProduct", () => {
  it("card com desconto: preço, preço anterior e % vêm prontos do JSON", () => {
    const p = polycardToProduct(byId("MLB3225819794"), context, "casa");
    expect(p.name.length).toBeGreaterThan(5);
    expect(p.price).toBe(110.54);
    expect(p.originalPrice).toBe(279.9);
    expect(p.discount).toBe(60);
    expect(p.category).toBe("casa");
    expect(p.store).toBe("Mercado Livre");
  });

  it("card sem preço anterior: sem desconto, e não inventa número", () => {
    const p = polycardToProduct(byId("MLB4516087361"), context);
    expect(p.price).toBe(56.99);
    expect(p.originalPrice).toBeNull();
    expect(p.discount).toBeNull();
  });

  it("nota e vendas saem do texto de acessibilidade, igual à vitrine", () => {
    const p = polycardToProduct(byId("MLB4516087361"), context);
    expect(p.rating).toBe(4.5);
    expect(p.sold).toMatch(/vendidos/i);
  });

  it("link é a URL canônica do produto, sem os parâmetros de rastreamento do Hub", () => {
    const p = polycardToProduct(byId("MLB3225819794"), context);
    expect(p.link).toMatch(/^https:\/\/www\.mercadolivre\.com\.br\//);
    expect(p.link).not.toContain("?");
    expect(p.link).not.toContain("#");
  });

  it("imagem é montada pelo template do ML no tamanho grande", () => {
    const p = polycardToProduct(byId("MLB3225819794"), context);
    expect(p.img).toMatch(/^https:\/\/http2\.mlstatic\.com\/D_/);
    expect(p.img).toMatch(/-F\.webp$/);
    expect(p.img).not.toContain("{");
  });

  it("comissão e selo do Hub viram campos extras (vão pro payload do catálogo)", () => {
    const p = polycardToProduct(byId("MLB3225819794"), context);
    expect(p.hub).toBe(true);
    expect(p.commission).toMatch(/^\d+([.,]\d+)?\s*%$/);
    expect(p.bestSeller).toBe(true);
    expect(p.mlItemId).toBe("MLB3225819794");
  });

  it("pega a comissão nos dois formatos do chip ('GANHOS 12%' e 'GANHOS EXTRAS' + '22%')", () => {
    // MLB3225819794 é do formato composto (o % fica num rótulo separado).
    expect(polycardToProduct(byId("MLB3225819794"), context).commission).toBe("22%");
    // MLB4516087361 é do formato simples, tudo no mesmo texto.
    expect(polycardToProduct(byId("MLB4516087361"), context).commission).toBe("12%");
  });

  it("selo diferente de 'MAIS VENDIDO' não marca bestSeller", () => {
    const p = polycardToProduct(byId("MLB6188452714"), context);
    expect(p.bestSeller).toBe(false);
  });

  it("desconto é calculado quando o ML não manda o rótulo", () => {
    const card = JSON.parse(JSON.stringify(byId("MLB3225819794")));
    delete card.components.find(c => c.type === "price").price.discount_label;
    const p = polycardToProduct(card, context);
    expect(p.discount).toBe(Math.round((1 - 110.54 / 279.9) * 100));
  });

  it("card capenga (sem título, sem preço ou sem URL) é descartado", () => {
    expect(polycardToProduct({}, context)).toBeNull();
    expect(polycardToProduct(null, context)).toBeNull();

    const semPreco = JSON.parse(JSON.stringify(byId("MLB3225819794")));
    semPreco.components = semPreco.components.filter(c => c.type !== "price");
    expect(polycardToProduct(semPreco, context)).toBeNull();

    const semUrl = JSON.parse(JSON.stringify(byId("MLB3225819794")));
    delete semUrl.metadata.url;
    expect(polycardToProduct(semUrl, context)).toBeNull();
  });

  it("sem o contexto do ML não quebra: fica sem imagem, mas com produto", () => {
    const p = polycardToProduct(byId("MLB3225819794"), {});
    expect(p).not.toBeNull();
    expect(p.img).toBeNull();
    expect(p.link).toMatch(/^https:\/\//);
  });
});
