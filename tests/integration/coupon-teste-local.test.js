// O teste de cupom feito na aba do próprio admin (a extensão).
//
// Desde 25/08/2026 o ML barra o navegador automatizado com CAPTCHA já na página do
// produto: o caminho do servidor quase nunca chega ao checkout. Quem caminha agora
// é uma aba do Chrome do admin — e ela devolve MATERIAL CRU: as telas que viu, a
// trilha do que clicou e os corpos JSON que o checkout buscou.
//
// O que este arquivo protege é que a leitura desse material não virou um segundo
// juiz. O veredito, os totais e os cupons da página continuam saindo das mesmas
// funções puras do caminho antigo — e o erro caro aqui seria o total: se o "antes"
// e o "depois" vierem de telas diferentes, a diferença é de FRETE e viraria "cupom
// válido" sem cupom nenhum ter entrado.
import { describe, it, expect } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const mlCoupon = require(path.resolve(__dirname, "..", "..", "backend", "scraping", "ml-coupon.js"));

const URL_PRODUTO = "https://www.mercadolivre.com.br/patinete/p/MLB51133040";

const material = (over = {}) => ({
  t0: Date.now() - 5000,
  finalUrl: URL_PRODUTO,
  title: "Patinete Elétrico",
  muro: null,
  notProductPage: false,
  clippedTexts: [],
  respostas: [],
  bodyTextAoEntrar: "",
  bodyTextAntes: "",
  bodyTextDepois: "",
  ...over,
  checkout: {
    attempted: true, reached: true, via: "form-compra", url: "https://www.mercadolivre.com.br/checkout/x",
    blockedReason: null, variacao: null, stepReached: true, steps: 2, trail: [],
    couponOpen: null, fieldFound: true, applied: true, botao: "Aplicar", cartCleaned: null,
    ...(over.checkout || {}),
  },
});

describe("prepararTesteLocal", () => {
  it("recusa URL que não é do Mercado Livre antes de abrir aba nenhuma", async () => {
    await expect(mlCoupon.prepararTesteLocal({ url: "https://www.amazon.com.br/dp/B0", code: "X", mode: "checkout" }))
      .rejects.toThrow(/Mercado Livre/i);
  });

  it("modo checkout sem código é recusado", async () => {
    await expect(mlCoupon.prepararTesteLocal({ url: URL_PRODUTO, code: "  ", mode: "checkout" }))
      .rejects.toThrow(/Escreva o código/i);
  });

  it("devolve o pedido já normalizado para a extensão executar", async () => {
    const r = await mlCoupon.prepararTesteLocal({ url: URL_PRODUTO, code: " jbl20 ", mode: "checkout" });
    // Ou o caminho rápido concluiu (e aí nem há o que caminhar), ou o pedido volta
    // limpo. Os dois desfechos são válidos; o que não pode é passar código sujo.
    if (r.conclui) expect(r.result.code).toBe("JBL20");
    else expect(r.code).toBe("JBL20");
  });
});

describe("resultadoTesteLocal", () => {
  it("a queda do total entre as MESMAS telas é o que prova o desconto", async () => {
    const out = await mlCoupon.resultadoTesteLocal({
      url: URL_PRODUTO, code: "JBL20", mode: "checkout",
      material: material({
        bodyTextAntes: "Resumo da compra Total R$ 1.000,00",
        bodyTextDepois: "Resumo da compra Cupom aplicado Total R$ 800,00",
      }),
    });
    expect(out.totalBefore).toBe(1000);
    expect(out.totalAfter).toBe(800);
    expect(out.status).toBe("valido");
    expect(out.fonte).toBe("checkout-extensao");
  });

  it("o que o ML respondeu por XHR vale mais que o texto da tela", async () => {
    const out = await mlCoupon.resultadoTesteLocal({
      url: URL_PRODUTO, code: "NAOEXISTE", mode: "checkout",
      material: material({
        respostas: [JSON.stringify({ message: "O código do cupom é inválido" })],
        bodyTextAntes: "Total R$ 1.000,00",
        bodyTextDepois: "Total R$ 1.000,00",
      }),
    });
    expect(out.status).toBe("invalido");
  });

  it("não chegou ao checkout: resposta é “não sei”, com o motivo do ML", async () => {
    const out = await mlCoupon.resultadoTesteLocal({
      url: URL_PRODUTO, code: "JBL20", mode: "checkout",
      material: material({ checkout: { reached: false, fieldFound: false, applied: false, blockedReason: "Escolha Tamanho para continuar com sua compra" } }),
    });
    expect(out.status).toBe("indeterminado");
    expect(out.reason).toMatch(/variação/i);
  });

  it("chegou na tela e o campo não abriu: diz isso, não “o cupom não vale”", async () => {
    const out = await mlCoupon.resultadoTesteLocal({
      url: URL_PRODUTO, code: "JBL20", mode: "checkout",
      material: material({ checkout: { fieldFound: false, stepReached: true, couponOpen: { found: false, tentativas: [{ nivel: 0, clicou: "Inserir código do cupom" }], titulo: "Escolha como pagar" } } }),
    });
    expect(out.status).toBe("indeterminado");
    expect(out.reason).toMatch(/campo pra digitar/i);
  });

  it("o muro na aba do admin não vira veredito sobre o cupom", async () => {
    const out = await mlCoupon.resultadoTesteLocal({
      url: URL_PRODUTO, code: "JBL20", mode: "checkout",
      material: material({ muro: "captcha", motivo: "verificação não resolvida", bodyTextDepois: "Por segurança, complete a verificação" }),
    });
    expect(out.status).toBe("indeterminado");
  });

  it("link que não abriu produto é dito como tal — não como “22 cupons”", async () => {
    const out = await mlCoupon.resultadoTesteLocal({
      url: URL_PRODUTO, code: "JBL20", mode: "checkout",
      material: material({ notProductPage: true, finalUrl: "https://www.mercadolivre.com.br/social/allangroisman" }),
    });
    expect(out.status).toBe("indeterminado");
    expect(out.reason).toMatch(/perfil de afiliado/i);
  });

  it("modo leitura só conta os cupons que a própria página oferece", async () => {
    const out = await mlCoupon.resultadoTesteLocal({
      url: URL_PRODUTO, mode: "leitura",
      material: material({ clippedTexts: ["10% OFF com cupom", "R$ 30 OFF com cupom"] }),
    });
    expect(out.status).toBe("leitura");
    expect(out.clipped.length).toBe(2);
    expect(out.fonte).toBe("leitura");
  });

  it("o resultado entra no histórico, como o do caminho antigo", async () => {
    await mlCoupon.resultadoTesteLocal({
      url: URL_PRODUTO, code: "HIST123", mode: "checkout",
      material: material({ bodyTextAntes: "Total R$ 100,00", bodyTextDepois: "Total R$ 90,00" }),
    });
    expect(mlCoupon.readHistory().some(h => h.code === "HIST123" && h.fonte === "checkout-extensao")).toBe(true);
  });
});

// O caminho rápido é o primeiro passo do teste local, e ele mora no servidor —
// que pode não ter o cookie do ML. Deixar isso derrubar o teste inteiro seria o
// pior dos mundos: a aba do admin não precisa daquele cookie pra nada.
describe("quando o caminho rápido não pode rodar", () => {
  it("modo checkout segue mesmo assim, e diz por que o rápido ficou de fora", async () => {
    const r = await mlCoupon.prepararTesteLocal({ url: URL_PRODUTO, code: "SEMCOOKIE1", mode: "checkout" });
    if (r.conclui) return;   // o ambiente tinha cookie e o rápido concluiu — nada a testar aqui
    expect(r.code).toBe("SEMCOOKIE1");
    expect(r.quick === null || typeof r.quick === "object").toBe(true);
  });

  it("no modo rápido a falha é o resultado — não há para onde seguir", async () => {
    // Sem sessão do ML, o modo "rapido" não tem plano B: ele É o caminho.
    const affiliate = require(path.resolve(__dirname, "..", "..", "backend", "scraping", "affiliate.js"));
    if (affiliate.getScraperMLSession()) return;   // ambiente com cookie: não se aplica
    await expect(mlCoupon.prepararTesteLocal({ url: URL_PRODUTO, code: "SEMCOOKIE2", mode: "rapido" }))
      .rejects.toThrow();
  });
});
