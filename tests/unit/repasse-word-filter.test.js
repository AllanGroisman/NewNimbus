// Repasse — lista branca/negra de palavras (backend/repasse/word-filter.js) e o
// interruptor do admin que liga/desliga a função (backend/feature-flags.js).

import "../helpers/env.js";
import { describe, it, expect, beforeEach } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const backend = (...p) => require(path.resolve(__dirname, "..", "..", "backend", ...p));

const wf = backend("repasse", "word-filter.js");
const featureFlags = backend("feature-flags.js");
const appConfig = backend("config");
const { normalizeRepasse } = backend("repasse", "leaders.js");

beforeEach(() => {
  appConfig.set(featureFlags.FEATURE_FLAGS_KEY, {});
});

describe("checkName", () => {
  it("listas vazias deixam tudo passar", () => {
    expect(wf.checkName("Qualquer coisa", { allow: [], block: [] }).ok).toBe(true);
  });

  it("ignora acento e caixa dos dois lados", () => {
    expect(wf.checkName("Cafeteira ELÉTRICA", { block: ["eletrica"] }).ok).toBe(false);
    expect(wf.checkName("Cafeteira eletrica", { block: ["Elétrica"] }).ok).toBe(false);
  });

  it("casa pelo começo da palavra", () => {
    expect(wf.checkName("Fones de ouvido", { allow: ["fone"] }).ok).toBe(true);
    expect(wf.checkName("Cabo fone-de-ouvido", { allow: ["fone"] }).ok).toBe(true);
    expect(wf.checkName("Leitor UPC", { block: ["pc"] }).ok).toBe(true);
    expect(wf.checkName("Monitor para PC gamer", { block: ["pc"] }).ok).toBe(false);
  });

  it("aceita frase com espaço", () => {
    expect(wf.checkName("Mouse Sem Fio Logitech", { block: ["sem fio"] }).ok).toBe(false);
    expect(wf.checkName("Mouse com fio", { block: ["sem fio"] }).ok).toBe(true);
  });

  it("lista branca: basta uma palavra; sem nenhuma, barra com motivo", () => {
    expect(wf.checkName("Notebook Dell", { allow: ["fone", "notebook"] }).ok).toBe(true);
    const r = wf.checkName("Panela", { allow: ["fone", "notebook"] });
    expect(r).toEqual({ ok: false, list: "allow", reason: "nenhuma palavra da lista branca no nome" });
  });

  it("aprovado também traz o motivo", () => {
    expect(wf.checkName("Fone JBL", { allow: ["notebook", "fone"] })).toEqual({ ok: true, reason: 'tem "fone" da lista branca' });
    expect(wf.checkName("Fone JBL", { block: ["infantil"] })).toEqual({ ok: true, reason: "nenhuma palavra da lista negra" });
  });

  it("a lista negra ganha da branca", () => {
    const r = wf.checkName("Fone infantil", { allow: ["fone"], block: ["infantil"] });
    expect(r.ok).toBe(false);
    expect(r.list).toBe("block");
    expect(r.reason).toBe('palavra da lista negra: "infantil"');
  });
});

describe("sanitizeWords", () => {
  it("minúsculas, sem vazio nem duplicata, com teto", () => {
    expect(wf.sanitizeWords(["  Fone ", "fone", "", null, "A  B"])).toEqual(["fone", "a b"]);
    expect(wf.sanitizeWords("fone")).toEqual([]);
    expect(wf.sanitizeWords(Array.from({ length: 60 }, (_, i) => `p${i}`)).length).toBe(wf.MAX_WORDS);
    expect(wf.sanitizeWords(["x".repeat(80)])[0].length).toBe(wf.MAX_WORD_LEN);
  });
});

describe("wordFilterOf + interruptor do admin", () => {
  const group = { scraping: { repasse: { allowWords: ["Fone"], blockWords: ["infantil"] } } };

  it("lê as listas da campanha com a função ligada (padrão)", () => {
    expect(featureFlags.readFlags().repasseWordFilter).toBe(true);
    expect(wf.wordFilterOf(group)).toEqual({ allow: ["fone"], block: ["infantil"] });
  });

  it("função desligada → listas vazias, mesmo com palavras salvas", () => {
    featureFlags.writeFlags({ repasseWordFilter: false });
    expect(wf.wordFilterOf(group)).toEqual({ allow: [], block: [] });
  });

  it("writeFlags ignora chave desconhecida e valor não booleano", () => {
    const f = featureFlags.writeFlags({ repasseWordFilter: "não", outraCoisa: true });
    expect(f).toEqual({ repasseWordFilter: true });
  });
});

describe("normalizeRepasse guarda as listas", () => {
  it("mantém saneadas e omite as vazias", () => {
    const sc = normalizeRepasse({ kind: "repasse", repasse: { leaders: [], allowWords: ["Fone", "fone"], blockWords: [] } });
    expect(sc.repasse.allowWords).toEqual(["fone"]);
    expect(sc.repasse).not.toHaveProperty("blockWords");
  });
});
