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
