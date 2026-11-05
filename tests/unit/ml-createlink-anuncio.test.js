// Link de catálogo do ML com o vendedor fixado (/p/MLB…?pdp_filters=item_id:…).
//
// Por que existe: em 05/11/2026 um repasse saiu com o preço de um vendedor e o link
// caindo noutro, mais caro. A API createLink IGNORA a query: pelo /p/ ela devolve o
// link do catálogo, que abre o vendedor "ganhador". Pela URL do ANÚNCIO ela gera a
// landing com o vendedor certo. Se o anúncio for recusado, vale o catálogo.
import "../helpers/env.js";
import { describe, it, expect, afterEach, vi } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const affiliate = require(path.resolve(__dirname, "..", "..", "backend", "scraping", "affiliate.js"));

const CAT = "https://www.mercadolivre.com.br/booster-box/p/MLB69246167";
const FIXO = `${CAT}?pdp_filters=item_id%3AMLB7253500418#wid=MLB7253500418`;
const ANUNCIO = "https://produto.mercadolivre.com.br/MLB-7253500418";

describe("urlDoAnuncioML", () => {
  it("catálogo com vendedor fixado vira a URL do anúncio", () => {
    expect(affiliate.urlDoAnuncioML(FIXO)).toBe(ANUNCIO);
    expect(affiliate.urlDoAnuncioML(`${CAT}?matt_x=1#reco=y&wid=MLB7253500418`)).toBe(ANUNCIO);
  });

  it("catálogo sem vendedor e link de anúncio ficam como vieram", () => {
    expect(affiliate.urlDoAnuncioML(CAT)).toBeNull();
    expect(affiliate.urlDoAnuncioML("https://produto.mercadolivre.com.br/MLB-5344494748-talheres-_JM")).toBeNull();
    expect(affiliate.urlDoAnuncioML("https://shopee.com.br/product/1/2")).toBeNull();
  });
});

describe("postCreateLink com vendedor fixado", () => {
  afterEach(() => vi.unstubAllGlobals());

  const respostas = (porUrl) => {
    const pedidas = [];
    vi.stubGlobal("fetch", vi.fn(async (_u, init) => {
      const url = JSON.parse(init.body).urls[0];
      pedidas.push(url);
      const short = porUrl[url] ?? null;
      return { ok: true, status: 200, json: async () => ({ urls: [short ? { short_url: short } : { message: "invalid" }] }) };
    }));
    return pedidas;
  };

  it("pede pela URL do anúncio", async () => {
    const pedidas = respostas({ [ANUNCIO]: "https://meli.la/certo" });
    const r = await affiliate.postCreateLink({ cookie: "c", tag: "t", url: FIXO });
    expect(r.shortUrl).toBe("https://meli.la/certo");
    expect(pedidas).toEqual([ANUNCIO]);
  });

  it("anúncio recusado: cai no link de catálogo em vez de perder o envio", async () => {
    const pedidas = respostas({ [FIXO]: "https://meli.la/geral" });
    const r = await affiliate.postCreateLink({ cookie: "c", tag: "t", url: FIXO });
    expect(r.shortUrl).toBe("https://meli.la/geral");
    expect(pedidas).toEqual([ANUNCIO, FIXO]);
  });

  it("link sem vendedor faz uma chamada só, com a URL original", async () => {
    const pedidas = respostas({ [CAT]: "https://meli.la/geral" });
    await affiliate.postCreateLink({ cookie: "c", tag: "t", url: CAT });
    expect(pedidas).toEqual([CAT]);
  });
});
