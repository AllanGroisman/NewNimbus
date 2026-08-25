// Link DIRETO de produto do Mercado Livre (/p/MLB…) no "Adicionar link manualmente"
// e no repasse.
//
// Por que existe: em 25/08/2026 a página de produto do ML passou a responder CAPTCHA
// no Chrome headless (com E sem cookie de afiliado) e também por fetch cru. O que
// ainda passa é a landing /social/ — então o link direto vira a landing de afiliado
// do próprio usuário (createLink) e é lida de lá; o catálogo já raspado é a rede de
// segurança. Aqui se testa a ordem e, principalmente, os motivos: cookie vencido e
// link fora do programa NÃO podem chegar na tela como "CAPTCHA, tente mais tarde".
import "../helpers/env.js";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const backend = (...p) => path.resolve(__dirname, "..", "..", "backend", ...p);

const scraper = require(backend("scraping", "scraper.js"));
const affiliate = require(backend("scraping", "affiliate.js"));
const mlSocial = require(backend("scraping", "ml-social.js"));
const catalog = require(backend("catalog", "index.js"));

const LINK = "https://www.mercadolivre.com.br/algum-produto/p/MLB1040287986";
const USER = "user-link-direto";

const produtoDaLanding = {
  name: "Produto da landing",
  link: "https://www.mercadolivre.com.br/algum-produto/p/MLB1040287986",
  finalUrl: "https://www.mercadolivre.com.br/algum-produto/p/MLB1040287986",
  price: 99.9,
  img: "https://http2.mlstatic.com/foto.jpg",
  store: "Mercado Livre",
};

afterEach(() => vi.restoreAllMocks());

describe("mlProductViaAffiliateLanding", () => {
  it("gera a landing do usuário e lê o produto dela", async () => {
    vi.spyOn(affiliate, "criarLinkAfiliadoML").mockResolvedValue({
      shortUrl: "https://meli.la/abc", kind: affiliate.ML_LINK_KIND.OK, reason: null,
    });
    vi.spyOn(mlSocial, "fetchSocialLanding").mockResolvedValue({ ok: true, kind: "ok", product: produtoDaLanding });

    const r = await scraper.mlProductViaAffiliateLanding(LINK, USER);
    expect(r.product).toEqual(produtoDaLanding);
    expect(r.err).toBeNull();
    expect(mlSocial.fetchSocialLanding).toHaveBeenCalledWith("https://meli.la/abc");
  });

  it("cookie vencido vira erro tipado login-wall — não CAPTCHA", async () => {
    vi.spyOn(affiliate, "criarLinkAfiliadoML").mockResolvedValue({
      shortUrl: null,
      kind: affiliate.ML_LINK_KIND.COOKIE,
      reason: "O cookie de afiliado do Mercado Livre venceu — cole um novo em Configurações › Afiliados.",
    });
    const spyFetch = vi.spyOn(mlSocial, "fetchSocialLanding");

    const r = await scraper.mlProductViaAffiliateLanding(LINK, USER);
    expect(r.product).toBeNull();
    expect(r.err.kind).toBe("login-wall");
    expect(r.err.blocked).toBe(true);
    expect(r.err.message).toMatch(/cookie/i);
    expect(spyFetch).not.toHaveBeenCalled();
  });

  it("link fora do programa de afiliados vira nao-e-produto, sem marcar bloqueio", async () => {
    vi.spyOn(affiliate, "criarLinkAfiliadoML").mockResolvedValue({
      shortUrl: null,
      kind: affiliate.ML_LINK_KIND.LINK_RECUSADO,
      reason: "O Mercado Livre não aceita este link no programa de afiliados — use uma URL de produto ou oferta.",
    });

    const r = await scraper.mlProductViaAffiliateLanding(LINK, USER);
    expect(r.err.kind).toBe("nao-e-produto");
    expect(r.err.blocked).toBe(false);
  });

  it("landing gerada caiu em CAPTCHA: sem produto e SEM erro próprio (deixa o navegador tentar)", async () => {
    vi.spyOn(affiliate, "criarLinkAfiliadoML").mockResolvedValue({
      shortUrl: "https://meli.la/abc", kind: affiliate.ML_LINK_KIND.OK, reason: null,
    });
    vi.spyOn(mlSocial, "fetchSocialLanding").mockResolvedValue({
      ok: false, kind: "captcha", reason: "CAPTCHA", product: null,
    });

    const r = await scraper.mlProductViaAffiliateLanding(LINK, USER);
    expect(r.product).toBeNull();
    expect(r.err).toBeNull();
  });

  it("fetch da landing lançando não derruba o caminho: segue sem erro próprio", async () => {
    vi.spyOn(affiliate, "criarLinkAfiliadoML").mockResolvedValue({
      shortUrl: "https://meli.la/abc", kind: affiliate.ML_LINK_KIND.OK, reason: null,
    });
    vi.spyOn(mlSocial, "fetchSocialLanding").mockRejectedValue(new Error("ECONNRESET"));

    const r = await scraper.mlProductViaAffiliateLanding(LINK, USER);
    expect(r).toEqual({ product: null, err: null });
  });
});

describe("mlProductFromCatalog", () => {
  it("devolve o produto no shape do scrape, marcado como vindo do catálogo", async () => {
    vi.spyOn(catalog, "getByLink").mockResolvedValue({
      name: "Do catálogo", link: LINK, price: 50, originalPrice: 80, discount: 37,
      img: "https://http2.mlstatic.com/c.jpg", sold: "10 vendidos", soldCount: 10,
      rating: 4.5, category: "casa", lastSeenAt: "2026-08-25T12:00:00.000Z",
    });

    const p = await scraper.mlProductFromCatalog(LINK);
    expect(p).toMatchObject({
      name: "Do catálogo", link: LINK, finalUrl: LINK, price: 50,
      store: "Mercado Livre", fromCatalog: true, hasPromo: true,
      scrapedAt: "2026-08-25T12:00:00.000Z",
    });
  });

  it("linha sem preço não serve", async () => {
    vi.spyOn(catalog, "getByLink").mockResolvedValue({ name: "Sem preço", link: LINK, price: null });
    expect(await scraper.mlProductFromCatalog(LINK)).toBeNull();
  });

  it("catálogo fora do ar não quebra o scrape", async () => {
    vi.spyOn(catalog, "getByLink").mockRejectedValue(new Error("sem banco"));
    expect(await scraper.mlProductFromCatalog(LINK)).toBeNull();
  });
});
