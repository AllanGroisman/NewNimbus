import { describe, it, expect } from "vitest";
import { mergeOnboarding, DEFAULT_ONBOARDING, tourForPage, TOURS } from "../data/onboarding";

describe("mergeOnboarding", () => {
  it("preenche o formato completo a partir de nada", () => {
    const o = mergeOnboarding(undefined);
    expect(o).toEqual(DEFAULT_ONBOARDING);
    expect(o.tours).toEqual({});
  });

  it("mantém os tours já vistos", () => {
    expect(mergeOnboarding({ tours: { main: true } }).tours.main).toBe(true);
  });

  it("aguenta lixo gravado de uma versão antiga", () => {
    expect(mergeOnboarding({ tours: "sim" }).tours).toEqual({});
    expect(mergeOnboarding("nada").tours).toEqual({});
  });
});

describe("tourForPage", () => {
  it("com campanha aberta, oferece o tour da campanha", () => {
    expect(tourForPage("dashboard", true)).toBe(TOURS.campaign);
  });
  it("fora de uma campanha, oferece o tour do painel", () => {
    expect(tourForPage("whatsapp", false)).toBe(TOURS.main);
    expect(tourForPage("settings", false)).toBe(TOURS.main);
  });
});

describe("TOURS", () => {
  it("só existem os dois tours (o do WhatsApp foi removido)", () => {
    expect(Object.keys(TOURS).sort()).toEqual(["campaign", "main"]);
  });

  it("todo passo tem alvo, título e texto", () => {
    for (const tour of Object.values(TOURS)) {
      expect(tour.steps.length).toBeGreaterThan(0);
      for (const s of tour.steps) {
        expect(s.anchor).toBeTruthy();
        expect(s.title).toBeTruthy();
        expect(s.text).toBeTruthy();
      }
    }
  });

  it("o tour da campanha passa por todas as abas, em ordem", () => {
    const ordem = [];
    for (const s of TOURS.campaign.steps) {
      if (s.tab !== ordem[ordem.length - 1]) ordem.push(s.tab);
    }
    expect(ordem).toEqual(["overview", "manage", "products", "queue", "whatsapp", "messages", "schedule", "history"]);
  });

  it("todo passo da campanha sabe em qual aba ele mora", () => {
    // Sem isso o "← Voltar" ficaria preso: o passo anterior seria pulado por
    // estar numa aba que não está aberta.
    for (const s of TOURS.campaign.steps) expect(s.tab).toBeTruthy();
  });

  it("cada aba abre iluminando o próprio botão e depois seus componentes", () => {
    const steps = TOURS.campaign.steps;
    const porAba = {};
    steps.forEach((s, i) => { if (!(s.tab in porAba)) porAba[s.tab] = i; });
    for (const [aba, i] of Object.entries(porAba)) {
      expect(steps[i].anchor).toBe(`tab-${aba}`);
      const componentes = steps.filter(s => s.tab === aba && s.anchor !== `tab-${aba}`);
      // Histórico é a única aba que se explica só com o passo da aba.
      if (aba !== "history") expect(componentes.length).toBeGreaterThan(0);
    }
  });

  it("o passo das lojas ilumina Mercado Livre, Amazon e Shopee juntos", () => {
    const lojas = TOURS.main.steps.find(s => Array.isArray(s.anchor));
    expect(lojas.anchor).toEqual(["nav-mercado-livre", "nav-amazon", "nav-shopee"]);
  });
});
