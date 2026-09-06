// Sessões Signal duplicadas PN×LID — o pareamento do scripts/fix-lid-sessions.js.
//
// Contexto: o WhatsApp migrou o endereço de cada aparelho do telefone ("PN",
// 555596168060) para um número opaco ("LID", 4269197504618). O Baileys 6.7.23 não
// sabe que os dois são a mesma conta e acaba guardando dois ratchets pro mesmo
// celular — de onde vem o "Aguardando mensagem" que não some. O script apaga o par
// pra que a sessão seja refeita do zero, e o risco dele é apagar demais: device é
// numerado POR CONTA, então dois contatos diferentes coincidem no device o tempo
// todo. É esse limite que os testes aqui travam.
import "../helpers/env.js";
import { describe, it, expect } from "vitest";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_JS = path.resolve(__dirname, "..", "..", "backend", "scripts", "fix-lid-sessions.js");
const require = createRequire(pathToFileURL(SCRIPT_JS));
const { looksLikePhoneUser, parseAddr, findDuplicatePairs } = require(SCRIPT_JS);

describe("looksLikePhoneUser — separar PN de LID sem ter o mapa", () => {
  it("aceita celular brasileiro de 9 e de 8 dígitos", () => {
    expect(looksLikePhoneUser("5513991698122")).toBe(true); // 9 dígitos
    expect(looksLikePhoneUser("555596168060")).toBe(true);  // 8 dígitos, número antigo
    expect(looksLikePhoneUser("555597140686")).toBe(true);
  });

  it("recusa os LIDs reais que apareceram em produção", () => {
    for (const lid of ["4269197504618", "82214951903310", "77279380148421", "100674637410402"]) {
      expect(looksLikePhoneUser(lid)).toBe(false);
    }
  });

  it("recusa DDD que não existe e lixo", () => {
    expect(looksLikePhoneUser("552096168060")).toBe(false); // DDD 20 não existe
    expect(looksLikePhoneUser("")).toBe(false);
    expect(looksLikePhoneUser("abc")).toBe(false);
  });
});

describe("parseAddr — <user>.<device>", () => {
  it("separa user e device", () => {
    expect(parseAddr("4269197504618.47")).toEqual({ user: "4269197504618", device: "47" });
  });

  it("devolve null pro que não é endereço Signal", () => {
    expect(parseAddr("semponto")).toBeNull();
    expect(parseAddr("user.abc")).toBeNull();
    expect(parseAddr(".47")).toBeNull();
  });
});

describe("findDuplicatePairs", () => {
  it("pareia PN e LID do mesmo aparelho quando o mapeamento se repete em 2+ devices", () => {
    const { pairs, ambiguous } = findDuplicatePairs([
      "555596168060.47", "4269197504618.47",
      "555596168060.62", "4269197504618.62",
    ]);
    expect(ambiguous).toEqual([]);
    expect(pairs.map(p => p.device)).toEqual(["47", "62"]);
    expect(pairs[0]).toMatchObject({ pn: "555596168060.47", lid: "4269197504618.47" });
  });

  it("não pareia um mapeamento visto num device só — é coincidência de número de device", () => {
    const { pairs, ambiguous } = findDuplicatePairs([
      "555596168060.41", "155439312412685.41",
    ]);
    expect(pairs).toEqual([]);
    expect(ambiguous).toHaveLength(1);
    expect(ambiguous[0]).toMatchObject({ lid: "155439312412685.41" });
  });

  it("aceita o par de um device só quando o creds.me prova o mapeamento", () => {
    const proven = new Set(["555596168060|4269197504618"]);
    const { pairs, ambiguous } = findDuplicatePairs(["555596168060.47", "4269197504618.47"], proven);
    expect(ambiguous).toEqual([]);
    expect(pairs).toHaveLength(1);
  });

  it("ignora device que só tem um endereço — nada a limpar", () => {
    const { pairs, ambiguous } = findDuplicatePairs(["555596168060.47", "555596168060.62"]);
    expect(pairs).toEqual([]);
    expect(ambiguous).toEqual([]);
  });

  it("ignora device com dois LIDs — contato estrangeiro, cujo PN não reconhecemos", () => {
    const { pairs, ambiguous } = findDuplicatePairs([
      "82214951903310.11", "77279380148421.11",
      "82214951903310.12", "77279380148421.12",
    ]);
    expect(pairs).toEqual([]);
    expect(ambiguous).toEqual([]);
  });

  it("não engasga com keyIds malformados no meio", () => {
    const { pairs } = findDuplicatePairs([
      "lixo", "555596168060.47", "4269197504618.47", "555596168060.62", "4269197504618.62",
    ]);
    expect(pairs).toHaveLength(2);
  });
});
