// O painel do "agora" da colheita (task 7): os eventos do laço viram fila,
// lote, cupom da vez e contadores.
import { describe, it, expect } from "vitest";
import { reduzirAndamento, andamentoInicial, estimativaMs, duracao } from "../data/andamentoColheita";

const rodar = (eventos, agora = 0) => eventos.reduce(reduzirAndamento, andamentoInicial(agora));

describe("reduzirAndamento", () => {
  it("conta a fila e os desfechos cupom a cupom", () => {
    const e = rodar([
      { tipo: "fila", total: 3, prontos: 3, aAtivar: 0, lotes: 1 },
      { tipo: "lote", k: 1, de: 1, tamanho: 3 },
      { tipo: "vitrine-abrindo", title: "A", i: 1, de: 3, agora: 0 },
      { tipo: "pagina", pagina: 2, produtos: 40 },
      { tipo: "vitrine-feita", ok: true, produtos: 40, parcial: true },
      { tipo: "vitrine-abrindo", title: "B", i: 2, de: 3, agora: 10 },
      { tipo: "vitrine-feita", ok: false, vazia: true },
    ]);
    expect(e.fila).toMatchObject({ total: 3, feitos: 2 });
    expect(e.contagem).toMatchObject({ colhidas: 1, parciais: 1, vazias: 1, falhas: 0, produtos: 40 });
    expect(e.atual).toMatchObject({ title: "B", pagina: 0 });
    expect(e.etapa).toBe("vitrine");
  });

  it("lote salvo inteiro fecha quem não deu vitrine", () => {
    const e = rodar([
      { tipo: "fila", total: 4 },
      { tipo: "lote", k: 1, de: 2, tamanho: 2 },
      { tipo: "vitrine-feita", ok: true, produtos: 1 },
      { tipo: "lote-salvo", completo: true },
    ]);
    expect(e.fila.feitos).toBe(2);
  });

  it("a passada de ativação pela lista continua sendo 'ativando', não 'lista'", () => {
    const e = rodar([{ tipo: "ativando", n: 2 }, { tipo: "pagina-abrindo", pagina: 1 }]);
    expect(e.etapa).toBe("ativando");
    expect(rodar([{ tipo: "pagina-abrindo", pagina: 3 }]).etapa).toBe("lista");
  });

  it("a lista ganha páginas e fila de categorias do servidor (task 18)", () => {
    const e = rodar([
      { tipo: "pagina-abrindo", pagina: 1, grouping: null },
      { tipo: "pagina-lida", pagina: 1, de: 40, grouping: null, categoria: 1, categorias: 5, cupons: 30 },
      { tipo: "pagina-abrindo", pagina: 2, grouping: null },
    ]);
    expect(e.lista).toMatchObject({ pagina: 2, lidas: 1, de: 40, categoria: 1, categorias: 5, cupons: 30 });
  });

  it("a fila de categorias vem do servidor — a tela não adivinha mais que ela andou", () => {
    // Esta tela DEDUZIA "a fila andou uma casa" de o grouping ter mudado entre
    // dois `pagina-abrindo`. Com várias abas (task 21) dois groupings intercalam
    // eventos, e o palpite disparava a cada alternância: a barra de fila passava
    // de "2 de 5" para "5 de 5" sem a rodada ter andado nada. Quem sabe em que
    // entrada a varredura está é o servidor, e ele diz no `pagina-lida`.
    const e = rodar([
      { tipo: "pagina-abrindo", pagina: 1, grouping: null },
      { tipo: "pagina-lida", pagina: 1, de: 40, grouping: null, categoria: 1, categorias: 5 },
      { tipo: "pagina-abrindo", pagina: 1, grouping: "hi_vertical" },
    ]);
    expect(e.lista.categoria).toBe(1);   // ainda a do servidor

    const lida = reduzirAndamento(e, {
      tipo: "pagina-lida", pagina: 1, de: 3, grouping: "hi_vertical", nome: "Casa", categoria: 2, categorias: 5,
    });
    expect(lida.lista).toMatchObject({ grouping: "hi_vertical", nome: "Casa", lidas: 1, de: 3, categoria: 2 });
  });

  it("as páginas abertas agora ficam visíveis, uma por aba (task 21)", () => {
    // O análogo do `atuais` das vitrines: com várias abas, "página 7 de 40" é uma
    // das sete verdades ao mesmo tempo, e o painel precisa poder dizer quantas
    // estão abertas em vez de fingir um cursor que não existe mais.
    const e = rodar([
      { tipo: "pagina-abrindo", pagina: 2, grouping: null, aba: 0 },
      { tipo: "pagina-abrindo", pagina: 3, grouping: null, aba: 1 },
      { tipo: "pagina-abrindo", pagina: 4, grouping: null, aba: 2 },
    ]);
    expect(Object.keys(e.lista.abertas)).toHaveLength(3);

    // A 3 volta antes da 2 — é o normal com várias abas. Ela sai das abertas, e
    // `lidas` é o que o servidor contou, não o número da página que voltou.
    const depois = reduzirAndamento(e, { tipo: "pagina-lida", pagina: 1, de: 40, grouping: null, aba: 1, emVoo: 2 });
    expect(Object.keys(depois.lista.abertas)).toEqual(["0", "2"]);
    expect(depois.lista.lidas).toBe(1);
    expect(depois.lista.emVoo).toBe(2);
  });

  it("a ativação conta os alvos achados na lista, na frente e no fundo (task 18)", () => {
    const e = rodar([
      { tipo: "ativando", n: 4 },
      { tipo: "pagina-abrindo", pagina: 1 },
      { tipo: "ativando", quantos: 2, pagina: 1 },
      { tipo: "pagina-lida", pagina: 1, alvos: { total: 4, vistos: 3 } },
    ]);
    expect(e.ativacao).toEqual({ total: 4, vistos: 3, pagina: 1 });
    expect(e.lista).toBeNull();
    expect(reduzirAndamento(e, { tipo: "vitrine-abrindo", title: "A" }).ativacao).toBeNull();

    const f = rodar([
      { tipo: "ativando", n: 5, fundo: true, loteFundo: 2 },
      { tipo: "pagina-lida", pagina: 1, alvos: { total: 5, vistos: 2 }, fundo: true, loteFundo: 2 },
    ]);
    expect(f.ativacaoFundo).toMatchObject({ lote: 2, total: 5, vistos: 2 });
    expect(f.etapa).toBe("preparando");
  });

  it("a pausa guarda até quando, e o muro vira etapa", () => {
    expect(rodar([{ tipo: "pausa", ms: 4000, motivo: "entre vitrines", agora: 1000 }]).pausa).toEqual({ ate: 5000, ms: 4000, motivo: "entre vitrines" });
    expect(rodar([{ tipo: "muro" }]).etapa).toBe("muro");
  });

  it("encerrar zera, reiniciar recomeça", () => {
    expect(reduzirAndamento({}, { tipo: "encerrar" })).toBeNull();
    expect(reduzirAndamento(null, { tipo: "reiniciar", agora: 7 }).inicio).toBe(7);
  });
});

describe("estimativaMs", () => {
  it("só estima com dois cupons medidos, pela média", () => {
    const um = rodar([{ tipo: "fila", total: 10 }, { tipo: "vitrine-abrindo", agora: 0 }, { tipo: "vitrine-feita", ok: true }]);
    expect(estimativaMs(um, 10_000)).toBeNull();
    const dois = reduzirAndamento(um, { tipo: "vitrine-feita", ok: true });
    expect(estimativaMs(dois, 20_000)).toBe(80_000);
  });

  it("duracao lê como gente", () => {
    expect(duracao(42_000)).toBe("42s");
    expect(duracao(125_000)).toBe("2min 05s");
  });
});

describe("vitrines em paralelo e ativação de fundo (task 14)", () => {
  it("guarda todas as vitrines abertas e tira a que terminou", () => {
    const e = rodar([
      { tipo: "fila", total: 3, paralelo: 2 },
      { tipo: "vitrine-abrindo", campaignId: "A", title: "A", i: 1, de: 3 },
      { tipo: "vitrine-abrindo", campaignId: "B", title: "B", i: 2, de: 3 },
      { tipo: "pagina", campaignId: "A", pagina: 3, produtos: 90 },
      { tipo: "vitrine-feita", campaignId: "B", ok: true, produtos: 5 },
    ]);
    expect(Object.keys(e.atuais)).toEqual(["A"]);
    expect(e.atuais.A).toMatchObject({ pagina: 3, produtos: 90 });
    expect(e.atual.campaignId).toBe("A");
    expect(e.paralelo).toBe(2);
  });

  it("a ativação de fundo não troca a etapa, mas conta os cliques", () => {
    const e = rodar([
      { tipo: "vitrine-abrindo", campaignId: "A", title: "A" },
      { tipo: "ativando", n: 4, fundo: true, loteFundo: 2 },
      { tipo: "pagina-abrindo", pagina: 3, fundo: true, loteFundo: 2 },
      { tipo: "ativou", fundo: true, loteFundo: 2 },
    ]);
    expect(e.etapa).toBe("vitrine");
    expect(e.ativacaoFundo).toEqual({ lote: 2, pagina: 3, n: 4 });
    expect(e.contagem.ativados).toBe(1);
    expect(reduzirAndamento(e, { tipo: "ativacao-fundo-fim", loteFundo: 2 }).ativacaoFundo).toBeNull();
  });
});
