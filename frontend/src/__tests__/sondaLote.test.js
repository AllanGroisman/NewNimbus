// O laço da sonda em lote (data/sondaLote.js): um produto de cada vez, o resultado
// de cada um vai pro servidor, e o muro para o lote inteiro — ele vale para a conta.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../data/api", () => ({
  adminSondaLoteAlvos: vi.fn(),
  adminSondaLoteResultado: vi.fn(),
  adminSondaLoteRegistrarRun: vi.fn(),
}));
vi.mock("../data/coletor", () => ({ sondarCuponsNoCheckout: vi.fn(), coletorEntende: vi.fn() }));

import { sondarLote, materialEnxuto } from "../data/sondaLote";
import { adminSondaLoteAlvos, adminSondaLoteResultado, adminSondaLoteRegistrarRun } from "../data/api";
import { sondarCuponsNoCheckout, coletorEntende } from "../data/coletor";

const P = (n) => ({ key: `k${n}`, name: `Produto ${n}`, link: `https://produto.mercadolivre.com.br/MLB-${n}`, category: "casa" });

beforeEach(() => {
  vi.clearAllMocks();
  coletorEntende.mockResolvedValue(false);
  adminSondaLoteRegistrarRun.mockResolvedValue({});
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

describe("sondarLote com o ritmo do servidor", () => {
  const CFG = { paralelo: 2, pausaMs: 0, settleMs: 800, esperaCheckoutMs: 20000, esperaNavMs: 15000, modoRapido: true };
  const P4 = () => [P(1), P(2), P(3), P(4)];

  it("extensão nova: duas abas ao mesmo tempo, sem carrinho, com os tempos e o modo rápido", async () => {
    coletorEntende.mockResolvedValue(true);
    adminSondaLoteAlvos.mockResolvedValue({ produtos: P4(), total: 4, cfg: CFG });
    let emCurso = 0;
    let pico = 0;
    sondarCuponsNoCheckout.mockImplementation(async () => {
      pico = Math.max(pico, ++emCurso);
      await new Promise(r => setTimeout(r, 5));
      emCurso--;
      return { checkout: { reached: true } };
    });
    const eventos = [];
    const r = await sondarLote({ onProgresso: (e) => eventos.push(e) });

    expect(pico).toBe(2);
    expect(r.paralelo).toBe(2);
    expect(r.feitos.map(f => f.key)).toEqual(["k1", "k2", "k3", "k4"]);
    expect(adminSondaLoteResultado).toHaveBeenCalledTimes(4);
    expect(sondarCuponsNoCheckout).toHaveBeenCalledWith(P(1).link, expect.objectContaining({
      rapido: true, semCarrinho: true, tempos: { settleMs: 800, esperaCheckoutMs: 20000, esperaNavMs: 15000 },
    }));
    // Com várias abas não se anuncia "pausa": as outras estão andando.
    expect(eventos.filter(e => e.tipo === "pausa")).toHaveLength(0);
    expect(new Set(eventos.filter(e => e.tipo === "produto").map(e => e.aba))).toEqual(new Set([0, 1]));
  });

  it("até 8 abas ao mesmo tempo", async () => {
    coletorEntende.mockResolvedValue(true);
    const oito = Array.from({ length: 8 }, (_, i) => P(i + 1));
    adminSondaLoteAlvos.mockResolvedValue({ produtos: oito, total: 8, cfg: { ...CFG, paralelo: 8 } });
    let emCurso = 0;
    let pico = 0;
    sondarCuponsNoCheckout.mockImplementation(async () => {
      pico = Math.max(pico, ++emCurso);
      await new Promise(r => setTimeout(r, 10));
      emCurso--;
      return {};
    });
    const r = await sondarLote();
    expect(r.paralelo).toBe(8);
    expect(pico).toBe(8);
  });

  it("extensão velha: uma aba só e nenhuma opção nova, mesmo com paralelo no servidor", async () => {
    adminSondaLoteAlvos.mockResolvedValue({ produtos: P4(), total: 4, cfg: CFG });
    sondarCuponsNoCheckout.mockResolvedValue({});
    const r = await sondarLote();
    expect(r.paralelo).toBe(1);
    const [, opcoes] = sondarCuponsNoCheckout.mock.calls[0];
    expect(opcoes.rapido).toBeUndefined();
    expect(opcoes.semCarrinho).toBeUndefined();
  });

  it("uma aba só: nada de semCarrinho, o plano B continua valendo", async () => {
    coletorEntende.mockResolvedValue(true);
    adminSondaLoteAlvos.mockResolvedValue({ produtos: [P(1)], total: 1, cfg: { ...CFG, paralelo: 1 } });
    sondarCuponsNoCheckout.mockResolvedValue({});
    await sondarLote();
    expect(sondarCuponsNoCheckout).toHaveBeenCalledWith(P(1).link, expect.objectContaining({ semCarrinho: false, rapido: true }));
  });

  it("o muro numa aba fecha a porta: ninguém começa produto novo, e o que estava em curso termina", async () => {
    coletorEntende.mockResolvedValue(true);
    adminSondaLoteAlvos.mockResolvedValue({ produtos: P4(), total: 4, cfg: CFG });
    sondarCuponsNoCheckout.mockImplementation(async (url, { onProgresso }) => {
      if (url === P(1).link) {
        await new Promise(r => setTimeout(r, 5));
        onProgresso({ tipo: "muro", muro: "captcha" });
        return { muro: "captcha" };
      }
      await new Promise(r => setTimeout(r, 20));
      return {};
    });
    const r = await sondarLote();
    expect(r.muro).toBe(true);
    expect(sondarCuponsNoCheckout.mock.calls.map(c => c[0])).toEqual([P(1).link, P(2).link]);
    expect(r.feitos.map(f => f.key)).toEqual(["k1", "k2"]);
  });
});

describe("o histórico da execução", () => {
  it("no fim, manda o resumo: contagens, tempo médio da sonda e o ritmo usado", async () => {
    coletorEntende.mockResolvedValue(true);
    adminSondaLoteAlvos.mockResolvedValue({ produtos: [P(1), P(2), P(3)], total: 3, cfg: { paralelo: 1, pausaMs: 0, settleMs: 800, modoRapido: true } });
    sondarCuponsNoCheckout.mockImplementation(async () => { await new Promise(r => setTimeout(r, 5)); return {}; });
    await sondarLote();

    expect(adminSondaLoteRegistrarRun).toHaveBeenCalledTimes(1);
    const run = adminSondaLoteRegistrarRun.mock.calls[0][0];
    expect(run).toMatchObject({
      produtos: 3, naFila: 3, ok: 3, comCupom: 1, falhas: 0, parado: null, muro: false,
      ritmo: { paralelo: 1, pausaMs: 0, settleMs: 800, modoRapido: true },
    });
    expect(run.mediaSondaMs).toBeGreaterThanOrEqual(5);
    expect(Date.parse(run.fim)).toBeGreaterThanOrEqual(Date.parse(run.inicio));
  });

  it("execução sem produto nenhum não entra no histórico; falha ao gravar não derruba o lote", async () => {
    adminSondaLoteAlvos.mockResolvedValueOnce({ produtos: [], total: 0, cfg: {} });
    await sondarLote();
    expect(adminSondaLoteRegistrarRun).not.toHaveBeenCalled();

    adminSondaLoteRegistrarRun.mockRejectedValue(new Error("fora do ar"));
    sondarCuponsNoCheckout.mockResolvedValue({});
    const r = await sondarLote({ pausaMs: 0 });
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
