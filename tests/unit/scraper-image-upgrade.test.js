// Subir a resolução da foto do produto antes de mandar pro WhatsApp.
// Funções puras (só mexem na URL), sem rede.

import "../helpers/env.js";
import { describe, it, expect } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const scraper = require(path.resolve(__dirname, "..", "..", "backend", "scraping", "scraper.js"));

const { upgradeShopeeImageUrl, upgradeImageUrl, upgradeMLImageUrl, upgradeAmazonImageUrl } = scraper;

describe("upgradeShopeeImageUrl", () => {
  it("tira o sufixo de miniatura (_tn) da CDN da Shopee", () => {
    expect(upgradeShopeeImageUrl("https://down-br.img.susercontent.com/file/abc123_tn"))
      .toBe("https://down-br.img.susercontent.com/file/abc123");
    expect(upgradeShopeeImageUrl("https://cf.shopee.com.br/file/abc123_tn.webp"))
      .toBe("https://cf.shopee.com.br/file/abc123.webp");
  });

  it("não mexe em URL que já é a original", () => {
    const u = "https://down-br.img.susercontent.com/file/abc123";
    expect(upgradeShopeeImageUrl(u)).toBe(u);
  });

  it("não mexe em URL de outro domínio nem em valor vazio", () => {
    expect(upgradeShopeeImageUrl("https://exemplo.com/foto_tn.jpg")).toBe("https://exemplo.com/foto_tn.jpg");
    expect(upgradeShopeeImageUrl(null)).toBe(null);
    expect(upgradeShopeeImageUrl("")).toBe("");
  });
});

describe("upgradeImageUrl", () => {
  it("escolhe a regra certa pelo domínio da imagem", () => {
    expect(upgradeImageUrl("https://http2.mlstatic.com/D_NQ_NP_123-O.webp"))
      .toBe(upgradeMLImageUrl("https://http2.mlstatic.com/D_NQ_NP_123-O.webp"));
    expect(upgradeImageUrl("https://m.media-amazon.com/images/I/71x._AC_UY218_QL90_.jpg"))
      .toBe(upgradeAmazonImageUrl("https://m.media-amazon.com/images/I/71x._AC_UY218_QL90_.jpg"));
    expect(upgradeImageUrl("https://cf.shopee.com.br/file/abc_tn"))
      .toBe("https://cf.shopee.com.br/file/abc");
  });

  it("devolve intacta a URL de loja desconhecida", () => {
    const u = "https://cdn.lojaqualquer.com/img/produto.jpg";
    expect(upgradeImageUrl(u)).toBe(u);
    expect(upgradeImageUrl(null)).toBe(null);
  });
});

describe("shopeeNodeToProduct", () => {
  it("já grava a foto em resolução original", () => {
    const p = scraper.shopeeNodeToProduct({
      productName: "Fone",
      offerLink: "https://s.shopee.com.br/abc",
      imageUrl: "https://cf.shopee.com.br/file/xyz_tn",
      price: 99.9,
    }, "eletronicos");
    expect(p.img).toBe("https://cf.shopee.com.br/file/xyz");
  });
});
