// O robô que testa sozinho os cupons do repasse — a parte que decide, sem banco
// e sem navegador.
//
// A decisão é o que custa caro aqui: cada palavra escolhida abre um Chrome com a
// conta do Mercado Livre. Escolher errado não dá tela quebrada, dá CAPTCHA — e aí
// o teste manual também para de funcionar. Por isso `selecionar` é pura e estes
// testes cercam justamente as escolhas que gastariam navegador à toa:
//   - insistir numa palavra que o ML já recusou;
//   - reabrir Chrome a cada rodada na palavra que deu "indeterminado" (que NÃO
//     entra no cache de 12h do checkWord);
//   - importar campanha que já está no sistema com a vitrine cheia.
//
// A rodada inteira (com checkWord mockado e banco de verdade) fica em
// integration/repasse-coupon-autotest.test.js.

import "../helpers/env.js";
import { describe, it, expect } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const backendDir = path.resolve(__dirname, "..", "..", "backend");
const autotest = require(path.join(backendDir, "repasse", "coupon-autotest.js"));
const cfgStore = require(path.join(backendDir, "repasse", "coupon-autotest-config.js"));
const { KIND } = require(path.join(backendDir, "repasse", "error-kinds.js"));

const CFG = cfgStore.DEFAULTS;
const HORA = 3600_000;
const AGORA = new Date("2026-09-19T12:00:00Z").getTime();

// Uma linha como o repasse/coupons.js:aggregate devolve. Os defaults são o caso
// mais comum: um código visto uma vez, nunca testado.
function linha(over = {}) {
  return {
    code: "CUPOM10",
    capturas: 3,
    aproveitados: 1,
    ultima: new Date(AGORA - HORA),
    verdict: null,
    campaignId: null,
    inSystem: null,
    produtos: 0,
    checkCount: 0,
    checkedAt: null,
    ...over,
  };
}

const codigos = (lista) => lista.map(x => x.code);

describe("selecionar — as palavras que vão ao ML", () => {
  it("manda a palavra nunca testada", () => {
    const r = autotest.selecionar([linha()], CFG, AGORA);
    expect(codigos(r.testes)).toEqual(["CUPOM10"]);
  });

  it("nunca volta numa palavra que o ML recusou", () => {
    // Resposta fechada: não há checkout que mude "essa palavra não existe", e
    // insistir seria queimar a conta do sistema de graça.
    const r = autotest.selecionar([linha({ verdict: "invalid", checkedAt: new Date(AGORA - 300 * HORA) })], CFG, AGORA);
    expect(r.testes).toEqual([]);
    expect(r.pesado).toEqual([]);
  });

  it("não repete a palavra que valeu — ela já tem resposta", () => {
    const r = autotest.selecionar(
      [linha({ verdict: "valid", campaignId: "42", inSystem: true, produtos: 12 })],
      CFG, AGORA,
    );
    expect(r.testes).toEqual([]);
    expect(r.pesado).toEqual([]);
  });

  it("espera antes de insistir num indeterminado", () => {
    // Recém-testada: fora. O findCodeCheck devolve null pra indeterminado, então
    // sem esta espera o robô reabriria Chrome na mesma palavra a cada rodada.
    const recente = linha({ verdict: "indeterminado", checkCount: 1, checkedAt: new Date(AGORA - 1 * HORA) });
    expect(autotest.selecionar([recente], CFG, AGORA).testes).toEqual([]);

    const velha = linha({ verdict: "indeterminado", checkCount: 1, checkedAt: new Date(AGORA - 7 * HORA) });
    expect(codigos(autotest.selecionar([velha], CFG, AGORA).testes)).toEqual(["CUPOM10"]);
  });

  it("desiste do indeterminado depois do teto de tentativas", () => {
    const esgotada = linha({
      verdict: "indeterminado",
      checkCount: CFG.maxTentativas,
      checkedAt: new Date(AGORA - 300 * HORA),
    });
    expect(autotest.selecionar([esgotada], CFG, AGORA).testes).toEqual([]);
  });

  it("ignora código visto menos vezes que o mínimo", () => {
    const cfg = { ...CFG, minCapturas: 5 };
    expect(autotest.selecionar([linha({ capturas: 4 })], cfg, AGORA).testes).toEqual([]);
    expect(codigos(autotest.selecionar([linha({ capturas: 5 })], cfg, AGORA).testes)).toEqual(["CUPOM10"]);
  });

  it("respeita o teto de palavras por rodada", () => {
    const muitas = Array.from({ length: 12 }, (_, i) => linha({ code: `C${i}` }));
    expect(autotest.selecionar(muitas, { ...CFG, maxPorRodada: 3 }, AGORA).testes).toHaveLength(3);
  });

  it("põe a nunca testada antes do reteste de indeterminado", () => {
    // A primeira resposta sobre uma palavra vale mais que a segunda opinião sobre
    // um engasgo — e o teto por rodada corta o fim da lista.
    const r = autotest.selecionar([
      linha({ code: "ENGASGOU", verdict: "indeterminado", checkCount: 1, checkedAt: new Date(AGORA - 30 * HORA), aproveitados: 99 }),
      linha({ code: "NOVA", aproveitados: 0 }),
    ], CFG, AGORA);
    expect(codigos(r.testes)).toEqual(["NOVA", "ENGASGOU"]);
  });

  it("ordena por cupom que chegou à fila, depois pelo visto mais recente", () => {
    const r = autotest.selecionar([
      linha({ code: "POUCO", aproveitados: 0, ultima: new Date(AGORA) }),
      linha({ code: "MUITO", aproveitados: 9, ultima: new Date(AGORA - 50 * HORA) }),
      linha({ code: "MEIO", aproveitados: 3, ultima: new Date(AGORA) }),
    ], CFG, AGORA);
    expect(codigos(r.testes)).toEqual(["MUITO", "MEIO", "POUCO"]);
  });
});

describe("selecionar — a campanha e a vitrine", () => {
  const valida = (over) => linha({ verdict: "valid", campaignId: "42", inSystem: false, ...over });

  it("traz a campanha da palavra que existe e não está no sistema", () => {
    const r = autotest.selecionar([valida()], CFG, AGORA);
    expect(r.pesado).toEqual([expect.objectContaining({ code: "CUPOM10", campaignId: "42", action: "import" })]);
  });

  it("raspa a vitrine da campanha que está aqui sem produto nenhum", () => {
    // Vitrine vazia é FALTA DE DADO, não "o cupom não vale": sem os vínculos o
    // quick-check fica em "sem-vitrine" e o desconto nunca entra na conta do envio.
    const r = autotest.selecionar([valida({ inSystem: true, produtos: 0 })], CFG, AGORA);
    expect(r.pesado).toEqual([expect.objectContaining({ code: "CUPOM10", action: "vitrine" })]);
  });

  it("não traz campanha sem id — não há o que buscar", () => {
    const r = autotest.selecionar([linha({ verdict: "valid", campaignId: null })], CFG, AGORA);
    expect(r.pesado).toEqual([]);
  });

  it("os dois knobs desligam cada passo por conta própria", () => {
    expect(autotest.selecionar([valida()], { ...CFG, importarCampanha: false }, AGORA).pesado).toEqual([]);
    expect(
      autotest.selecionar([valida({ inSystem: true, produtos: 0 })], { ...CFG, rasparVitrine: false }, AGORA).pesado,
    ).toEqual([]);
  });

  it("importação e vitrine dividem o mesmo teto por rodada", () => {
    // As duas são minutos de Chrome, e a importação ainda ESCREVE na conta do ML.
    const alvos = [
      valida({ code: "A" }),
      valida({ code: "B" }),
      valida({ code: "C", inSystem: true, produtos: 0 }),
    ];
    expect(autotest.selecionar(alvos, { ...CFG, maxImportsPorRodada: 1 }, AGORA).pesado).toHaveLength(1);
    expect(autotest.selecionar(alvos, { ...CFG, maxImportsPorRodada: 2 }, AGORA).pesado).toHaveLength(2);
  });

  it("aguenta lista vazia e linha sem código", () => {
    expect(autotest.selecionar([], CFG, AGORA)).toEqual({ testes: [], pesado: [] });
    expect(autotest.selecionar([null, { capturas: 9 }], CFG, AGORA)).toEqual({ testes: [], pesado: [] });
  });
});

describe("kindDoBloqueio", () => {
  it("reconhece o que o ML manda quando barra o navegador", () => {
    expect(autotest.kindDoBloqueio("Página de CAPTCHA do Mercado Livre")).toBe(KIND.CAPTCHA);
    expect(autotest.kindDoBloqueio("o ML pediu login")).toBe(KIND.LOGIN_WALL);
    expect(autotest.kindDoBloqueio("Navigation timeout of 45000 ms exceeded")).toBe(KIND.TIMEOUT);
  });

  it("não confunde resposta legítima do ML com bloqueio", () => {
    // "Confira se o cupom está correto" é o ML DIZENDO que a palavra não existe:
    // tratar isso como parede pararia a rodada por uma resposta perfeitamente boa.
    expect(autotest.kindDoBloqueio("Confira se o cupom está correto")).toBeNull();
    expect(autotest.kindDoBloqueio("Tivemos um problema")).toBeNull();
    expect(autotest.kindDoBloqueio("")).toBeNull();
  });
});

describe("config do teste automático", () => {
  it("cai nos defaults quando não veio nada", () => {
    expect(cfgStore.sanitize(undefined)).toEqual(cfgStore.DEFAULTS);
    expect(cfgStore.sanitize("lixo")).toEqual(cfgStore.DEFAULTS);
  });

  it("lê checkbox de formulário sem transformar 'false' em true", () => {
    expect(cfgStore.sanitize({ enabled: "false" }).enabled).toBe(false);
    expect(cfgStore.sanitize({ enabled: "true" }).enabled).toBe(true);
    expect(cfgStore.sanitize({ enabled: "on" }).enabled).toBe(true);
    expect(cfgStore.sanitize({ enabled: 0 }).enabled).toBe(false);
  });

  it("prende os números na faixa — zero aqui viraria rajada de Chrome", () => {
    expect(cfgStore.sanitize({ intervaloMs: 0 }).intervaloMs).toBe(cfgStore.FAIXAS.intervaloMs[0]);
    expect(cfgStore.sanitize({ maxPorRodada: -5 }).maxPorRodada).toBe(1);
    expect(cfgStore.sanitize({ maxPorRodada: 9999 }).maxPorRodada).toBe(cfgStore.FAIXAS.maxPorRodada[1]);
    expect(cfgStore.sanitize({ pausaEntrePalavrasMs: "abc" }).pausaEntrePalavrasMs)
      .toBe(cfgStore.DEFAULTS.pausaEntrePalavrasMs);
  });

  it("descarta campo que não é da config", () => {
    expect(cfgStore.sanitize({ lixo: 1 })).not.toHaveProperty("lixo");
  });
});
