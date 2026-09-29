// O store da fila do teste no checkout (task 29): o que precisa sobreviver à
// troca de aba — o laço do "Testar todos", o Parar, o passo do cupom atual — e a
// série que impede dois testes no mesmo checkout.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../data/api", () => ({
  errText: (err, fallback) => err?.message || fallback,
  adminRepasseCupomCheckoutReivindicar: vi.fn(),
}));
vi.mock("../data/cupomCheckoutRepasse", () => ({ testarNoCheckout: vi.fn() }));

import { adminRepasseCupomCheckoutReivindicar } from "../data/api";
import { testarNoCheckout } from "../data/cupomCheckoutRepasse";
import {
  _zerarParaTestes, emSerie, ocupado, passoDoEvento, testarTodos, testarItem, parar, registrarAoTestar,
} from "../data/filaCheckoutRepasse";

const item = (code) => ({ code, url: `https://www.mercadolivre.com.br/${code}/p/MLB1` });
const RES = { verdict: "valid", message: "ok" };

beforeEach(() => {
  vi.clearAllMocks();
  _zerarParaTestes();
  adminRepasseCupomCheckoutReivindicar.mockResolvedValue({ ok: true });
});

describe("filaCheckoutRepasse", () => {
  it("emSerie roda um de cada vez e marca ocupado", async () => {
    const ordem = [];
    let soltar;
    const a = emSerie(() => new Promise(r => { soltar = r; ordem.push("a"); }));
    const b = emSerie(async () => { ordem.push("b"); });
    expect(ocupado()).toBe(true);
    await Promise.resolve();
    expect(ordem).toEqual(["a"]);
    soltar();
    await Promise.all([a, b]);
    expect(ordem).toEqual(["a", "b"]);
    expect(ocupado()).toBe(false);
  });

  it("o evento da extensão vira o passo; o muro troca o rótulo sem andar a barra", () => {
    const p1 = passoDoEvento(null, { tipo: "cupons-modal" });
    expect(p1).toEqual({ rotulo: "abrindo os cupons", fracao: 0.6 });
    const p2 = passoDoEvento(p1, { tipo: "muro" });
    expect(p2.fracao).toBe(0.6);
    expect(p2.rotulo).toMatch(/verificação/);
    expect(passoDoEvento(p1, { tipo: "passo-depuracao", rotulo: "x" })).toEqual({ rotulo: "x", fracao: 0.6 });
    expect(passoDoEvento(p1, { tipo: "desconhecido" })).toBe(p1);
  });

  it("testarTodos anda na ordem, pula os reservados e avisa quem registrou", async () => {
    const ordem = [];
    testarNoCheckout.mockImplementation(async (code) => { ordem.push(code); return RES; });
    const aoTestar = vi.fn();
    registrarAoTestar(aoTestar);
    await testarTodos([item("A"), { ...item("B"), reservado: true }, item("C")]);
    expect(ordem).toEqual(["A", "C"]);
    expect(aoTestar).toHaveBeenCalledTimes(2);
  });

  it("Parar vale entre um cupom e outro", async () => {
    let soltar;
    testarNoCheckout.mockImplementationOnce(() => new Promise(r => { soltar = () => r(RES); }));
    const p = testarTodos([item("A"), item("B")]);
    await vi.waitFor(() => expect(soltar).toBeTypeOf("function"));
    parar();
    soltar();
    await p;
    expect(testarNoCheckout).toHaveBeenCalledTimes(1);
  });

  it("um segundo Testar todos durante o primeiro não faz nada", async () => {
    let soltar;
    testarNoCheckout.mockImplementationOnce(() => new Promise(r => { soltar = () => r(RES); }));
    const p = testarTodos([item("A")]);
    await testarTodos([item("Z")]);
    await vi.waitFor(() => expect(soltar).toBeTypeOf("function"));
    soltar();
    await p;
    expect(testarNoCheckout).toHaveBeenCalledTimes(1);
  });

  it("409 na reivindicação não testa e devolve null", async () => {
    adminRepasseCupomCheckoutReivindicar.mockRejectedValue(Object.assign(new Error("x"), { status: 409 }));
    expect(await testarItem(item("A"), "repasse-checkout")).toBeNull();
    expect(testarNoCheckout).not.toHaveBeenCalled();
  });
});
