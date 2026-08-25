// POST /api/scraper/fetch-url — o "Buscar dados" do Adicionar link manualmente.
//
// O caso que motivou: no Mercado Livre a página de produto responde CAPTCHA (no
// navegador COM e SEM cookie, e por fetch cru), então o link direto passa a ser
// lido pela landing de afiliado do próprio usuário, com o catálogo já raspado
// como rede de segurança. O que este arquivo protege é o CONTRATO da resposta:
// produto quando dá, e motivo TIPADO quando não dá — cookie vencido não pode
// chegar na tela como "CAPTCHA, tente daqui a pouco".
import { describe, it, expect, vi, afterEach } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { request, app, createTestUser, catalog, affiliate } from "../helpers/app.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const backend = (...p) => path.resolve(__dirname, "..", "..", "backend", ...p);
const mlSocial = require(backend("scraping", "ml-social.js"));

const LINK = "https://www.mercadolivre.com.br/produto-teste/p/MLB7770001";

async function userComAfiliado() {
  const { user, auth } = await createTestUser({ plan: "pro" });
  affiliate.writeConfig(user.id, { tag: "tag-teste", cookie: "c-sessid" });
  return { user, auth };
}

afterEach(() => vi.restoreAllMocks());

describe("POST /api/scraper/fetch-url", () => {
  it("link direto do ML: lê o produto pela landing de afiliado gerada", async () => {
    const { auth } = await userComAfiliado();
    vi.spyOn(affiliate, "criarLinkAfiliadoML").mockResolvedValue({
      shortUrl: "https://meli.la/xyz", kind: affiliate.ML_LINK_KIND.OK, reason: null,
    });
    vi.spyOn(mlSocial, "fetchSocialLanding").mockResolvedValue({
      ok: true,
      kind: "ok",
      product: { name: "Produto da landing", link: LINK, finalUrl: LINK, price: 199.9, img: "https://http2.mlstatic.com/f.jpg", store: "Mercado Livre" },
    });

    const res = await auth("post", "/api/scraper/fetch-url").send({ url: LINK });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: "Produto da landing", price: 199.9, link: LINK });
    expect(res.body.fromCatalog).toBeUndefined();
  });

  it("landing não resolveu, mas o produto está no catálogo: devolve marcado como fromCatalog", async () => {
    const { auth } = await userComAfiliado();
    await catalog.upsertProducts([
      { name: "Produto do catálogo", link: LINK, store: "Mercado Livre", category: "casa", price: 149, discount: 20, img: "https://http2.mlstatic.com/c.jpg" },
    ]);
    vi.spyOn(affiliate, "criarLinkAfiliadoML").mockResolvedValue({
      shortUrl: "https://meli.la/xyz", kind: affiliate.ML_LINK_KIND.OK, reason: null,
    });
    vi.spyOn(mlSocial, "fetchSocialLanding").mockResolvedValue({
      ok: false, kind: "captcha", reason: "CAPTCHA", product: null,
    });

    const res = await auth("post", "/api/scraper/fetch-url").send({ url: LINK });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: "Produto do catálogo", price: 149, fromCatalog: true });
    expect(res.body.scrapedAt).toBeTruthy();
  });

  it("cookie vencido: 400 com code login-wall e mensagem que pede ação", async () => {
    const { auth } = await userComAfiliado();
    vi.spyOn(affiliate, "criarLinkAfiliadoML").mockResolvedValue({
      shortUrl: null,
      kind: affiliate.ML_LINK_KIND.COOKIE,
      reason: "O cookie de afiliado do Mercado Livre venceu — cole um novo em Configurações › Afiliados.",
    });

    const res = await auth("post", "/api/scraper/fetch-url").send({ url: "https://www.mercadolivre.com.br/outro/p/MLB7770002" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("login-wall");
    expect(res.body.error).toMatch(/cookie/i);
    expect(res.body.error).not.toMatch(/CAPTCHA/i);
  });

  it("URL vazia continua sendo 400 de validação", async () => {
    const { auth } = await userComAfiliado();
    const res = await auth("post", "/api/scraper/fetch-url").send({ url: "  " });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/URL/i);
  });

  it("exige autenticação", async () => {
    const res = await request(app).post("/api/scraper/fetch-url").send({ url: LINK });
    expect(res.status).toBe(401);
  });
});
