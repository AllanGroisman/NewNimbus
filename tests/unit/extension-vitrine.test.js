// O laço da vitrine, na extensão. Testável porque `raspar` não fala com o Chrome
// direto: tudo passa por `aba.js`, que aqui é mockado.
//
// Por que ele ganhou teste agora: a colheita só sabia contar PÁGINAS, e página não
// prevê quantidade — "10% OFF com QUEROPROMO" devolveu 1040 produtos em 11 páginas,
// o servidor recusou o lote inteiro por passar do teto dele, e o trabalho de 22
// abas abertas na conta do ML foi para o lixo.

import { describe, it, expect, vi, beforeEach } from "vitest";

const aba = {
  abrir: vi.fn(async () => 1),
  irPara: vi.fn(async () => {}),
  fechar: vi.fn(async () => {}),
  injetarArquivo: vi.fn(),
  esperarHumano: vi.fn(async () => false),
  sleep: vi.fn(async () => {}),
};
vi.mock("../../extension/aba.js", () => aba);

const { raspar } = await import("../../extension/vitrine.js");

// Uma página com `n` produtos inéditos — o offset garante que não repitam.
const pagina = (n, offset) => ({
  produtos: Array.from({ length: n }, (_, i) => ({
    name: `P${offset + i}`, link: `https://www.mercadolivre.com.br/p/MLB${offset + i}`, price: 10,
  })),
  muro: null,
});

// O ML entrega `porPagina` produtos por página, para sempre.
function paginasInfinitas(porPagina) {
  let lidas = 0;
  aba.injetarArquivo.mockImplementation(async () => pagina(porPagina, (lidas++) * porPagina));
}

describe("raspar — os dois tetos da vitrine", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("para no teto de PRODUTOS antes de gastar as páginas, e isso é parcial", async () => {
    // 96 por página, não os 48 do `_Desde_`: é o caso real que estourou o servidor.
    paginasInfinitas(96);
    const r = await raspar({ containerUrl: "https://lista.mercadolivre.com.br/_Container_1", paginas: 11, maxProdutos: 500 }, () => {});

    expect(r.produtos).toHaveLength(500);
    expect(r.parcial).toBe(true);
    expect(r.motivo).toMatch(/teto de 500 produtos/);
    // Sobrou vitrine lá: não faz sentido continuar abrindo aba na conta do ML.
    expect(r.paginas).toBeLessThan(11);
  });

  it("com o teto de produtos alto, quem manda é o de páginas", async () => {
    paginasInfinitas(10);
    const r = await raspar({ containerUrl: "https://lista.mercadolivre.com.br/_Container_1", paginas: 3, maxProdutos: 500 }, () => {});

    expect(r.produtos).toHaveLength(30);
    expect(r.parcial).toBe(true);
    expect(r.motivo).toMatch(/teto de 3 páginas/);
  });

  it("vitrine que acaba antes dos dois tetos é lista FECHADA", async () => {
    // Duas páginas cheias e a terceira vazia — o fim de verdade da lista.
    let lidas = 0;
    aba.injetarArquivo.mockImplementation(async () => (lidas < 2 ? pagina(10, (lidas++) * 10) : { produtos: [], muro: null }));

    const r = await raspar({ containerUrl: "https://lista.mercadolivre.com.br/_Container_1", paginas: 11, maxProdutos: 500 }, () => {});
    expect(r.produtos).toHaveLength(20);
    expect(r.parcial).toBe(false);
    expect(r.motivo).toBe(null);
  });
});
