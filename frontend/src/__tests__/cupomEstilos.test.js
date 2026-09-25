// A duração dos resumos de colheita (task 21): passando de minuto, vira minuto;
// passando de hora, vira hora.
import { describe, it, expect } from "vitest";
import { segundos } from "../components/admin/cupomEstilos";

describe("segundos", () => {
  it("abaixo de um minuto fica em segundos", () => {
    expect(segundos(30000)).toBe("30s");
    expect(segundos(0)).toBe("0s");
  });

  it("passando de minuto, minuto e segundos", () => {
    expect(segundos(140000)).toBe("2min e 20s");
    expect(segundos(120000)).toBe("2min");
  });

  it("passando de hora, hora, minuto e segundos — partes zeradas somem", () => {
    expect(segundos(3880000)).toBe("1h 4min e 40s");
    expect(segundos(3600000)).toBe("1h");
    expect(segundos(3620000)).toBe("1h e 20s");
    expect(segundos(3840000)).toBe("1h e 4min");
  });

  it("sem número, nada", () => {
    expect(segundos(undefined)).toBeNull();
    expect(segundos(NaN)).toBeNull();
  });
});
