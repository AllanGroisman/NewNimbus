// O total da vitrine que `extension/colher.js` lê da página — o "200" do "45/200"
// da tabela de cupons. O arquivo é um IIFE injetado pela extensão (sem export),
// então o teste o roda como a extensão roda: sobre um DOM, lendo o valor devolvido.
import { describe, it, expect, afterAll } from "vitest";
import { createRequire } from "module";
import { readFileSync } from "fs";

// O pacote de testes não tem DOM; o frontend tem (mesmo truque do
// extension-cupom-checkout.test.js).
const requireDoFront = createRequire(new URL("../../frontend/package.json", import.meta.url));
const { Window } = requireDoFront("happy-dom");
const janela = new Window({ url: "https://lista.mercadolivre.com.br/_Container_teste" });
afterAll(() => janela.happyDOM?.close?.());

const fonte = readFileSync(new URL("../../extension/colher.js", import.meta.url), "utf8");
// `eval` direto dentro da função: o IIFE enxerga `document`/`location` como os
// parâmetros, e o valor dele (o objeto devolvido) volta pelo `return`.
// eslint-disable-next-line no-new-func
const rodar = new Function("document", "location", "fonte", "return eval(fonte)");

function colher(html) {
  janela.document.body.innerHTML = html;
  return rodar(janela.document, janela.location, fonte);
}

describe("colher.js — o total da vitrine", () => {
  it("lê o paging.total do estado da página", () => {
    const r = colher(`<script>window.__PRELOADED_STATE__={"pageState":{"initialState":{"paging":{"offset":0,"limit":48,"total":1234}}}}</script>`);
    expect(r.total).toBe(1234);
  });

  it("sem o estado, lê o texto \"1.234 resultados\", sem o ponto de milhar", () => {
    const r = colher(`<span class="ui-search-search-result__quantity-results">1.234 resultados</span>`);
    expect(r.total).toBe(1234);
  });

  it("um resultado só também vale", () => {
    expect(colher(`<span class="ui-search-search-result__quantity-results">1 resultado</span>`).total).toBe(1);
  });

  it("página que não diz nada devolve null — e não zero", () => {
    expect(colher(`<div>nada aqui</div>`).total).toBe(null);
  });
});
