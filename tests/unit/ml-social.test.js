// Leitura da landing de afiliado do ML (mercadolivre.com.br/social/...) sem navegador.
//
// O fixture é uma landing REAL (25/08/2026), com o script `_n.ctx.r={...}` do jeito
// que o ML serve. É ele que garante a parte que mais importa aqui: a página tem
// DOIS blocos de produtos — o `card-featured` do topo, que é o produto
// compartilhado, e o carrossel "Quem viu este produto também comprou", com 17
// outros. Mandar o produto errado pro grupo de um cliente é pior do que não
// mandar nada, então o carrossel não pode vazar nunca.

import "../helpers/env.js";
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const backend = path.resolve(__dirname, "..", "..", "backend");
const mlSocial = require(path.join(backend, "scraping", "ml-social.js"));
const { parseSocialLanding, isAffiliateShareUrl, isAffiliateProfileUrl, sliceBalancedJson, isTransientFetchError } = mlSocial;

const LANDING_URL = "https://www.mercadolivre.com.br/social/gl20260410130458?matt_word=gl20260410130458&forceInApp=true";
const html = fs.readFileSync(path.resolve(__dirname, "..", "fixtures", "ml-social-landing.html"), "utf8");

// Monta uma landing com o estado que o teste quiser, no mesmo embrulho do ML.
function landingWith(state) {
  return `<!DOCTYPE html><html><head><title>x</title></head><body>` +
    `<script id="__NORDIC_RENDERING_CTX__">_n.ctx.r=${JSON.stringify(state)};` +
    `_n.ctx.l={scripts:new Set(["a.js"])};</scr` + `ipt></body></html>`;
}

function stateWithFeatured(polycards) {
  return {
    appProps: { pageProps: { data: { components: [
      { id: "affiliate-profile-header", type: "header" },
      { id: "card-featured", type: "recommendations", recommendation_data: { recommendation_info: {
        polycard_context: { picture_template: "https://img/{id}-{size}.webp", url_prefix: "https://" },
        polycards,
      } } },
    ] } } },
  };
}

function polycard(id, title, price) {
  return {
    metadata: { id, url: `www.mercadolivre.com.br/x/p/${id}` },
    pictures: { pictures: [{ id: "1" }], square: "Q" },
    components: [
      { type: "title", id: "title", title: { text: title } },
      { type: "price", id: "price", price: { current_price: { value: price } } },
    ],
  };
}

describe("parseSocialLanding — landing real", () => {
  it("lê o produto em destaque com o permalink do catálogo", () => {
    const r = parseSocialLanding(html, LANDING_URL);
    expect(r.ok).toBe(true);
    expect(r.kind).toBe("ok");
    expect(r.product.name).toBe("Controle Sem Fio Xbox Series S/x Robot White Branco");
    expect(r.product.price).toBe(442);
    expect(r.product.img).toMatch(/^https:\/\/http2\.mlstatic\.com\//);
    expect(r.product.store).toBe("Mercado Livre");
  });

  it("guarda o permalink do produto, não a landing do outro afiliado", () => {
    const { product } = parseSocialLanding(html, LANDING_URL);
    // /p/MLB… é o formato que a API de afiliado do ML aceita na hora de reafiliar.
    expect(product.link).toBe("https://www.mercadolivre.com.br/controle-sem-fio-xbox-series-sx-robot-white-branco/p/MLB52371739");
    expect(product.finalUrl).toBe(product.link);
    expect(product.link).not.toMatch(/\/social\//);
  });

  it("não deixa o carrossel \"Quem viu também comprou\" contaminar o resultado", () => {
    // O fixture tem 17 cards nesse carrossel; nenhum deles pode virar o produto.
    const { product } = parseSocialLanding(html, LANDING_URL);
    const carrossel = ["Controle Xbox Series X/s Wireless Original Robot White Branco",
                       "Controle Joystick Sem Fio Microsoft Xbox S e X"];
    expect(carrossel).not.toContain(product.name);
    expect(html).toContain("Quem viu este produto também comprou");   // o carrossel está mesmo lá
  });

  it("o produto sai completo o bastante pra passar na validação do repasse", () => {
    const { product } = parseSocialLanding(html, LANDING_URL);
    // capture.js descarta o que não tiver nome, foto E preço.
    expect(product.name && product.img && product.price != null).toBeTruthy();
  });
});

describe("parseSocialLanding — quando é melhor recusar", () => {
  it("mais de um produto em destaque não vira chute", () => {
    const r = parseSocialLanding(landingWith(stateWithFeatured([
      polycard("MLB1", "Um", 10), polycard("MLB2", "Outro", 20),
    ])), LANDING_URL);
    expect(r.ok).toBe(false);
    expect(r.kind).toBe("nao-e-produto");
    expect(r.product).toBeNull();
    expect(r.reason).toMatch(/2 produtos/);
  });

  it("landing sem produto em destaque devolve nao-e-produto", () => {
    const r = parseSocialLanding(landingWith(stateWithFeatured([])), LANDING_URL);
    expect(r.ok).toBe(false);
    expect(r.kind).toBe("nao-e-produto");
  });

  it("página sem o bloco card-featured (perfil, lista) devolve nao-e-produto", () => {
    const r = parseSocialLanding(landingWith({ appProps: { pageProps: { data: { components: [
      { id: "affiliate-profile-header", type: "header" },
    ] } } } }), LANDING_URL);
    expect(r.ok).toBe(false);
    expect(r.kind).toBe("nao-e-produto");
  });

  it("card sem preço não vira produto sem preço", () => {
    const semPreco = polycard("MLB1", "Um", null);
    semPreco.components = semPreco.components.filter(c => c.type !== "price");
    const r = parseSocialLanding(landingWith(stateWithFeatured([semPreco])), LANDING_URL);
    expect(r.ok).toBe(false);
    expect(r.kind).toBe("nao-e-produto");
  });

  it("HTML vazio ou lixo não explode", () => {
    for (const lixo of ["", "<html></html>", null, undefined]) {
      const r = parseSocialLanding(lixo, LANDING_URL);
      expect(r.ok).toBe(false);
      expect(r.product).toBeNull();
    }
  });
});

describe("parseSocialLanding — muros do ML", () => {
  it("muro de CAPTCHA é reconhecido como captcha", () => {
    const r = parseSocialLanding("<html><title>Seguridad</title><body>Para continuar, resolva o captcha</body></html>",
      "https://www.mercadolivre.com.br/captcha/wall");
    expect(r.kind).toBe("captcha");
    expect(r.ok).toBe(false);
  });

  it("muro de login é reconhecido como login, com o conselho do cookie", () => {
    const r = parseSocialLanding("<html><body>Acesse sua conta para continuar</body></html>",
      "https://www.mercadolivre.com.br/gz/login");
    expect(r.kind).toBe("login");
    expect(r.reason).toMatch(/cookie/i);
  });

  it("landing boa não é confundida com muro", () => {
    // A checagem de muro só roda DEPOIS de a extração falhar — uma palavra solta
    // na página não pode transformar leitura boa em bloqueio falso.
    expect(parseSocialLanding(html, LANDING_URL).kind).toBe("ok");
  });
});

describe("classificação de URL", () => {
  it("reconhece landing e encurtador do ML como caminho sem navegador", () => {
    expect(isAffiliateShareUrl("https://www.mercadolivre.com.br/social/abc?x=1")).toBe(true);
    expect(isAffiliateShareUrl("https://meli.la/2J8jzRj")).toBe(true);
    expect(isAffiliateShareUrl("https://mlb.li/abc")).toBe(true);
    expect(isAffiliateShareUrl("https://www.mercadolivre.com.br/x/p/MLB123")).toBe(false);
    expect(isAffiliateShareUrl("não é url")).toBe(false);
  });

  it("separa perfil/lista do afiliado da landing de produto", () => {
    expect(isAffiliateProfileUrl("https://www.mercadolivre.com.br/social/gl123/lists")).toBe(true);
    expect(isAffiliateProfileUrl("https://www.mercadolivre.com.br/social/gl123/list/42")).toBe(true);
    expect(isAffiliateProfileUrl("https://www.mercadolivre.com.br/social/gl123")).toBe(false);
    expect(isAffiliateProfileUrl("https://www.mercadolivre.com.br/social/gl123?forceInApp=true")).toBe(false);
  });
});

describe("sliceBalancedJson", () => {
  it("para no fim do objeto, ignorando chave dentro de string", () => {
    const s = 'x=_n.ctx.r={"a":"}{","b":{"c":1}};_n.ctx.l={};';
    expect(JSON.parse(sliceBalancedJson(s, "_n.ctx.r="))).toEqual({ a: "}{", b: { c: 1 } });
  });

  it("objeto que não fecha devolve null em vez de meio JSON", () => {
    expect(sliceBalancedJson('_n.ctx.r={"a":1', "_n.ctx.r=")).toBeNull();
    expect(sliceBalancedJson("sem marcador", "_n.ctx.r=")).toBeNull();
  });
});

describe("falha de rede vs. link ruim", () => {
  // Em 25/08/2026 um `dns.lookup` falhou por um instante e o repasse inteiro foi
  // descartado: sem segunda chance aqui, a próxima parada é o navegador, que o
  // ML bloqueia por CAPTCHA.
  it("soluço de rede merece nova tentativa", () => {
    expect(isTransientFetchError(new Error("Não consegui resolver o endereço do link"))).toBe(true);
    expect(isTransientFetchError(new Error("fetch failed"))).toBe(true);
    expect(isTransientFetchError(new Error("The operation was aborted"))).toBe(true);
    expect(isTransientFetchError(new Error("socket hang up"))).toBe(true);
  });

  it("link inválido ou barrado pelo guard não se repete", () => {
    expect(isTransientFetchError(new Error("URL inválida"))).toBe(false);
    expect(isTransientFetchError(new Error("URL aponta para um endereço interno"))).toBe(false);
    expect(isTransientFetchError(new Error("Só aceito links http ou https"))).toBe(false);
    expect(isTransientFetchError(new Error("Link não reconhecido. Aceito links de Mercado Livre..."))).toBe(false);
    expect(isTransientFetchError(new Error("Link com redirecionamentos demais"))).toBe(false);
  });

  it("erro sem mensagem não vira re-tentativa às cegas", () => {
    expect(isTransientFetchError(null)).toBe(false);
    expect(isTransientFetchError(new Error(""))).toBe(false);
  });
});
