// A varredura dos cupons pela landing e as amostras que viram produto — as partes
// que decidem, sem banco e sem rede.
//
// O que custa caro aqui não é tela quebrada:
//   - insistir depois de um muro do ML é o caminho mais curto pra queimar a conta
//     do sistema (a mesma do Hub de Afiliados);
//   - gravar como produto do cupom um item que a landing trouxe NO LUGAR do pedido
//     poria o selo "cupom" num produto que o cupom não cobre;
//   - gravar a amostra com o permalink `/up/MLBU…` criaria uma chave de catálogo que
//     nenhum vínculo acha — o produto entraria sem cupom nenhum.
//
// A rodada com banco fica em integration/coupons-landing-sweep.test.js.

import "../helpers/env.js";
import { describe, it, expect } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const backendDir = path.resolve(__dirname, "..", "..", "backend");
const sweep = require(path.join(backendDir, "coupons", "landing-sweep.js"));
const sweepConfig = require(path.join(backendDir, "coupons", "landing-sweep-config.js"));
const enrich = require(path.join(backendDir, "coupons", "enrich-samples.js"));
const pg = require(path.join(backendDir, "coupons", "pg.js"));
const { productKey } = require(path.join(backendDir, "catalog", "product-key.js"));

describe("decidirLanding", () => {
  it("grava quando a landing trouxe produto", () => {
    expect(sweep.decidirLanding({ ok: true, products: [{ name: "x" }] })).toBe("gravar");
  });

  it("para a rodada no muro do ML — CAPTCHA, verificação, desafio, cookie vencido", () => {
    for (const kind of ["captcha", "verificacao", "desafio", "login", "login-wall"]) {
      expect(sweep.decidirLanding({ ok: false, kind })).toBe("muro");
    }
  });

  it("para sem breaker quando falta a tag/cookie do sistema: não é bloqueio do ML", () => {
    expect(sweep.decidirLanding({ ok: false, kind: "afiliado-ausente" })).toBe("parar");
  });

  it("segue para o próximo quando a resposta é sobre ESTE cupom", () => {
    // Sem prévia, carrossel de outra vitrine, link recusado: o próximo cupom pode vir.
    for (const kind of ["sem-produtos", "outra-vitrine", "nao-e-produto", "http", "erro"]) {
      expect(sweep.decidirLanding({ ok: false, kind })).toBe("seguir");
    }
    // `ok` sem produto nenhum não é "gravar": gravaria zero e apagaria a prévia anterior.
    expect(sweep.decidirLanding({ ok: true, products: [] })).toBe("seguir");
    expect(sweep.decidirLanding(null)).toBe("seguir");
  });
});

describe("a config da varredura", () => {
  it("não deixa virar rajada: zero e negativo caem na faixa", () => {
    const c = sweepConfig.sanitize({ intervaloMs: 0, maxPorRodada: -5, pausaMs: -1, refazerHoras: 0 });
    expect(c.intervaloMs).toBe(60_000);
    expect(c.maxPorRodada).toBe(1);
    expect(c.pausaMs).toBe(0);
    expect(c.refazerHoras).toBe(1);
  });

  it("\"false\" de formulário desliga — `!!\"false\"` ligaria", () => {
    expect(sweepConfig.sanitize({ enabled: "false", enriquecerAmostras: "off" }))
      .toMatchObject({ enabled: false, enriquecerAmostras: false });
  });

  it("sem nada salvo, usa os defaults", () => {
    expect(sweepConfig.sanitize(null)).toEqual(sweepConfig.DEFAULTS);
  });
});

describe("amostra → produto de catálogo", () => {
  const lido = (over = {}) => ({
    ok: true, kind: "ok",
    product: {
      name: "Mini Desumidificador", price: 178.8, img: "https://http2.mlstatic.com/x.jpg",
      link: "https://www.mercadolivre.com.br/mini-desumidificador/up/MLBU4388129492",
      store: "Mercado Livre", mlItemId: "MLB4922062133", ...over,
    },
  });

  it("usa a URL do anúncio, que é a que o ML aceita para o número da amostra", () => {
    expect(enrich.urlDoAnuncio("MLB4922062133")).toBe("https://produto.mercadolivre.com.br/MLB-4922062133");
    expect(enrich.urlDoAnuncio("MLB-4922062133")).toBe("https://produto.mercadolivre.com.br/MLB-4922062133");
    expect(enrich.urlDoAnuncio("lixo")).toBeNull();
  });

  it("grava com a MESMA chave da amostra — e não com a do permalink /up/", () => {
    const amostra = pg.linkSinteticoML("MLB4922062133");
    const p = enrich.produtoDaAmostra("MLB4922062133", lido());
    expect(p.key).toBe(productKey({ link: amostra }));
    expect(p.key).not.toBe(productKey({ link: lido().product.link }));
    expect(p.link).toBe("https://produto.mercadolivre.com.br/MLB-4922062133");
    expect(p.pdpLink).toContain("/up/MLBU");
    expect(p).toMatchObject({ name: "Mini Desumidificador", price: 178.8, store: "Mercado Livre" });
  });

  it("descarta quando a landing trouxe OUTRO anúncio", () => {
    expect(enrich.produtoDaAmostra("MLB4922062133", lido({ mlItemId: "MLB111111111" }))).toBeNull();
  });

  it("descarta quando não dá pra conferir qual anúncio veio", () => {
    expect(enrich.produtoDaAmostra("MLB4922062133", lido({ mlItemId: null }))).toBeNull();
  });

  it("descarta landing que falhou ou veio sem nome/preço", () => {
    expect(enrich.produtoDaAmostra("MLB4922062133", { ok: false, kind: "nao-e-produto" })).toBeNull();
    expect(enrich.produtoDaAmostra("MLB4922062133", lido({ price: null }))).toBeNull();
    expect(enrich.produtoDaAmostra("MLB4922062133", lido({ name: "" }))).toBeNull();
  });
});
