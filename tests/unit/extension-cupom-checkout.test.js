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

const { naPagina_modalCupons, cupomNoCheckout } = await import("../../extension/cupom-checkout.js");

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

// ── o comando ──────────────────────────────────────────────────────────────

const PDP = "https://www.mercadolivre.com.br/boneca/p/MLB123456";
const CHECKOUT = "https://www.mercadolivre.com.br/checkout/review/onestep";

// Um ML de mentira, respondendo por nome da função injetada.
function mlDeMentira({ modalAbre = true, resposta = "aplicado" } = {}) {
  const st = { url: PDP, modal: false, digitou: false, inseriu: false, fechou: false, cliques: [] };
  aba.avaliar.mockImplementation(async (_tab, func, args) => {
    switch (func.name) {
      case "naPagina_espiao": return true;
      case "naPagina_foto": return {
        url: st.url, titulo: "", tituloDaAba: "",
        texto: st.url === CHECKOUT ? "Finalize sua compra Resumo da compra Cupons (1/1 em uso) - R$ 40,48 Você pagará R$ 229,42" : "Boneca Comprar agora",
        digital: st.url, respostas: [],
      };
      case "naPagina_formDeCompra": return null;
      case "naPagina_clicarPorTexto":
        st.cliques.push(args[0]);
        if (/comprar agora/.test(args[0])) { st.url = CHECKOUT; return "Comprar agora"; }
        return null;
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
        return {
          onde: "iframe", pronto: true, campo: true,
          erroCampo: depois && resposta === "erro" ? "O cupom não está mais disponível." : null,
          cartao: depois && resposta === "aplicado" ? { texto: "Com MELIKIDS 15% OFF", aplicado: true } : null,
          economia: null, texto: "Cupons",
        };
      }
      default: return null;
    }
  });
  return st;
}

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

  it("sem link ou sem código, nem abre aba", async () => {
    await expect(cupomNoCheckout({ url: "", code: "X" }, () => {})).rejects.toThrow(/faltou/);
    expect(aba.abrir).not.toHaveBeenCalled();
  });
});
