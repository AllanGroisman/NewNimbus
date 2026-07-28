import { describe, it, expect } from "vitest";
import { planLabel, PLAN_LABELS, navToPath, pathToNav, PAGE_TO_PATH } from "../data/constants";

describe("planLabel", () => {
  it("traduz cada plano conhecido", () => {
    expect(planLabel("basic")).toBe("Plano Básico");
    expect(planLabel("pro")).toBe("Plano Pro");
    expect(planLabel("business")).toBe("Plano Business");
    expect(planLabel("free")).toBe("Sem plano ativo");
  });

  it("devolve null quando o billing ainda não carregou", () => {
    // Sem isso a sidebar chutava "Plano Pro" pra todo mundo.
    expect(planLabel(undefined)).toBeNull();
    expect(planLabel(null)).toBeNull();
    expect(planLabel("")).toBeNull();
  });

  it("devolve null pra plano desconhecido em vez de inventar rótulo", () => {
    expect(planLabel("enterprise")).toBeNull();
  });

  it("cobre todos os planos do backend", () => {
    expect(Object.keys(PLAN_LABELS).sort()).toEqual(["basic", "business", "free", "pro"]);
  });
});

describe("navToPath / pathToNav", () => {
  it("dashboard é a raiz", () => {
    expect(navToPath({ page: "dashboard" })).toBe("/");
    expect(pathToNav("/")).toEqual({ page: "dashboard", groupId: null });
  });

  it("campanha aberta tem precedência sobre a página", () => {
    expect(navToPath({ page: "settings", groupId: 123 })).toBe("/campanha/123");
  });

  it("ida e volta preserva a campanha", () => {
    const path = navToPath({ groupId: 1739300000000 });
    expect(pathToNav(path)).toEqual({ page: "group", groupId: "1739300000000" });
  });

  it("caminho desconhecido cai no dashboard em vez de tela em branco", () => {
    expect(pathToNav("/rota-que-nao-existe")).toEqual({ page: "dashboard", groupId: null });
  });

  it("ignora barra sobrando no fim", () => {
    expect(pathToNav("/whatsapp/")).toEqual({ page: "whatsapp", groupId: null });
  });

  it("toda página do mapa faz ida e volta", () => {
    for (const page of Object.keys(PAGE_TO_PATH)) {
      expect(pathToNav(navToPath({ page }))).toEqual({ page, groupId: null });
    }
  });

  it("não gera dois caminhos iguais pra páginas diferentes", () => {
    const paths = Object.values(PAGE_TO_PATH);
    expect(new Set(paths).size).toBe(paths.length);
  });
});
