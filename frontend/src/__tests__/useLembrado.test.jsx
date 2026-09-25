// data/useLembrado.js — preferência de tela do admin, guardada no servidor via
// data/preferenciasAdmin.js. O que importa aqui: nunca quebrar a tela (valor
// estragado vale o padrão), e o padrão literal não virar valor novo a cada render.

import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useLembrado, lerLembrado, umDe } from "../data/useLembrado";
import { gravar, ler, _zerarParaTestes } from "../data/preferenciasAdmin";

beforeEach(() => _zerarParaTestes());

describe("useLembrado", () => {
  it("sem nada guardado usa o padrão, e grava o que mudar", () => {
    const { result } = renderHook(() => useLembrado("t.modo", "rapido"));
    expect(result.current[0]).toBe("rapido");
    act(() => result.current[1]("checkout"));
    expect(result.current[0]).toBe("checkout");
    expect(ler("t.modo")).toBe("checkout");
  });

  it("volta com o valor guardado, e acompanha quem mudar a chave de fora", () => {
    gravar("t.modo", "leitura");
    const { result } = renderHook(() => useLembrado("t.modo", "rapido"));
    expect(result.current[0]).toBe("leitura");
    act(() => gravar("t.modo", "checkout"));
    expect(result.current[0]).toBe("checkout");
  });

  it("o setter aceita função, como o useState", () => {
    const { result } = renderHook(() => useLembrado("t.filtro", { a: "", b: "" }));
    act(() => result.current[1](f => ({ ...f, a: "x" })));
    expect(result.current[0]).toEqual({ a: "x", b: "" });
  });

  it("padrão em objeto literal é o mesmo objeto de um render para o outro", () => {
    const { result, rerender } = renderHook(() => useLembrado("t.obj", { a: 1 }));
    const antes = result.current[0];
    rerender();
    expect(result.current[0]).toBe(antes);
  });

  it("tipo errado ou valor recusado caem no padrão", () => {
    gravar("b", 42);
    expect(lerLembrado("b", "x")).toBe("x");
    gravar("c", "sumiu");
    expect(lerLembrado("c", "todos", umDe(["todos", "valid"]))).toBe("todos");
    gravar("d", "talvez");
    expect(lerLembrado("d", true)).toBe(true);
    gravar("e", { nao: "array" });
    expect(lerLembrado("e", [])).toEqual([]);
  });
});
