// "Quais cupons valem neste produto?" pelo lado do produto (coupons/product-coupons.js),
// com banco de verdade — e a sonda do checkout, que só guarda o que a extensão viu.
//
// O que protege:
//   - o link do produto acha o cupom mesmo quando o vínculo foi gravado por outra
//     numeração (/up/MLBU com `pdp_filters`, anúncio × catálogo);
//   - cada cupom diz DE ONDE veio (prévia, amostra, vitrine) — não são a mesma garantia;
//   - cupom vencido não aparece;
//   - "não vale neste preço" (compra mínima) não vira desconto inventado;
//   - a sonda grava os arquivos e não interpreta nada.

import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { catalog } from "../helpers/app.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const backendDir = path.resolve(__dirname, "..", "..", "backend");
const coupons = require(path.join(backendDir, "coupons"));
const pc = require(path.join(backendDir, "coupons", "product-coupons.js"));
const { prisma } = require(path.join(backendDir, "db.js"));

const AMANHA = () => new Date(Date.now() + 864e5);
const LINK = "https://www.mercadolivre.com.br/fone-bluetooth/p/MLB22222222";

async function cupom(campaignId, over = {}) {
  return prisma().mlCoupon.create({
    data: { campaignId, title: `Cupom ${campaignId}`, kind: "percent", value: 10, scope: "campaign", expiresAt: AMANHA(), ...over },
  });
}

beforeEach(async () => {
  await catalog.upsertProducts([{ name: "Fone Bluetooth", price: 200, link: LINK, store: "Mercado Livre" }]);
});

describe("paraProduto", () => {
  it("lista os cupons do produto com a origem de cada vínculo e o preço com cupom", async () => {
    await cupom("A", { value: 10 });
    await cupom("B", { value: 25 });
    await coupons.replaceCouponProducts("A", [{ productKey: pcKey(LINK), productUrl: LINK }], { origem: "landing" });
    await coupons.replaceCouponSamples("B", ["MLB22222222"]);

    const r = await pc.paraProduto({ url: LINK });

    expect(r.produto).toMatchObject({ name: "Fone Bluetooth", price: 200 });
    // Ordenado pela maior economia neste preço.
    expect(r.cupons.map(c => [c.campaignId, c.origem, c.priceWithCoupon])).toEqual([
      ["B", "amostra", 150],
      ["A", "landing", 180],
    ]);
    expect(r.cupons[0].origemRotulo).toMatch(/miniatura/);
    expect(r.semVinculo).toBe(false);
  });

  it("acha pelo link /up/ com o anúncio na query — a numeração que o afiliado compartilha", async () => {
    await cupom("A");
    await coupons.replaceCouponSamples("A", ["MLB33333333"]);
    const r = await pc.paraProduto({ url: "https://www.mercadolivre.com.br/x/up/MLBU999?pdp_filters=item_id:MLB33333333" });
    expect(r.cupons.map(c => c.campaignId)).toEqual(["A"]);
  });

  it("cupom vencido não aparece", async () => {
    await cupom("VELHO", { expiresAt: new Date(Date.now() - 864e5) });
    await coupons.replaceCouponSamples("VELHO", ["MLB22222222"]);
    const r = await pc.paraProduto({ url: LINK });
    expect(r.cupons).toEqual([]);
    expect(r.semVinculo).toBe(true);
  });

  it("compra mínima não atingida: mostra o cupom, sem prometer desconto", async () => {
    await cupom("MIN", { minPurchase: 500 });
    await coupons.replaceCouponSamples("MIN", ["MLB22222222"]);
    const r = await pc.paraProduto({ url: LINK });
    expect(r.cupons[0]).toMatchObject({ campaignId: "MIN", priceWithCoupon: null, economia: null });
  });

  it("o mesmo cupom por duas chaves fica com a origem mais forte", () => {
    const r = pc.montarResposta([
      { campaignId: "A", origem: "amostra", kind: "percent", value: 10 },
      { campaignId: "A", origem: "vitrine", kind: "percent", value: 10 },
    ], { price: 100 });
    expect(r.cupons).toHaveLength(1);
    expect(r.cupons[0].origem).toBe("vitrine");
  });

  it("link que não é produto dá erro claro", async () => {
    await expect(pc.paraProduto({ url: "" })).rejects.toThrow(/produto/);
  });
});

describe("gravarSonda", () => {
  it("guarda a captura em arquivos e devolve o resumo", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sonda-"));
    const material = {
      checkout: { reached: true, steps: 3, via: "form-compra" },
      clippedTexts: ["10% OFF com cupom"],
      capturaAoEntrar: { texto: "Resumo da compra", respostas: [] },
      capturaDosCupons: { texto: "Cupons disponíveis 15% OFF", html: "<html>cupons</html>", respostas: ["{\"coupons\":[]}"] },
    };

    const r = await pc.gravarSonda({ url: LINK, material, dir });

    expect(r.resumo).toMatchObject({ chegouNoCheckout: true, chegouNosCupons: true, passos: 3, respostasDeApi: 1, carrinhoLimpo: null });
    const arquivos = fs.readdirSync(r.pasta).sort();
    expect(arquivos).toEqual(["ao-entrar-respostas.json", "ao-entrar.txt", "cupons-respostas.json", "cupons.html", "cupons.txt", "leitura.json", "material.json", "resumo.json"]);
    expect(fs.readFileSync(path.join(r.pasta, "cupons.html"), "utf8")).toBe("<html>cupons</html>");
    // O HTML não vai duplicado no material.json.
    expect(fs.readFileSync(path.join(r.pasta, "material.json"), "utf8")).not.toContain("<html>");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("avisa quando o carrinho pode ter ficado sujo", () => {
    expect(pc.resumoDaSonda({ checkout: { via: "carrinho", cartCleaned: false } }).carrinhoLimpo).toBe(false);
  });

  it("lê o cupom que o ML aplicou sozinho no checkout de página única (captura real, 19/09)", () => {
    const texto = fs.readFileSync(path.resolve(__dirname, "..", "fixtures", "ml-checkout-onestep.txt"), "utf8");
    expect(pc.cupomNoResumo(texto)).toEqual({ emUso: 1, disponiveis: 1, desconto: 10.59 });
    expect(pc.resumoDaSonda({ capturaAoEntrar: { texto }, checkout: { reached: true, trail: [{ parou: "sem-botao-continuar" }] } }))
      .toMatchObject({ cupomAplicado: { desconto: 10.59 }, chegouNosCupons: false, motivo: expect.stringMatching(/página única/) });
  });

  it("checkout sem a linha de cupons não inventa desconto", () => {
    expect(pc.cupomNoResumo("Resumo da compra Produto R$ 100,00 Total R$ 100,00")).toBeNull();
    expect(pc.cupomNoResumo("Cupons (0/2 em uso)")).toEqual({ emUso: 0, disponiveis: 2, desconto: null });
  });

  it("mascara CPF, final de cartão e CEP antes de gravar", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sonda-"));
    const r = await pc.gravarSonda({ url: LINK, dir, material: {
      capturaAoEntrar: { texto: "Fulano - CPF 039.973.200-47 · Nubank terminado em 8481 · CEP 91530034" },
    } });
    const txt = fs.readFileSync(path.join(r.pasta, "ao-entrar.txt"), "utf8");
    expect(txt).not.toMatch(/039\.973|8481|91530034/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("guarda o conteúdo do iframe do popup (/cupons/cho) e diz se deu pra ler", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sonda-"));
    const r = await pc.gravarSonda({ url: LINK, dir, material: {
      checkout: { reached: true, seguro: { como: "recusou", clicou: "Agora não", rotulos: ["Agora não"] } },
      capturaDosCupons: { popupAberto: true, texto: "", iframes: [
        { src: "https://www.mercadolivre.com.br/cupons/cho?context_id=X", legivel: true, texto: "Cupons ativos 10% OFF em uso", html: "<body>lista</body>" },
      ] },
    } });
    expect(r.resumo).toMatchObject({ abriuPopup: true, leuIframe: true, seguro: { como: "recusou", rotulos: null } });
    expect(fs.readFileSync(path.join(r.pasta, "cupons-iframe-0.txt"), "utf8")).toContain("/cupons/cho");
    expect(fs.readFileSync(path.join(r.pasta, "cupons-iframe-0.html"), "utf8")).toBe("<body>lista</body>");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("quando não sai da oferta de seguro, o resumo traz os botões que a tela tinha", () => {
    const r = pc.resumoDaSonda({ checkout: { reached: false, seguro: { como: null, rotulos: ["Adicionar", "Voltar"], voltouProSeguro: false } } });
    expect(r.seguro).toEqual({ como: null, clicou: null, voltouProSeguro: false, rotulos: ["Adicionar", "Voltar"] });
  });

  it("guarda a página onde parou antes do checkout (parada.html), mascarada", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sonda-"));
    const seguro = "https://www.mercadolivre.com.br/protections/hub/attach?x=1";
    const r = await pc.gravarSonda({ url: LINK, dir, material: {
      checkout: { reached: false, url: seguro },
      capturaNaParada: { url: seguro, texto: "Proteja seu produto AGORA NÃO · CPF 039.973.200-47", html: "<button>AGORA NÃO</button>" },
    } });
    expect(r.resumo.paradaEm).toBe(seguro);
    expect(fs.readFileSync(path.join(r.pasta, "parada.html"), "utf8")).toBe("<button>AGORA NÃO</button>");
    expect(fs.readFileSync(path.join(r.pasta, "parada.txt"), "utf8")).not.toContain("039.973");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("o que o checkout aplicou vira vínculo `checkout` — e o cupom novo é criado", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sonda-"));
    const iframe = fs.readFileSync(path.resolve(__dirname, "..", "fixtures", "ml-checkout-cupons-iframe.html"), "utf8");
    const r = await pc.gravarSonda({ url: LINK, dir, material: {
      checkout: { reached: true },
      capturaDosCupons: { popupAberto: true, iframes: [{ legivel: true, texto: "Cupons do Mercado Livre Itens para Casa", html: iframe }] },
    } });

    expect(r.resumo.checkout).toMatchObject({ ok: true, economia: 20, valem: ["14167118"], gravado: { cuponsNovos: 1 } });
    const c = await coupons.getCoupon("14167118");
    expect(c).toMatchObject({ title: "25% OFF em Itens para Casa", kind: "percent", value: 25, minPurchase: 25, maxDiscount: 20, origin: "checkout" });

    const p = await pc.paraProduto({ url: LINK });
    expect(p.cupons[0]).toMatchObject({ campaignId: "14167118", origem: "checkout" });
    // O produto (R$ 200) entra carimbado: 25% de 200 = 50, mas o teto é 20.
    expect(p.cupons[0]).toMatchObject({ priceWithCoupon: 180, economia: 20 });
    const prod = await prisma().catalogProduct.findFirst({ where: { link: LINK } });
    expect(prod.couponCampaignId).toBe("14167118");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("o checkout não rebaixa vínculo de vitrine, e não reescreve cupom que já existia", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sonda-"));
    await cupom("14167118", { title: "Título da aba", containerUrl: "https://lista.mercadolivre.com.br/_Container_x?coupon_campaign_id=14167118" });
    await coupons.replaceCouponProducts("14167118", [{ productKey: pcKey(LINK), productUrl: LINK }], { origem: "vitrine" });
    const iframe = fs.readFileSync(path.resolve(__dirname, "..", "fixtures", "ml-checkout-cupons-iframe.html"), "utf8");

    const r = await pc.gravarSonda({ url: LINK, dir, material: {
      checkout: { reached: true },
      capturaDosCupons: { iframes: [{ legivel: true, html: iframe }] },
    } });

    expect(r.resumo.checkout.gravado.cuponsNovos).toBe(0);
    const c = await coupons.getCoupon("14167118");
    expect(c.title).toBe("Título da aba");
    expect(c.containerUrl).toContain("_Container_");
    const v = await prisma().mlCouponProduct.findUnique({ where: { campaignId_productKey: { campaignId: "14167118", productKey: pcKey(LINK) } } });
    expect(v.origem).toBe("vitrine");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("sem o popup abrir, a página de cupons buscada direto responde igual", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sonda-"));
    const iframe = fs.readFileSync(path.resolve(__dirname, "..", "fixtures", "ml-checkout-cupons-iframe.html"), "utf8");
    // O caso do produto SEM cupom em uso: a linha do resumo diz "Inserir código do
    // cupom", o clique não monta popup nenhum e a caminhada para — mas a extensão
    // já tinha buscado `/cupons/cho` sozinha.
    const r = await pc.gravarSonda({ url: LINK, dir, material: {
      checkout: { reached: true, trail: [{ parou: "cupom-nao-abriu" }] },
      paginaDosCupons: { ok: true, status: 200, endereco: "https://www.mercadolivre.com.br/cupons/cho?context_id=ABC", html: iframe },
    } });

    expect(r.resumo).toMatchObject({ leuPaginaDosCupons: true, chegouNosCupons: false, motivo: null });
    expect(r.resumo.checkout).toMatchObject({ ok: true, valem: ["14167118"] });
    expect(fs.readFileSync(path.join(r.pasta, "pagina-cupons.html"), "utf8")).toContain("14167118");
    // O HTML não volta no material.json (ele já está no arquivo ao lado).
    expect(JSON.parse(fs.readFileSync(path.join(r.pasta, "material.json"), "utf8")).paginaDosCupons)
      .toMatchObject({ ok: true, status: 200 });
    const p2 = await pc.paraProduto({ url: LINK });
    expect(p2.cupons[0]).toMatchObject({ campaignId: "14167118", origem: "checkout" });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("popup que não abriu e busca que falhou: a sonda diz por que parou", () => {
    const r = pc.resumoDaSonda({ checkout: { reached: true, trail: [{ parou: "cupom-nao-abriu" }] }, paginaDosCupons: { ok: false, erro: "Failed to fetch" } });
    expect(r).toMatchObject({ leuPaginaDosCupons: false, motivo: "clicou na linha do cupom e o popup não abriu" });
  });

  it("sem o HTML do popup, nada é gravado", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sonda-"));
    const r = await pc.gravarSonda({ url: LINK, dir, material: { checkout: { reached: true }, capturaDosCupons: { iframes: [{ legivel: false, html: "" }] } } });
    expect(r.resumo.checkout).toMatchObject({ ok: false, gravado: null });
    expect(await prisma().mlCouponProduct.count()).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("recusa material vazio", async () => {
    await expect(pc.gravarSonda({ url: LINK, material: null })).rejects.toThrow();
  });
});

function pcKey(link) {
  return require(path.join(backendDir, "catalog", "product-key.js")).productKey({ link });
}
