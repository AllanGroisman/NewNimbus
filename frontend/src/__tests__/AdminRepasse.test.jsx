// Admin › Repasse — o painel que precisa dizer POR QUE um link foi descartado.
//
// O que estes testes protegem é o que faltava quando o Mercado Livre recusou dez
// links seguidos e o painel mostrou dez linhas parecidas: a loja parada precisa
// aparecer numa frase única em cima, "esperar" precisa ficar visualmente separado
// de "agir", e uma etapa que não chegou a rodar não pode parecer defeito.
//
// Depois disso entrou o selo do cupom: o código pescado na legenda vai na mensagem
// do cliente de qualquer forma, então o que o painel precisa dizer é se alguém já
// conferiu com o ML — e "nunca testado" não é a mesma coisa que "o ML recusou".

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("../data/api", () => ({
  errText: (err, fallback) => err?.message || fallback,
  adminRepasseLogs: vi.fn(),
  adminRepasseSummary: vi.fn(),
}));

import PageAdminRepasse from "../pages/AdminRepasse.jsx";
import { adminRepasseLogs, adminRepasseSummary } from "../data/api";

const KINDS = {
  captcha: { label: "CAPTCHA", what: "A loja exigiu verificação anti-robô.", action: "Bloqueio passageiro — nada a fazer agora.", transient: true },
  "login-wall": { label: "Muro de login", what: "A loja mandou a tela de login.", action: "Cole um cookie de afiliado novo em Configurações.", transient: false },
  "loja-nao-suportada": { label: "Loja não suportada", what: "Não é ML, Amazon nem Shopee.", action: "Nada a corrigir.", transient: null },
};

const SUMMARY = {
  hours: 24,
  since: "2026-08-24T18:00:00.000Z",
  total: 100,
  byOutcome: { discarded: 90, queued: 10 },
  byErrorKind: [
    { kind: "captcha", count: 88, lastAt: "2026-08-25T17:52:00.000Z" },
    { kind: "login-wall", count: 2, lastAt: "2026-08-25T15:00:00.000Z" },
  ],
  byStore: [
    { store: "Mercado Livre", total: 90, ok: 0, discarded: 90, successRate: 0, lastOkAt: "2026-08-25T17:03:00.000Z", failuresSinceLastOk: 90, topErrorKind: "captcha" },
    { store: "Amazon", total: 10, ok: 10, discarded: 0, successRate: 100, lastOkAt: "2026-08-25T17:50:00.000Z", failuresSinceLastOk: 0, topErrorKind: null },
  ],
  byHour: [],
  kinds: KINDS,
};

function linha(over = {}) {
  return {
    id: "1", groupId: "7", groupName: "Campanha", userId: "u1", userEmail: "a@b.com",
    waJid: "1@g.us", rawUrl: "https://ml.com/p/1", resolvedUrl: null, store: "Mercado Livre",
    sourceAllowed: null, affiliateConfigured: null, scrapeOk: null,
    productName: null, productImg: null, price: null, originalPrice: null, discount: null,
    sold: null, coupon: null, couponVerdict: null, couponCheckedAt: null, couponSource: null,
    outcome: "discarded", errorKind: "captcha", stage: "scrape",
    reason: "Mercado Livre pediu verificação (CAPTCHA).", createdAt: "2026-08-25T17:52:00.000Z",
    ...over,
  };
}

function mockLista(items) {
  adminRepasseLogs.mockResolvedValue({ page: 1, pageSize: 50, total: items.length, items });
}

describe("Admin › Repasse", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adminRepasseSummary.mockResolvedValue(SUMMARY);
    mockLista([linha()]);
  });

  it("anuncia a loja parada numa frase só, com desde quando e quantas falhas", async () => {
    render(<PageAdminRepasse />);
    const alerta = await screen.findByText(/Mercado Livre: nenhum link aprovado desde/);
    expect(alerta.parentElement.textContent).toMatch(/90 tentativas seguidas falharam \(CAPTCHA\)/);
  });

  it("loja saudável não vira alerta", async () => {
    render(<PageAdminRepasse />);
    await screen.findByText(/Mercado Livre: nenhum link aprovado/);
    expect(screen.queryByText(/Amazon: nenhum link aprovado/)).toBeNull();
  });

  it("separa esperar de agir nos motivos", async () => {
    render(<PageAdminRepasse />);
    // CAPTCHA é passageiro; cookie vencido exige alguém mexer na configuração.
    expect(await screen.findByText("esperar")).toBeTruthy();
    expect(screen.getByText("agir")).toBeTruthy();
  });

  it("o motivo abre 'o que aconteceu' e 'o que fazer' em linhas separadas", async () => {
    render(<PageAdminRepasse />);
    const botao = await screen.findByRole("button", { name: "Muro de login" });
    fireEvent.click(botao);
    expect(screen.getByText(/O que aconteceu:/).parentElement.textContent).toMatch(/tela de login/);
    expect(screen.getByText(/O que fazer:/).parentElement.textContent).toMatch(/cookie de afiliado novo/);
  });

  it("etapa que não chegou a rodar diz isso, em vez de um traço solto", async () => {
    // Descartado na detecção da loja: a checagem de afiliado e a leitura da
    // página nem aconteceram.
    mockLista([linha({ errorKind: "loja-nao-suportada", stage: "store", reason: "loja não suportada" })]);
    render(<PageAdminRepasse />);
    await screen.findByText(/\(loja não suportada\)/);
    const naoRodou = screen.getAllByText("não rodou");
    expect(naoRodou.length).toBe(3); // fonte habilitada, afiliado e scrape
    expect(naoRodou[0].getAttribute("title")).toMatch(/detecção da loja/);
  });

  it("linha antiga (sem etapa) mantém o traço, sem inventar histórico", async () => {
    mockLista([linha({ stage: null, errorKind: null, reason: "captcha do ML" })]);
    render(<PageAdminRepasse />);
    await screen.findByText(/captcha do ML/);
    expect(screen.queryByText("não rodou")).toBeNull();
  });

  it("mostra o selo do motivo E o texto humano ao lado", async () => {
    render(<PageAdminRepasse />);
    await screen.findByText(/\(Mercado Livre pediu verificação \(CAPTCHA\)\.\)/);
    expect(screen.getAllByText("CAPTCHA").length).toBeGreaterThan(0);
  });

  it("marca o descarte que aconteceu no envio", async () => {
    mockLista([linha({ stage: "send", errorKind: "captcha", reason: "Afiliado ML falhou" })]);
    render(<PageAdminRepasse />);
    expect(await screen.findByText(/descartado no envio/)).toBeTruthy();
  });

  it("filtrar por motivo recarrega a lista com o errorKind", async () => {
    render(<PageAdminRepasse />);
    // Espera as opções, que só existem depois do resumo chegar.
    await screen.findByRole("option", { name: "Muro de login" });
    const select = screen.getByDisplayValue("Todos os motivos");
    fireEvent.change(select, { target: { value: "login-wall" } });
    await waitFor(() => {
      expect(adminRepasseLogs).toHaveBeenLastCalledWith(expect.objectContaining({ errorKind: "login-wall" }));
    });
  });

  it("trocar o período rebusca o resumo com a nova janela", async () => {
    render(<PageAdminRepasse />);
    fireEvent.click(await screen.findByText("7d"));
    await waitFor(() => {
      expect(adminRepasseSummary).toHaveBeenLastCalledWith(expect.objectContaining({ hours: 168 }));
    });
  });

  it("motivo que a UI não conhece aparece cru, sem quebrar a tela", async () => {
    mockLista([linha({ errorKind: "motivo-do-futuro", reason: "algo novo" })]);
    render(<PageAdminRepasse />);
    expect(await screen.findByText("motivo-do-futuro")).toBeTruthy();
  });
});

describe("Admin › Repasse — o selo do cupom", () => {
  it("diz que o cupom enviado nunca foi testado", async () => {
    // Este é o caso da esmagadora maioria das linhas. Mostrá-lo como "não validado"
    // seria acusar o cupom de algo que ninguém verificou.
    mockLista([linha({ coupon: "JBL20", couponVerdict: null })]);
    render(<PageAdminRepasse />);
    expect(await screen.findByText(/não testado/)).toBeTruthy();
  });

  it("marca o cupom que o ML recusou — ele foi embora na mensagem mesmo assim", async () => {
    mockLista([linha({ coupon: "NAOEXISTE", couponVerdict: "invalid", couponCheckedAt: "2026-08-25T18:00:00.000Z" })]);
    render(<PageAdminRepasse />);
    expect(await screen.findByText(/não validado/)).toBeTruthy();
  });

  it("marca o cupom validado e diz quando o robô testou", async () => {
    mockLista([linha({
      coupon: "VALE10", couponVerdict: "valid",
      couponCheckedAt: "2026-08-25T18:00:00.000Z", couponSource: "repasse-auto",
    })]);
    render(<PageAdminRepasse />);
    const selo = await screen.findByText(/validado/);
    expect(selo.title).toMatch(/teste automático/);
  });

  it("mensagem sem cupom não ganha selo nenhum", async () => {
    mockLista([linha({ coupon: null })]);
    render(<PageAdminRepasse />);
    // Espera o card da linha, e não o "CAPTCHA" — esse texto também aparece no
    // resumo do topo, que é outra coisa.
    await screen.findByText("https://ml.com/p/1");
    expect(screen.queryByText(/validado|não testado/)).toBeNull();
  });
});
