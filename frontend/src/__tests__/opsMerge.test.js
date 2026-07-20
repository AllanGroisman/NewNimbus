import { describe, it, expect } from "vitest";
import { fieldChanged, mergeGroupOps, mergeGroupsOps, OPS_FIELDS } from "../data/opsMerge";

describe("fieldChanged", () => {
  it("mesma referência → false (caminho rápido)", () => {
    const arr = [1, 2, 3];
    expect(fieldChanged(arr, arr)).toBe(false);
  });

  it("conteúdo igual mas referência nova → false", () => {
    expect(fieldChanged([1, 2, 3], [1, 2, 3])).toBe(false);
    expect(fieldChanged({ a: 1 }, { a: 1 })).toBe(false);
  });

  it("conteúdo diferente → true", () => {
    expect(fieldChanged([1, 2], [1, 2, 3])).toBe(true);
    expect(fieldChanged(3, 5)).toBe(true);
    expect(fieldChanged("a", "b")).toBe(true);
  });

  it("valor não serializável (circular) → true (conservador)", () => {
    const circular = {};
    circular.self = circular;
    expect(fieldChanged(circular, {})).toBe(true);
  });
});

describe("mergeGroupOps — merge de um grupo preservando identidade", () => {
  const base = { id: 1, name: "Campanha", queue: [], sentToday: 0, history: [] };

  it("ops ausente → mesma referência", () => {
    expect(mergeGroupOps(base, undefined)).toBe(base);
    expect(mergeGroupOps(base, null)).toBe(base);
  });

  it("nenhum campo de ops mudou → mesma referência", () => {
    const ops = { queue: [], sentToday: 0, history: [] };
    expect(mergeGroupOps(base, ops)).toBe(base);
  });

  it("um campo mudou → NOVA referência com o valor atualizado", () => {
    const ops = { queue: [{ id: "x" }], sentToday: 2 };
    const out = mergeGroupOps(base, ops);
    expect(out).not.toBe(base);
    expect(out.queue).toEqual([{ id: "x" }]);
    expect(out.sentToday).toBe(2);
    expect(out.name).toBe("Campanha"); // campos não-ops preservados
  });

  it("ignora campos fora de OPS_FIELDS (ex.: name do backend)", () => {
    const ops = { name: "Nome do backend" };
    const out = mergeGroupOps(base, ops);
    expect(out).toBe(base); // name não é ops → nada muda
  });

  it("ignora campos undefined em ops", () => {
    const ops = { queue: undefined, sentToday: undefined };
    expect(mergeGroupOps(base, ops)).toBe(base);
  });

  it("OPS_FIELDS cobre os campos operacionais esperados", () => {
    expect(OPS_FIELDS).toEqual(
      expect.arrayContaining(["queue", "pending", "history", "sentToday", "sentWeek", "weekData", "lastSend", "avgDiscount"])
    );
  });
});

describe("mergeGroupsOps — merge de lista preservando identidade", () => {
  it("nada mudou → MESMA referência de array", () => {
    const groups = [
      { id: 1, queue: [], sentToday: 0 },
      { id: 2, queue: [], sentToday: 1 },
    ];
    const opsList = [
      { id: 1, queue: [], sentToday: 0 },
      { id: 2, queue: [], sentToday: 1 },
    ];
    expect(mergeGroupsOps(groups, opsList)).toBe(groups);
  });

  it("um grupo mudou → NOVO array; grupos inalterados mantêm a referência", () => {
    const g1 = { id: 1, queue: [], sentToday: 0 };
    const g2 = { id: 2, queue: [], sentToday: 1 };
    const groups = [g1, g2];
    const opsList = [
      { id: 1, queue: [], sentToday: 0 },       // sem mudança
      { id: 2, queue: [], sentToday: 9 },       // mudou
    ];
    const out = mergeGroupsOps(groups, opsList);
    expect(out).not.toBe(groups);
    expect(out[0]).toBe(g1);                    // inalterado → mesma ref
    expect(out[1]).not.toBe(g2);                // alterado → nova ref
    expect(out[1].sentToday).toBe(9);
  });

  it("grupo sem ops correspondente mantém a referência", () => {
    const g1 = { id: 1, queue: [], sentToday: 0 };
    const groups = [g1];
    const out = mergeGroupsOps(groups, []); // sem ops pra id 1
    expect(out).toBe(groups);
    expect(out[0]).toBe(g1);
  });

  it("opsList ausente → mesma referência", () => {
    const groups = [{ id: 1, queue: [] }];
    expect(mergeGroupsOps(groups, undefined)).toBe(groups);
  });
});
