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

describe("upgradeMLImageUrl", () => {
  // Foto real do produto do link meli.la/1GVzsNo. A CDN serve o MESMO id em
  // dezenas de tamanhos; a remontagem tem que chegar sempre no mesmo destino.
  const CANON = "https://http2.mlstatic.com/D_NQ_NP_2X_682596-MLB112404223609_052026-F.webp";

  it("remonta qualquer variante de miniatura na versão grande", () => {
    // og:image da landing de afiliado (428x500)
    expect(upgradeMLImageUrl("https://http2.mlstatic.com/D_NQ_NP_682596-MLB112404223609_052026-O.webp")).toBe(CANON);
    // tira de miniaturas da galeria da PDP (70x70) — era o caso do teste manual
    expect(upgradeMLImageUrl("https://http2.mlstatic.com/D_Q_NP_682596-MLB112404223609_052026-R.webp")).toBe(CANON);
    // card do Hub (320x320)
    expect(upgradeMLImageUrl("https://http2.mlstatic.com/D_Q_NP_2X_682596-MLB112404223609_052026-T.webp")).toBe(CANON);
    // sufixo de duas letras
    expect(upgradeMLImageUrl("https://http2.mlstatic.com/D_NQ_682596-MLB112404223609_052026-OO.webp")).toBe(CANON);
    // já é a grande — idempotente
    expect(upgradeMLImageUrl(CANON)).toBe(CANON);
  });

  it("funciona sem extensão e descarta query/hash", () => {
    expect(upgradeMLImageUrl("https://http2.mlstatic.com/D_Q_NP_682596-MLB112404223609_052026-R")).toBe(CANON);
    expect(upgradeMLImageUrl("https://http2.mlstatic.com/D_Q_NP_682596-MLB112404223609_052026-R.webp?v=2#x")).toBe(CANON);
  });

  it("preserva o host quando a foto vem de outro nó da CDN", () => {
    expect(upgradeMLImageUrl("https://mla-s2-p.mlstatic.com/D_Q_NP_682596-MLB112404223609_052026-R.webp"))
      .toBe("https://mla-s2-p.mlstatic.com/D_NQ_NP_2X_682596-MLB112404223609_052026-F.webp");
  });

  // Sem id de foto (asset do próprio site) cai na troca de sufixo, que só casa
  // MAIÚSCULA — casar minúscula comeria a última letra do título saneado.
  it("sem id de foto, só troca o sufixo — e não confunde letra do título", () => {
    const u = "https://http2.mlstatic.com/frontend-assets/ui-navigation/logo-i.webp";
    expect(upgradeMLImageUrl(u)).toBe(u);
    expect(upgradeMLImageUrl("https://http2.mlstatic.com/frontend-assets/banner-O.webp"))
      .toBe("https://http2.mlstatic.com/frontend-assets/banner-F.webp");
  });

  it("não mexe em URL de outro domínio nem em valor vazio", () => {
    const u = "https://exemplo.com/D_NQ_NP_682596-MLB112404223609_052026-O.webp";
    expect(upgradeMLImageUrl(u)).toBe(u);
    expect(upgradeMLImageUrl(null)).toBe(null);
  });
});

describe("upgradeImageUrl", () => {
  it("escolhe a regra certa pelo domínio da imagem", () => {
    expect(upgradeImageUrl("https://http2.mlstatic.com/D_NQ_NP_123-O.webp"))
      .toBe("https://http2.mlstatic.com/D_NQ_NP_123-F.webp");
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
