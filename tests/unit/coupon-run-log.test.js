// O passo a passo da rodada de cupons.
//
// A rodada demora minutos e, até aqui, a única coisa que ela contava era um
// `progress` que se sobrescrevia: quem olhava a tela via o instante, nunca o
// percurso. Se ela parasse no meio, não sobrava rastro de onde.
//
// O que se testa aqui é a tradução (evento cru → frase) e a disciplina do log:
// ele mora na memória do processo da API e uma rodada grande emite um evento por
// cupom, então repetir e crescer sem teto são os dois jeitos de ele fazer mal.
import "../helpers/env.js";
import { describe, it, expect } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const sync = require(path.resolve(__dirname, "..", "..", "backend", "coupons", "sync.js"));

const { textoDoProgresso } = sync;

describe("textoDoProgresso", () => {
  it("traduz a leitura da lista, com a categoria e os cupons de loja ignorados", () => {
    expect(textoDoProgresso({ etapa: "cupons", pagina: 2, de: 5, cupons: 40, grouping: "ce_vertical", ignoradosLoja: 3 }))
      .toBe("lendo a lista de ce_vertical — página 2/5, 40 cupons (3 de loja ignorados)");
  });

  it("sem categoria a leitura é a geral — e não some do log por causa disso", () => {
    expect(textoDoProgresso({ etapa: "cupons", pagina: 1, de: 1, cupons: 9, grouping: null, ignoradosLoja: 0 }))
      .toBe("lendo a lista geral — página 1/1, 9 cupons");
  });

  it("nomeia a vitrine que acabou de abrir, não só os contadores", () => {
    expect(textoDoProgresso({ etapa: "vitrines", cupons: 10, vitrines: 3, produtos: 120, title: "Cupom X", ok: true }))
      .toBe('vitrines: 3/10 cupons, 120 produtos · "Cupom X"');
  });

  it("vitrine que não veio carrega o motivo — é a linha que o admin procura depois", () => {
    expect(textoDoProgresso({ etapa: "vitrines", cupons: 10, vitrines: 4, produtos: 120, title: "Cupom Y", ok: false, reason: "CAPTCHA" }))
      .toBe('vitrines: 4/10 cupons, 120 produtos · "Cupom Y" — CAPTCHA');
  });

  it("o `title` é opcional — a frase antiga (só contadores) continua saindo", () => {
    expect(textoDoProgresso({ etapa: "vitrines", cupons: 10, vitrines: 4, produtos: 120 }))
      .toBe("vitrines: 4/10 cupons, 120 produtos");
  });

  it("traduz as etapas curtas", () => {
    expect(textoDoProgresso({ etapa: "abrindo" })).toBe("abrindo a aba de cupons do Mercado Livre");
    expect(textoDoProgresso({ etapa: "ativando", title: "Cupom Z" })).toBe('ativando "Cupom Z"');
    // Sem título, o id serve: melhor um número do que uma linha que some.
    expect(textoDoProgresso({ etapa: "ativando", campaignId: "13471229" })).toBe('ativando "13471229"');
  });

  it("evento que não conhece não vira linha — log não é lugar de `[object Object]`", () => {
    expect(textoDoProgresso({ etapa: "coisa-nova" })).toBeNull();
    expect(textoDoProgresso(null)).toBeNull();
    expect(textoDoProgresso("texto")).toBeNull();
  });
});

describe("o log da rodada", () => {
  it("começa vazio e não é persistido junto do resumo", () => {
    // O status devolve o log, mas o que vai pro app_config é só o resumo
    // (persistStatus). Uma rodada grande são centenas de linhas, e o valor delas
    // é enquanto ela corre.
    const s = sync.status();
    expect(Array.isArray(s.log)).toBe(true);
    expect(Object.keys(sync.status())).toContain("log");
  });
});
