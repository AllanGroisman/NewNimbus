// data/preferenciasAdmin.js — as preferências de tela do admin, no servidor e
// iguais para todos os admins. O que estes testes protegem: o clique vale na hora
// e sobe uma vez só (não uma por tecla), nada do que cada navegador guardava antes
// se perde, e servidor fora do ar não quebra a tela.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../data/api", () => ({
  adminPrefsGet: vi.fn(),
  adminPrefSet: vi.fn(),
}));

import { adminPrefsGet, adminPrefSet } from "../data/api";
import { carregar, gravar, ler, zerar, recarregarSeVelho, _zerarParaTestes } from "../data/preferenciasAdmin";

beforeEach(() => {
  vi.clearAllMocks();
  _zerarParaTestes();
  localStorage.clear();
  adminPrefsGet.mockResolvedValue({ prefs: {} });
  adminPrefSet.mockResolvedValue({ ok: true });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("preferenciasAdmin", () => {
  it("carrega o que o servidor tem", async () => {
    adminPrefsGet.mockResolvedValue({ prefs: { "admin.repasse.horas": 168 } });
    await carregar();
    expect(ler("admin.repasse.horas")).toBe(168);
  });

  it("vale na hora e manda um PUT só depois da digitação parar", async () => {
    vi.useFakeTimers();
    await carregar();
    gravar("admin.scraper.catalogo", { q: "j" });
    gravar("admin.scraper.catalogo", { q: "jb" });
    gravar("admin.scraper.catalogo", { q: "jbl" });
    expect(ler("admin.scraper.catalogo")).toEqual({ q: "jbl" });
    expect(adminPrefSet).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(700);
    expect(adminPrefSet).toHaveBeenCalledTimes(1);
    expect(adminPrefSet).toHaveBeenCalledWith("admin.scraper.catalogo", { q: "jbl" });
  });

  it("sem sessão de admin (carregar nunca chamado) não fala com o servidor", async () => {
    vi.useFakeTimers();
    gravar("x", 1);
    await vi.advanceTimersByTimeAsync(700);
    expect(adminPrefSet).not.toHaveBeenCalled();
    expect(ler("x")).toBe(1);
  });

  it("sobe as preferências antigas de cada navegador, inclusive o 1/0 das caixinhas", async () => {
    vi.useFakeTimers();
    localStorage.setItem("cupons.soSemProdutos", "1");
    localStorage.setItem("nimbus.repasse.filtroStatus", JSON.stringify("invalid"));
    await carregar();
    expect(ler("cupons.soSemProdutos")).toBe(true);
    expect(ler("nimbus.repasse.filtroStatus")).toBe("invalid");
    await vi.advanceTimersByTimeAsync(700);
    expect(adminPrefSet).toHaveBeenCalledWith("cupons.soSemProdutos", true);
    expect(adminPrefSet).toHaveBeenCalledWith("nimbus.repasse.filtroStatus", "invalid");
  });

  it("o que já está no servidor ganha da cópia antiga do navegador", async () => {
    vi.useFakeTimers();
    localStorage.setItem("cupons.soSemProdutos", "1");
    adminPrefsGet.mockResolvedValue({ prefs: { "cupons.soSemProdutos": false } });
    await carregar();
    expect(ler("cupons.soSemProdutos")).toBe(false);
    await vi.advanceTimersByTimeAsync(700);
    expect(adminPrefSet).not.toHaveBeenCalled();
  });

  it("PUT que falha deixa o valor valendo aqui", async () => {
    vi.useFakeTimers();
    adminPrefSet.mockRejectedValue(new Error("fora do ar"));
    await carregar();
    gravar("admin.repasse.auto", false);
    await vi.advanceTimersByTimeAsync(700);
    expect(ler("admin.repasse.auto")).toBe(false);
  });

  it("GET que falha deixa valendo a cópia local", async () => {
    gravar("admin.usuarios.segmento", "paying");
    adminPrefsGet.mockRejectedValue(new Error("fora do ar"));
    await carregar();
    expect(ler("admin.usuarios.segmento")).toBe("paying");
  });

  it("a releitura não desfaz um clique que ainda não subiu", async () => {
    vi.useFakeTimers();
    await carregar();
    gravar("admin.repasse.horas", 1);
    adminPrefsGet.mockResolvedValue({ prefs: { "admin.repasse.horas": 24 } });
    vi.setSystemTime(Date.now() + 60_000);
    recarregarSeVelho();
    await vi.advanceTimersByTimeAsync(0);
    expect(adminPrefsGet).toHaveBeenCalledTimes(2);
    expect(ler("admin.repasse.horas")).toBe(1);
  });

  it("logout manda na hora o que estava esperando e esquece o resto", async () => {
    vi.useFakeTimers();
    await carregar();
    gravar("admin.repasse.horas", 168);
    zerar();
    expect(adminPrefSet).toHaveBeenCalledWith("admin.repasse.horas", 168);
    expect(ler("admin.repasse.horas")).toBeUndefined();
  });
});
