// A leitura da vitrine de um cupom pela landing de afiliado, sem navegador
// (backend/scraping/ml-vitrine-landing.js). Tudo aqui é puro: entra o HTML que o
// ML serviu, sai produto.
//
// A fixture é um recorte de uma landing DE VERDADE (sonda de 26/08/2026,
// backend/logs/ml-vitrine/), reduzida a dois produtos — e com a armadilha
// preservada: uma aba de recomendação do perfil do afiliado, com produto dentro,
// aninhada em `tabs`. Na landing real são 41 produtos assim contra 5 do cupom, e
// tratar qualquer um deles como "coberto pelo cupom" faria a fila do repasse
// anunciar desconto que não existe.

import { describe, it, expect } from "vitest";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ml = require(path.resolve(__dirname, "..", "..", "backend", "scraping", "ml-vitrine-landing.js"));

const html = fs.readFileSync(path.resolve(__dirname, "..", "fixtures", "ml-vitrine-landing.html"), "utf8");
const VITRINE = "https://lista.mercadolivre.com.br/_Container_toys-e-babys?coupon_campaign_id=13471229";

describe("parseVitrineLanding", () => {
  it("lê os produtos do carrossel da vitrine", () => {
    const r = ml.parseVitrineLanding(html, VITRINE);
    expect(r.ok).toBe(true);
    expect(r.products).toHaveLength(2);
    expect(r.products[0].name).toBeTruthy();
    expect(r.products[0].price).toBeGreaterThan(0);
    expect(r.products[0].store).toBe("Mercado Livre");
    expect(r.products[0].mlItemId).toMatch(/^MLB\d+$/);
  });

  it("A ARMADILHA: não pega os produtos das abas de recomendação do perfil", () => {
    const r = ml.parseVitrineLanding(html, VITRINE);
    // O produto plantado nas `tabs` da fixture. Se ele aparecer aqui, a busca
    // virou recursiva e o sistema passou a carimbar cupom em item aleatório.
    expect(r.products.map(p => p.mlItemId)).not.toContain("MLB9999999999");
  });

  it("não é a vitrine inteira, e o texto não promete que é", () => {
    const r = ml.parseVitrineLanding(html, VITRINE);
    expect(r.total).toBe(5);          // o ML disse 5; a prévia trouxe 2
    expect(r.reason).toContain("prévia");
  });

  it("carrossel de OUTRA listagem é recusado, não adivinhado", () => {
    const r = ml.parseVitrineLanding(html, "https://lista.mercadolivre.com.br/_Container_outra?coupon_campaign_id=99999");
    expect(r.ok).toBe(false);
    expect(r.kind).toBe("outra-vitrine");
    expect(r.products).toEqual([]);
  });

  it("os muros do ML são reconhecidos um a um", () => {
    const muro = (corpo, url = "") => ml.parseVitrineLanding(corpo, VITRINE, url).kind;
    expect(muro("<html>não sou um robô</html>")).toBe("captcha");
    expect(muro("<html>oi</html>", "https://www.mercadolivre.com.br/gz/account-verification?go=x")).toBe("verificacao");
    expect(muro('<div class="micro-landing-container">')).toBe("desafio");
    expect(muro("<html>Acesse sua conta para continuar</html>")).toBe("login");
  });

  it("página sem o modelo não vira produto nenhum", () => {
    const r = ml.parseVitrineLanding("<html><body>nada aqui</body></html>", VITRINE);
    expect(r.ok).toBe(false);
    expect(r.kind).toBe("sem-produtos");
  });

  it("entrada podre não quebra", () => {
    expect(ml.parseVitrineLanding(null, VITRINE).ok).toBe(false);
    expect(ml.parseVitrineLanding(html, null).kind).toBe("outra-vitrine");
  });
});

describe("assinaturaDaVitrine", () => {
  // O ML devolve o seeMoreLink com rastreio no fragmento; o que identifica a
  // vitrine de verdade é a campanha.
  it("a campanha manda quando existe — fragmento e rastreio não atrapalham", () => {
    const a = ml.assinaturaDaVitrine(VITRINE);
    const b = ml.assinaturaDaVitrine(`${VITRINE}#tracking_id=abc&source=affiliate-profile`);
    expect(a).toBe(b);
    expect(a).toBe("campanha:13471229");
  });

  it("sem campanha na URL, vale o caminho (é onde mora o _Container_)", () => {
    expect(ml.assinaturaDaVitrine("https://lista.mercadolivre.com.br/_CustId_123"))
      .toBe("caminho:lista.mercadolivre.com.br/_CustId_123");
  });

  it("campanhas diferentes nunca colidem", () => {
    expect(ml.assinaturaDaVitrine(VITRINE)).not.toBe(
      ml.assinaturaDaVitrine("https://lista.mercadolivre.com.br/_Container_toys-e-babys?coupon_campaign_id=99999"));
  });

  it("URL inválida não vira assinatura", () => {
    expect(ml.assinaturaDaVitrine("nem-url")).toBe(null);
    expect(ml.assinaturaDaVitrine(null)).toBe(null);
  });
});
