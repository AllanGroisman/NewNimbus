// O comando `cupom-no-checkout` da extensão (extension/cupom-checkout.js), task 7.
//
// Duas partes:
//   - `naPagina_modalCupons` contra um DOM de verdade (happy-dom, o do frontend), com o modal DENTRO
//     de `iframe#bf_coupons_iframe` — foi exatamente por procurar o campo no
//     documento de cima que o caminho antigo nunca achava nada;
//   - o laço do comando, com `aba.js` mockado: a ordem produto → checkout → modal →
//     digitar → inserir → ler → fechar, e os freios (sem carrinho, aba fechada).

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { createRequire } from "module";

// O pacote de testes não tem DOM; o frontend tem. A função roda "dentro da página",
// então ela lê os globais `document`/`window`/`location` — é isso que se instala.
const requireDoFront = createRequire(new URL("../../frontend/package.json", import.meta.url));
const { Window } = requireDoFront("happy-dom");
const janela = new Window({ url: "https://www.mercadolivre.com.br/checkout/review/onestep" });
const GLOBAIS = { window: janela, document: janela.document, location: janela.location, KeyboardEvent: janela.KeyboardEvent };
const antes = Object.fromEntries(Object.keys(GLOBAIS).map(k => [k, globalThis[k]]));
Object.assign(globalThis, GLOBAIS);
afterAll(() => { Object.assign(globalThis, antes); janela.happyDOM?.close?.(); });

const aba = {
  sleep: vi.fn(async () => {}),
  abrir: vi.fn(async () => 7),
  irPara: vi.fn(async () => {}),
  fechar: vi.fn(async () => {}),
  avaliar: vi.fn(),
  esperarHumano: vi.fn(async () => false),
  classificarMuro: vi.fn(() => null),
  injetarArquivo: vi.fn(),
};
vi.mock("../../extension/aba.js", () => aba);

const { naPagina_modalCupons, naPagina_variacoes, naPagina_linkDosCupons, naPagina_produto, naPagina_faixaDepuracao, cupomNoCheckout } = await import("../../extension/cupom-checkout.js");
const { naPagina_irParaProduto } = await import("../../extension/checkout.js");

// ── o DOM ──────────────────────────────────────────────────────────────────

function montarCheckout({ cartao = null, erro = null } = {}) {
  document.body.innerHTML = `
    <div class="resumo">Resumo da compra <a href="#">Cupons (1/1 em uso)</a></div>
    <div role="dialog" class="andes-modal">
      <button class="andes-modal__close-button" aria-label="Fechar">X</button>
      <iframe id="bf_coupons_iframe"></iframe>
    </div>`;
  const doc = document.getElementById("bf_coupons_iframe").contentDocument;
  doc.body.innerHTML = `
    <div class="andes-form-control ${erro ? "andes-form-control--error" : ""}">
      <input id="inputcode-textfield-inline" placeholder="Insira seu código aqui">
      <button class="andes-button--quiet">Inserir</button>
      ${erro ? `<span class="andes-form-control__message">${erro}</span>` : ""}
    </div>
    <p>Você está economizando R$ 40,48 com 1 cupom</p>
    <section>
      <h3>Cupons do Mercado Livre</h3>
      ${cartao || ""}
      <div class="card"><span>Com OUTRO10</span><span>10% OFF</span><button>Aplicar</button></div>
    </section>`;
  return doc;
}

const CARTAO_APLICADO = `
  <div class="card">
    <svg class="icon-check"></svg>
    <div><span>Com MELIKIDS</span></div>
    <span>15% OFF</span>
    <span>Compra mínima R$ 59 | Limite de R$ 50 | Venc. 27/09/2026</span>
    <span>Está esgotando!</span>
    <button class="andes-button andes-button--disabled" disabled>Aplicado</button>
  </div>`;

describe("naPagina_modalCupons — dentro do iframe", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("sem modal nenhum → não está pronto", () => {
    expect(naPagina_modalCupons("estado", "MELIKIDS")).toMatchObject({ onde: null, pronto: false });
  });

  it("acha o campo e o cartão aplicado do código, dentro do iframe", () => {
    montarCheckout({ cartao: CARTAO_APLICADO });
    const e = naPagina_modalCupons("estado", "melikids");
    expect(e).toMatchObject({ onde: "iframe", pronto: true, campo: true, erroCampo: null });
    expect(e.cartao).toMatchObject({ botao: "Aplicado", desabilitado: true, aplicado: true });
    expect(e.cartao.texto).toMatch(/Compra mínima R\$ 59 \| Limite de R\$ 50 \| Venc\. 27\/09\/2026/);
    expect(e.economia).toMatch(/economizando R\$ 40,48 com 1 cupom/);
  });

  it("não confunde o cartão de outro código", () => {
    montarCheckout();
    expect(naPagina_modalCupons("estado", "MELIKIDS").cartao).toBeNull();
    expect(naPagina_modalCupons("estado", "OUTRO10").cartao).toMatchObject({ botao: "Aplicar", aplicado: false });
  });

  it("\"Aplicado\" com o botão habilitado e sem check não conta como aplicado", () => {
    montarCheckout({ cartao: `<div class="card"><span>Com MELIKIDS</span><button>Aplicado</button></div>` });
    expect(naPagina_modalCupons("estado", "MELIKIDS").cartao.aplicado).toBe(false);
  });

  it("lê o erro do campo", () => {
    montarCheckout({ erro: "O cupom não está mais disponível." });
    expect(naPagina_modalCupons("estado", "X1").erroCampo).toBe("O cupom não está mais disponível.");
  });

  it("tira o rótulo \"Erro\" escondido que o Andes põe antes da mensagem", () => {
    const doc = montarCheckout();
    const ctl = doc.querySelector(".andes-form-control");
    ctl.classList.add("andes-form-control--error");
    ctl.insertAdjacentHTML("beforeend",
      `<span class="andes-form-control__message"><svg class="andes-icon"></svg><span class="andes-visually-hidden">Erro</span>O cupom não está mais disponível.</span>`);
    expect(naPagina_modalCupons("estado", "X1").erroCampo).toBe("O cupom não está mais disponível.");
  });

  it("digita com o setter nativo e eventos de input, dentro do iframe", () => {
    const doc = montarCheckout();
    const campo = doc.getElementById("inputcode-textfield-inline");
    campo.value = "LIXO";
    const valores = [];
    campo.addEventListener("input", () => valores.push(campo.value));
    const mudou = vi.fn();
    campo.addEventListener("change", mudou);

    expect(naPagina_modalCupons("digitar", "melikids")).toEqual({ ok: true, valor: "MELIKIDS" });
    expect(valores[0]).toBe("");            // limpou antes
    expect(valores.at(-1)).toBe("MELIKIDS"); // letra a letra
    expect(valores).toHaveLength(1 + "MELIKIDS".length);
    expect(mudou).toHaveBeenCalledTimes(1);
  });

  it("clica no \"Inserir\" do iframe — e não num botão desabilitado", () => {
    const doc = montarCheckout();
    const botao = Array.from(doc.querySelectorAll("button")).find(b => b.textContent === "Inserir");
    const clique = vi.fn();
    botao.addEventListener("click", clique);
    expect(naPagina_modalCupons("inserir", "X1")).toEqual({ ok: true });
    expect(clique).toHaveBeenCalledTimes(1);

    botao.disabled = true;
    expect(naPagina_modalCupons("inserir", "X1")).toEqual({ ok: false, motivo: "desabilitado" });
  });

  it("fecha no X do modal, na página de cima", () => {
    montarCheckout();
    const x = document.querySelector(".andes-modal__close-button");
    const clique = vi.fn();
    x.addEventListener("click", clique);
    expect(naPagina_modalCupons("fechar", "X1")).toEqual({ ok: true });
    expect(clique).toHaveBeenCalled();
  });
});

// ── as variações e o link dos cupons, na página de cima ─────────────────────

function montarVariacoes() {
  document.body.innerHTML = `
    <div class="ui-pdp-outside_variations__picker">
      <p>Cor: <span>Sortido</span></p>
      <a class="ui-pdp-outside_variations__thumbnails__item ui-pdp-outside_variations__thumbnails__item--SELECTED">Sortido</a>
    </div>
    <div class="ui-pdp-outside_variations__picker">
      <p>Tamanho: <span>Escolha</span></p>
      <a class="ui-pdp-outside_variations__thumbnails__item ui-pdp-outside_variations__thumbnails__item--NONE ui-pdp-outside_variations__thumbnails__item--DISABLED" aria-label="Botón 1 de 3, PP (34)">PP (34)</a>
      <a class="ui-pdp-outside_variations__thumbnails__item ui-pdp-outside_variations__thumbnails__item--NONE" aria-label="Botón 2 de 3, G/GG (40-42)">G/GG (40-42)</a>
      <a class="ui-pdp-outside_variations__thumbnails__item ui-pdp-outside_variations__thumbnails__item--NONE" aria-label="Botón 3 de 3, P/M (36-38)">P/M (36-38)</a>
    </div>`;
}

describe("naPagina_variacoes", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("só lendo: diz o que falta escolher e não clica", () => {
    montarVariacoes();
    const clique = vi.fn();
    document.querySelectorAll("a").forEach(a => a.addEventListener("click", clique));
    const r = naPagina_variacoes(false);
    expect(r.grupos.map(g => g.rotulo)).toEqual(["Cor: Sortido", "Tamanho: Escolha"]);
    expect(r.grupos[0].escolhida).toBe("Sortido");
    expect(r.faltando).toEqual(["Tamanho: Escolha"]);
    expect(clique).not.toHaveBeenCalled();
  });

  it("escolhe a primeira opção disponível do grupo sem escolha — e não mexe no que já está escolhido", () => {
    montarVariacoes();
    const clicados = [];
    document.querySelectorAll("a").forEach(a => a.addEventListener("click", () => clicados.push(a.textContent)));
    const r = naPagina_variacoes(true);
    // A PP está esgotada; a Cor já vinha escolhida.
    expect(clicados).toEqual(["G/GG (40-42)"]);
    expect(r.grupos[1].clicou).toBe("G/GG (40-42)");
    expect(r.faltando).toEqual([]);
  });

  it("lê o balão de \"Escolha … para continuar\"", () => {
    montarVariacoes();
    document.body.insertAdjacentHTML("beforeend", "<div>Escolha Tamanho para continuar com sua compra.</div>");
    expect(naPagina_variacoes(false).alerta).toBe("Escolha Tamanho para continuar com sua compra.");
  });

  it("produto sem variação: nada a fazer", () => {
    document.body.innerHTML = "<h1>Boneca</h1>";
    expect(naPagina_variacoes(true)).toEqual({ grupos: [], faltando: [], alerta: null });
  });
});

describe("naPagina_produto", () => {
  const preco = (cls, frac, cents) => `<span class="andes-money-amount ${cls}"><span class="andes-money-amount__fraction">${frac}</span>${cents ? `<span class="andes-money-amount__cents">${cents}</span>` : ""}</span>`;

  it("lê nome, preço, riscado, % OFF e foto só da caixa do produto principal", () => {
    document.head.innerHTML = `<meta property="og:image" content="https://http2.mlstatic.com/og.jpg">`;
    document.body.innerHTML = `
      <h1 class="ui-pdp-title">  Jogo De Cama King  </h1>
      <figure class="ui-pdp-gallery__figure"><img data-zoom="https://http2.mlstatic.com/zoom.jpg" src="mini.jpg"></figure>
      <div class="ui-pdp-price__main-container">
        ${preco("andes-money-amount--previous", "499", "90")}
        ${preco("", "1.359", "")}
        <span class="andes-money-amount__discount">28% OFF</span>
      </div>
      <div class="carrossel">${preco("", "19", "99")} <span class="andes-money-amount__discount">70% OFF</span></div>
      <span>+1.000 vendidos</span>`;
    expect(naPagina_produto()).toEqual({
      name: "Jogo De Cama King", price: 1359, originalPrice: 499.9, discount: 28,
      img: "https://http2.mlstatic.com/zoom.jpg", sold: "+1.000 vendidos",
    });
  });

  it("sem caixa de preço, cai no JSON-LD", () => {
    document.head.innerHTML = "";
    document.body.innerHTML = `<h1 class="ui-pdp-title">Boneca</h1>
      <script type="application/ld+json">{"offers":{"price":"89.9"}}</script>`;
    expect(naPagina_produto()).toMatchObject({ name: "Boneca", price: 89.9, originalPrice: null, discount: null });
  });
});

describe("naPagina_irParaProduto (landing de afiliado)", () => {
  const fs = createRequire(import.meta.url)("fs");
  const landingReal = fs.readFileSync(new URL("../fixtures/ml-social-landing.html", import.meta.url), "utf8");
  const scriptDoEstado = landingReal.match(/<script[^>]*>(_n\.ctx\.r=[\s\S]*?)<\/script>/)[1];
  const comEstado = (js) => {
    document.body.innerHTML = "<div>Produto compartilhado</div>";
    const s = document.createElement("script");
    s.type = "text/plain";   // só o texto importa; não roda
    s.textContent = js;
    document.body.appendChild(s);
  };

  it("o botão \"Ir para o produto\" que é link: devolve o endereço e não clica", () => {
    document.body.innerHTML = `<a href="https://www.mercadolivre.com.br/controle/p/MLB52371739" target="_blank">Ir para o produto</a>`;
    const clique = vi.fn();
    document.querySelector("a").addEventListener("click", clique);
    expect(naPagina_irParaProduto()).toEqual({ href: "https://www.mercadolivre.com.br/controle/p/MLB52371739", via: "botao" });
    expect(clique).not.toHaveBeenCalled();
  });

  it("botão sem link: clica", () => {
    document.body.innerHTML = "<button>Ir para produto</button>";
    const clique = vi.fn();
    document.querySelector("button").addEventListener("click", clique);
    expect(naPagina_irParaProduto()).toEqual({ clicou: true, via: "botao" });
    expect(clique).toHaveBeenCalledTimes(1);
  });

  it("sem botão: o produto em destaque do estado embutido (landing real), não o do carrossel", () => {
    comEstado(scriptDoEstado);
    const r = naPagina_irParaProduto();
    expect(r.via).toBe("estado");
    expect(r.href).toMatch(/^https:\/\/www\.mercadolivre\.com\.br\/controle-sem-fio-xbox-series-sx-robot-white-branco\/p\/MLB52371739/);
  });

  it("dois produtos em destaque é ambiguidade: null", () => {
    const estado = { appProps: { pageProps: { data: { components: [{ id: "card-featured", recommendation_data: { recommendation_info: {
      polycards: [{ metadata: { url: "www.mercadolivre.com.br/a/p/MLB1" } }, { metadata: { url: "www.mercadolivre.com.br/b/p/MLB2" } }],
    } } }] } } } };
    comEstado(`_n.ctx.r=${JSON.stringify(estado)};_n.ctx.l={}`);
    expect(naPagina_irParaProduto()).toBeNull();
  });
});

describe("naPagina_linkDosCupons", () => {
  it.each([
    ["Cupons (1/1 em uso)", false],
    ["Inserir código do cupom", true],
  ])("acha e clica em \"%s\"", (texto, semCupom) => {
    document.body.innerHTML = `<div>Resumo da compra <span>Frete</span> <a href="#">${texto}</a></div>`;
    const clique = vi.fn();
    document.querySelector("a").addEventListener("click", clique);
    expect(naPagina_linkDosCupons()).toEqual({ texto, semCupom });
    expect(clique).toHaveBeenCalled();
  });

  it("sem o link, null", () => {
    document.body.innerHTML = "<div>Resumo da compra</div>";
    expect(naPagina_linkDosCupons()).toBeNull();
  });
});

// ── o comando ──────────────────────────────────────────────────────────────

const PDP = "https://www.mercadolivre.com.br/boneca/p/MLB123456";
const LANDING = "https://www.mercadolivre.com.br/social/fulano?matt_word=fulano&ref=abc";
const CHECKOUT = "https://www.mercadolivre.com.br/checkout/review/onestep";

// Um ML de mentira, respondendo por nome da função injetada.
// `variacao`: null (sem variação) | "ok" (escolher resolve) | "presa" (nunca sai).
// `link`: o texto do link dos cupons no resumo. `aplicadoAntes`: o cartão já vem
// aplicado ao abrir o modal.
// `nomeDiferente`: o ML aplica o cupom mas o cartão vem com o nome da campanha,
// sem "Com <CÓDIGO>" (SITE250930).
function mlDeMentira({ modalAbre = true, resposta = "aplicado", variacao = null, link = "Cupons (1/1 em uso)", aplicadoAntes = false, landing = null, nomeDiferente = false } = {}) {
  const st = { url: landing ? LANDING : PDP, modal: false, digitou: false, inseriu: false, fechou: false, cliques: [], tamanho: null, tentouComprar: false, cliquesVariacao: 0, fotoDepoisDeFechar: false };
  aba.irPara.mockImplementation(async (_tab, url) => { st.url = url; });
  aba.avaliar.mockImplementation(async (_tab, func, args) => {
    switch (func.name) {
      case "naPagina_espiao": return true;
      case "naPagina_irParaProduto": return landing === "botao" ? { href: PDP, via: "botao" } : null;
      case "naPagina_foto":
        if (st.fechou) st.fotoDepoisDeFechar = true;
        return {
        url: st.url, titulo: "", tituloDaAba: "",
        texto: st.url === CHECKOUT ? "Finalize sua compra Resumo da compra Cupons (1/1 em uso) - R$ 40,48 Você pagará R$ 229,42" : "Boneca Comprar agora",
        digital: st.url, respostas: [],
      };
      case "naPagina_formDeCompra": return null;
      case "naPagina_clicarPorTexto":
        st.cliques.push(args[0]);
        if (/comprar agora/.test(args[0])) {
          if (variacao && !st.tamanho) { st.tentouComprar = true; return "Comprar agora"; }   // fica na PDP
          st.url = CHECKOUT;
          return "Comprar agora";
        }
        return null;
      case "naPagina_variacoes": {
        if (!variacao) return { grupos: [], faltando: [], alerta: null };
        const [clicar] = args;
        let clicou = null;
        if (clicar && !st.tamanho) {
          st.cliquesVariacao += 1;
          clicou = "P/M (36-38)";
          if (variacao === "ok") st.tamanho = clicou;
        }
        const rotulo = st.tamanho ? `Tamanho: ${st.tamanho}` : "Tamanho: Escolha";
        return {
          grupos: [{ rotulo, escolhida: st.tamanho, clicou, opcoes: 2 }],
          faltando: !st.tamanho && !clicou ? ["Tamanho: Escolha"] : [],
          alerta: !st.tamanho && st.tentouComprar ? "Escolha Tamanho para continuar com sua compra." : null,
        };
      }
      case "naPagina_linkDosCupons":
        if (!link) return null;
        if (modalAbre) st.modal = true;
        return { texto: link, semCupom: /^inserir/i.test(link) };
      case "naPagina_paginaDosCupons": return "https://www.mercadolivre.com.br/cupons/cho?context_id=abc";
      case "naPagina_clicarLinhaDoCupom":
        if (modalAbre) st.modal = true;
        return { texto: "Cupons (1/1 em uso)", tag: "a" };
      case "naPagina_buscarPagina": return { ok: true, html: "<html>modelo</html>" };
      case "naPagina_modalCupons": {
        const [acao] = args;
        if (acao === "digitar") { st.digitou = true; return { ok: true, valor: args[1] }; }
        if (acao === "inserir") { st.inseriu = true; return { ok: true }; }
        if (acao === "fechar") { st.fechou = true; return { ok: true }; }
        if (!st.modal) return { onde: null, pronto: false };
        const depois = st.inseriu;
        const aplicou = depois && resposta === "aplicado";
        return {
          onde: "iframe", pronto: true, campo: true,
          erroCampo: depois && resposta === "erro" ? "O cupom não está mais disponível." : null,
          cartao: (aplicou && !nomeDiferente) || aplicadoAntes ? { texto: "Com MELIKIDS 15% OFF", aplicado: true } : null,
          aplicados: [
            { texto: "Cupom antigo 5% OFF Aplicado" },
            ...(aplicou && nomeDiferente ? [{ texto: "Cupom Site 10% OFF Compra mínima R$ 100 Aplicado" }] : []),
          ],
          economia: null, texto: "Cupons",
        };
      }
      default: return null;
    }
  });
  return st;
}

describe("naPagina_modalCupons — cartões aplicados", () => {
  it("lista o cartão aplicado mesmo sem \"Com <CÓDIGO>\", e não o que só oferece Aplicar", () => {
    const doc = montarCheckout();
    doc.querySelector("section").insertAdjacentHTML("beforeend", `
      <div class="card"><svg class="icon-check"></svg><span>Cupom Site</span><span>10% OFF</span>
        <button class="andes-button andes-button--disabled" disabled>Aplicado</button></div>`);
    const e = naPagina_modalCupons("estado", "SITE250930");
    expect(e.cartao).toBeNull();
    expect(e.aplicados).toHaveLength(1);
    expect(e.aplicados[0].texto).toMatch(/Cupom Site\s*10% OFF\s*Aplicado/);
  });
});

describe("naPagina_faixaDepuracao", () => {
  it("põe uma faixa só no topo e troca o texto a cada passo", () => {
    document.body.innerHTML = "<p>PDP</p>";
    naPagina_faixaDepuracao("página aberta");
    naPagina_faixaDepuracao("digitando X1");
    const faixas = document.querySelectorAll("#__nimbus_depuracao");
    expect(faixas.length).toBe(1);
    expect(faixas[0].textContent).toBe("🐞 Nimbus: digitando X1");
  });
});

describe("cupomNoCheckout — o caminho", () => {
  beforeEach(() => { vi.clearAllMocks(); aba.classificarMuro.mockReturnValue(null); });

  it("produto → Comprar agora → modal → digita → Inserir → lê, fecha o modal e a aba", async () => {
    const st = mlDeMentira();
    const m = await cupomNoCheckout({ url: PDP, code: "melikids" }, () => {});

    expect(m.code).toBe("MELIKIDS");
    expect(m.checkout).toMatchObject({ reached: true, via: "comprar-agora" });
    expect(m.modal).toMatchObject({ aberto: true, onde: "iframe", campo: true, planoB: false });
    expect(st.digitou && st.inseriu).toBe(true);
    expect(m.cartaoDepois).toMatchObject({ aplicado: true });
    expect(m.resumoDepois).toMatch(/Cupons \(1\/1 em uso\)/);
    expect(m.htmlCupons).toBe("<html>modelo</html>");
    expect(st.fechou).toBe(true);
    expect(aba.fechar).toHaveBeenCalledWith(7);
    // Nunca pagar, nunca o carrinho.
    expect(st.cliques.some(c => /pagar|finalizar|carrinho/i.test(c))).toBe(false);
  });

  it("link de afiliado (meli.la → /social/): segue o \"Ir para o produto\" na mesma aba e testa na PDP", async () => {
    const st = mlDeMentira({ landing: "botao" });
    const m = await cupomNoCheckout({ url: "https://meli.la/1fjPN8C", code: "MELIKIDS" }, () => {});
    expect(aba.irPara).toHaveBeenCalledWith(7, PDP);
    expect(m.landing).toEqual({ de: LANDING, via: "botao", falhou: false });
    expect(m.finalUrl).toBe(PDP);
    expect(m.notProductPage).toBe(false);
    expect(m.checkout.reached).toBe(true);
    expect(st.inseriu).toBe(true);
  });

  it("landing sem saída: não é produto, e diz que foi a landing", async () => {
    mlDeMentira({ landing: "presa" });
    const m = await cupomNoCheckout({ url: "https://meli.la/1fjPN8C", code: "X1" }, () => {});
    expect(m.notProductPage).toBe(true);
    expect(m.landing).toMatchObject({ via: null, falhou: true });
    expect(m.checkout.attempted).toBe(false);
  });

  it("devolve o erro do campo quando o ML recusa", async () => {
    mlDeMentira({ resposta: "erro" });
    const m = await cupomNoCheckout({ url: PDP, code: "X1" }, () => {});
    expect(m.erroCampo).toBe("O cupom não está mais disponível.");
  });

  it("modal que não monta → plano B: abre /cupons/cho na própria aba", async () => {
    const st = mlDeMentira({ modalAbre: false });
    aba.irPara.mockImplementation(async () => { st.modal = true; });
    const m = await cupomNoCheckout({ url: PDP, code: "X1" }, () => {});
    expect(aba.irPara).toHaveBeenCalledWith(7, "https://www.mercadolivre.com.br/cupons/cho?context_id=abc");
    expect(m.modal).toMatchObject({ aberto: true, planoB: true });
  });

  it("muro não resolvido → volta com o muro, sem tentar o checkout, e fecha a aba", async () => {
    mlDeMentira();
    aba.classificarMuro.mockReturnValue("captcha");
    const m = await cupomNoCheckout({ url: PDP, code: "X1" }, () => {});
    expect(m.muro).toBe("captcha");
    expect(m.checkout.attempted).toBe(false);
    expect(aba.fechar).toHaveBeenCalledWith(7);
  });

  it("produto com variação: escolhe antes do Comprar agora e registra a escolha", async () => {
    const st = mlDeMentira({ variacao: "ok" });
    const m = await cupomNoCheckout({ url: PDP, code: "MELIKIDS" }, () => {});
    expect(st.cliquesVariacao).toBe(1);
    expect(m.variacao).toBe("Tamanho: P/M (36-38)");
    expect(m.checkout.reached).toBe(true);
    expect(m.variacaoFaltando).toBeNull();
  });

  it("variação que não sai: tenta de novo, desiste e diz o porquê, sem abrir o modal", async () => {
    const st = mlDeMentira({ variacao: "presa" });
    const m = await cupomNoCheckout({ url: PDP, code: "MELIKIDS" }, () => {});
    expect(m.checkout.reached).toBe(false);
    expect(m.variacaoFaltando).toBe("Escolha Tamanho para continuar com sua compra.");
    expect(st.digitou).toBe(false);
    expect(aba.fechar).toHaveBeenCalledWith(7);
  });

  it("link \"Inserir código do cupom\": vai direto digitar, mesmo que o cartão pareça aplicado", async () => {
    const st = mlDeMentira({ link: "Inserir código do cupom", aplicadoAntes: true });
    const m = await cupomNoCheckout({ url: PDP, code: "MELIKIDS" }, () => {});
    expect(m.modal).toMatchObject({ link: "Inserir código do cupom", semCupom: true });
    expect(m.cartaoAntes).toBeNull();
    expect(st.digitou && st.inseriu).toBe(true);
  });

  it("link \"Cupons (1/1 em uso)\" com o cartão já aplicado: não digita", async () => {
    const st = mlDeMentira({ aplicadoAntes: true });
    const m = await cupomNoCheckout({ url: PDP, code: "MELIKIDS" }, () => {});
    expect(m.cartaoAntes).toMatchObject({ aplicado: true });
    expect(st.digitou).toBe(false);
  });

  it("cupom aplicado com outro nome: o cartão aplicado NOVO é o do código", async () => {
    mlDeMentira({ nomeDiferente: true });
    const m = await cupomNoCheckout({ url: PDP, code: "SITE250930" }, () => {});
    expect(m.cartaoDepois).toEqual({ texto: "Cupom Site 10% OFF Compra mínima R$ 100 Aplicado", aplicado: true, porNome: false });
    expect(m.aplicadosAntes).toEqual(["Cupom antigo 5% OFF Aplicado"]);
  });

  it("recusado: o cartão aplicado que já estava lá não vira o do código", async () => {
    mlDeMentira({ resposta: "erro", nomeDiferente: true });
    const m = await cupomNoCheckout({ url: PDP, code: "X1" }, () => {});
    expect(m.cartaoDepois).toBeNull();
  });

  it("o resumo depois é lido com o modal já fechado", async () => {
    const st = mlDeMentira();
    await cupomNoCheckout({ url: PDP, code: "MELIKIDS" }, () => {});
    expect(st.fotoDepoisDeFechar).toBe(true);
  });

  it("sem depurar: aba em segundo plano e nenhum passo de depuração", async () => {
    mlDeMentira();
    const eventos = [];
    await cupomNoCheckout({ url: PDP, code: "MELIKIDS" }, (e) => eventos.push(e));
    expect(aba.abrir).toHaveBeenCalledWith(PDP, { ativa: false });
    expect(eventos.some(e => e.tipo === "passo-depuracao")).toBe(false);
    expect(aba.avaliar.mock.calls.some(([, f]) => f.name === "naPagina_faixaDepuracao")).toBe(false);
  });

  it("modo depuração: aba na frente, cada passo avisa, escreve na faixa e espera", async () => {
    const st = mlDeMentira();
    const eventos = [];
    const m = await cupomNoCheckout({ url: PDP, code: "MELIKIDS", depurar: true }, (e) => eventos.push(e));
    expect(aba.abrir).toHaveBeenCalledWith(PDP, { ativa: true });
    const passos = eventos.filter(e => e.tipo === "passo-depuracao").map(e => e.rotulo);
    expect(passos[0]).toMatch(/^página aberta/);
    expect(passos).toContain("indo ao checkout (Comprar agora)");
    expect(passos).toContain("digitando MELIKIDS");
    expect(passos).toContain("MELIKIDS aplicado");
    expect(passos.some(p => /procurando o botão/.test(p))).toBe(true);
    expect(aba.avaliar.mock.calls.filter(([, f]) => f.name === "naPagina_faixaDepuracao").length).toBe(passos.length + 1);   // + a do fim
    expect(aba.sleep).toHaveBeenCalledWith(3000);
    // Mesmo resultado do caminho normal.
    expect(m.cartaoDepois).toMatchObject({ aplicado: true });
    expect(st.inseriu).toBe(true);
    expect(aba.fechar).toHaveBeenCalledWith(7);
  });

  it("sem link ou sem código, nem abre aba", async () => {
    await expect(cupomNoCheckout({ url: "", code: "X" }, () => {})).rejects.toThrow(/faltou/);
    expect(aba.abrir).not.toHaveBeenCalled();
  });
});
