// O laço da sonda em lote (data/sondaLote.js): um produto de cada vez, o resultado
// de cada um vai pro servidor, e o muro para o lote inteiro — ele vale para a conta.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../data/api", () => ({
  adminSondaLoteAlvos: vi.fn(),
  adminSondaLoteResultado: vi.fn(),
}));
vi.mock("../data/coletor", () => ({ sondarCuponsNoCheckout: vi.fn() }));

import { sondarLote, materialEnxuto } from "../data/sondaLote";
import { adminSondaLoteAlvos, adminSondaLoteResultado } from "../data/api";
import { sondarCuponsNoCheckout } from "../data/coletor";

const P = (n) => ({ key: `k${n}`, name: `Produto ${n}`, link: `https://produto.mercadolivre.com.br/MLB-${n}`, category: "casa" });

beforeEach(() => {
  vi.clearAllMocks();
  adminSondaLoteAlvos.mockResolvedValue({ produtos: [P(1), P(2), P(3)], total: 3, cfg: { pausaMs: 5000 } });
  adminSondaLoteResultado.mockImplementation(async ({ key }) => ({ ok: true, cupons: key === "k2" ? [{ campaignId: "C" }] : [] }));
});

describe("sondarLote", () => {
  it("sonda cada produto, manda o resultado e anuncia o andamento", async () => {
    sondarCuponsNoCheckout.mockImplementation(async (_url, { onProgresso }) => {
      onProgresso({ tipo: "pdp" });
      return { checkout: { reached: true }, paginaDosCupons: { ok: true, html: "<x/>" } };
    });
    const eventos = [];
    const r = await sondarLote({ filtros: { limite: 3 }, pausaMs: 0, onProgresso: (e) => eventos.push(e.tipo) });

    expect(adminSondaLoteAlvos).toHaveBeenCalledWith({ limite: 3 });
    expect(sondarCuponsNoCheckout).toHaveBeenCalledTimes(3);
    expect(adminSondaLoteResultado).toHaveBeenCalledWith(expect.objectContaining({ key: "k1", url: P(1).link }));
    expect(r.feitos.map(f => f.cupons.length)).toEqual([0, 1, 0]);
    expect(r.parado).toBeNull();
    expect(eventos.filter(t => t === "produto-feito")).toHaveLength(3);
    expect(eventos.filter(t => t === "pausa")).toHaveLength(2);
    expect(eventos[0]).toBe("fila");
  });

  it("o muro para o lote depois de gravar o produto em que apareceu", async () => {
    sondarCuponsNoCheckout.mockImplementation(async (_url, { onProgresso }) => {
      onProgresso({ tipo: "muro", muro: "" });
      return { checkout: { reached: true } };
    });
    const r = await sondarLote({ pausaMs: 0 });
    expect(sondarCuponsNoCheckout).toHaveBeenCalledTimes(1);
    expect(adminSondaLoteResultado).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ muro: true, parado: expect.stringMatching(/verificação/) });
  });

  it("Parar vale a partir do próximo produto", async () => {
    let parar = false;
    sondarCuponsNoCheckout.mockImplementation(async () => { parar = true; return {}; });
    const r = await sondarLote({ pausaMs: 0, parou: () => parar });
    expect(r.feitos).toHaveLength(1);
    expect(r.parado).toBe("Interrompido por você");
  });

  it("extensão que falha num produto: anota a falha e segue", async () => {
    sondarCuponsNoCheckout.mockRejectedValueOnce(new Error("A extensão não respondeu a tempo.")).mockResolvedValue({});
    const r = await sondarLote({ pausaMs: 0 });
    expect(r.feitos[0]).toMatchObject({ ok: false, motivo: "A extensão não respondeu a tempo." });
    expect(adminSondaLoteResultado).toHaveBeenCalledWith({ key: "k1", url: P(1).link, erro: "A extensão não respondeu a tempo." });
    expect(r.feitos).toHaveLength(3);
  });
});

describe("materialEnxuto", () => {
  it("manda só o HTML que o parser lê, sem as capturas pesadas", () => {
    const m = materialEnxuto({
      checkout: { reached: true, trail: [1, 2] },
      capturaAoEntrar: { html: "x".repeat(1000) },
      capturaDosCupons: { texto: "t", html: "<p/>", iframes: [{ src: "s", texto: "t", html: "<i/>" }] },
      paginaDosCupons: { ok: true, html: "<pg/>", url: "u" },
    });
    expect(m.capturaAoEntrar).toBeUndefined();
    expect(m.capturaDosCupons).toEqual({ iframes: [{ html: "<i/>" }] });
    expect(m.paginaDosCupons).toEqual({ ok: true, html: "<pg/>" });
    expect(m.checkout.trail).toBeUndefined();
  });
});
