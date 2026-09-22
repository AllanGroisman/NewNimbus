// Sintaxe da busca por palavras-chave (backend/catalog/search-query.js): a mesma
// regra vale no catálogo (SQL) e no filtro em memória do scraper.

import "../helpers/env.js";
import { describe, it, expect } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { normalizeText, parseSearch, isEmptySearch, matchesSearch, likePattern } =
  require(path.resolve(__dirname, "..", "..", "backend", "catalog", "search-query.js"));

describe("parseSearch", () => {
  it("espaço separa palavras do mesmo grupo; vírgula abre outro grupo", () => {
    expect(parseSearch("Fone Bluetooth, monitor")).toEqual({
      groups: [{ words: ["fone", "bluetooth"], phrases: [] }, { words: ["monitor"], phrases: [] }],
      excludes: [],
    });
  });

  it("aspas viram frase — vírgula dentro delas não separa grupo", () => {
    expect(parseSearch('fone "sem fio, preto"').groups).toEqual([
      { words: ["fone"], phrases: ["sem fio, preto"] },
    ]);
  });

  it("-palavra e -\"frase\" excluem; hífen solto e no meio da palavra não", () => {
    const r = parseSearch('fone - -infantil -"com fio" wi-fi');
    expect(r.excludes).toEqual(["infantil", "com fio"]);
    expect(r.groups).toEqual([{ words: ["fone", "wi-fi"], phrases: [] }]);
  });

  it("tira acento e caixa, e ignora grupos vazios", () => {
    expect(parseSearch("  CAFÉ ,, , Pão ").groups.map(g => g.words)).toEqual([["cafe"], ["pao"]]);
    expect(isEmptySearch(parseSearch(" , ,  "))).toBe(true);
    expect(normalizeText("  Ação   Rápida ")).toBe("acao rapida");
  });
});

describe("matchesSearch", () => {
  const casa = (q, nome) => matchesSearch(nome, parseSearch(q));

  it("todas as palavras do grupo, em qualquer ordem", () => {
    expect(casa("bluetooth fone", "Fone de Ouvido Bluetooth")).toBe(true);
    expect(casa("fone jbl", "Fone de Ouvido Bluetooth")).toBe(false);
  });

  it("vírgula é OU entre grupos", () => {
    expect(casa("notebook, monitor", "Monitor 24 pol")).toBe(true);
  });

  it("frase precisa estar contínua; exclusão derruba o produto", () => {
    expect(casa('"sem fio"', "Mouse Sem Fio")).toBe(true);
    expect(casa('"sem fio"', "Fio sem capa")).toBe(false);
    expect(casa("fone -infantil", "Fone Infantil Gato")).toBe(false);
  });

  it("acento não importa dos dois lados", () => {
    expect(casa("cafe", "Café Torrado")).toBe(true);
    expect(casa("pão", "Forma de pao")).toBe(true);
  });
});

describe("likePattern", () => {
  it("escapa os curingas do LIKE", () => {
    expect(likePattern("50%_off\\x")).toBe("%50\\%\\_off\\\\x%");
  });
});
