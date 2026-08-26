// Admin › Usuários — a tela que dizia "Ativo" sem dizer ativo de quê.
//
// O selo verde significava apenas "não suspenso e com e-mail verificado", mas
// era lido como "está pagando" ou "está rodando". Estes testes travam a
// separação: conta, assinatura e operação são três perguntas distintas, e
// nenhuma delas responde pelas outras.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("../data/api", () => ({
  errText: (err, fallback) => err?.message || fallback,
  adminListUsers: vi.fn(),
  adminGetRegistration: vi.fn(),
  adminSetRegistration: vi.fn(),
  adminUserDetail: vi.fn(),
  adminDeleteUser: vi.fn(),
  adminSetUserPassword: vi.fn(),
  adminSetUserRole: vi.fn(),
  adminVerifyUserEmail: vi.fn(),
  adminSetUserSuspended: vi.fn(),
  adminResendUserVerification: vi.fn(),
}));

import PageAdminUsers from "../pages/AdminUsers.jsx";
import {
  adminListUsers, adminGetRegistration, adminUserDetail, adminSetUserSuspended,
} from "../data/api";

function user(over = {}) {
  return {
    id: "u1", name: "Fulano", email: "fulano@ex.com", role: "user",
    emailVerified: true, suspended: false, createdAt: "2026-01-10T12:00:00.000Z",
    subscription: null,
    counts: { groups: 0, activeGroups: 0, repasseGroups: 0, numbers: 0, connectedNumbers: 0 },
    ...over,
  };
}

function sub(over = {}) {
  return {
    planId: "pro", status: "active", effectivePlanId: "pro", currentPeriodEnd: "2026-09-10T12:00:00.000Z",
    cancelAtPeriodEnd: false, graceEndsAt: null, pastDueSince: null, trialUsedAt: null,
    signupSource: "app", stripeMode: "test", crossMode: null,
    ...over,
  };
}

function ficha(over = {}) {
  return {
    subscription: sub(),
    groups: [],
    numbers: [],
    whatsappGroups: 0,
    repasse: null,
    emails: [],
    affiliate: { ml: { configured: false }, amazon: { configured: false }, shopee: { configured: false } },
    ...over,
  };
}

function mostrar(users) {
  adminListUsers.mockResolvedValue({ users });
}

describe("Admin › Usuários", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adminGetRegistration.mockResolvedValue({ blocked: false });
    adminUserDetail.mockResolvedValue(ficha());
  });

  it("não chama ninguém de 'Ativo' — o selo da conta diz do que se trata", async () => {
    mostrar([user()]);
    render(<PageAdminUsers currentUser={{ id: "admin" }} />);

    expect(await screen.findByText("Conta OK")).toBeInTheDocument();
    // "Ativo" sozinho era a promessa vaga: sem plano e sem campanha, esta conta
    // não está ativa em nenhum sentido útil.
    expect(screen.queryByText("Ativo")).not.toBeInTheDocument();
    expect(screen.getByText("Sem plano")).toBeInTheDocument();
  });

  it("plano cancelado não vira selo verde do plano", async () => {
    mostrar([user({ subscription: sub({ status: "canceled", effectivePlanId: "free" }) })]);
    render(<PageAdminUsers currentUser={{ id: "admin" }} />);

    expect(await screen.findByText("Cancelada")).toBeInTheDocument();
    // O bug original: um "pro" cancelado renderizava "Pro" verde, e o admin lia
    // como cliente pagante. O selo pagante tem a forma "Pagando · <plano>" —
    // "Pagando" solto também é o rótulo do card de resumo e do filtro.
    expect(screen.queryByText(/Pagando ·/)).not.toBeInTheDocument();
  });

  it("assinatura de outro modo do Stripe aparece como tal, não como plano válido", async () => {
    mostrar([user({ subscription: sub({ crossMode: "live" }) })]);
    render(<PageAdminUsers currentUser={{ id: "admin" }} />);

    expect(await screen.findByText("Stripe live")).toBeInTheDocument();
    expect(screen.queryByText(/Pagando ·/)).not.toBeInTheDocument();
  });

  it("campanhas ativas e pausadas aparecem separadas, não como um total só", async () => {
    mostrar([user({ counts: { groups: 5, activeGroups: 2, repasseGroups: 1, numbers: 2, connectedNumbers: 0 } })]);
    render(<PageAdminUsers currentUser={{ id: "admin" }} />);

    expect(await screen.findByText("2/5 campanhas ativas")).toBeInTheDocument();
    // Dois números cadastrados e nenhum conectado é exatamente o caso que o
    // contador cru escondia.
    expect(screen.getByText("nenhum conectado")).toBeInTheDocument();
  });

  it("'Operando' conta só quem tem campanha ativa E número conectado", async () => {
    mostrar([
      user({ id: "a", email: "a@ex.com", counts: { groups: 1, activeGroups: 1, repasseGroups: 0, numbers: 1, connectedNumbers: 1 } }),
      user({ id: "b", email: "b@ex.com", counts: { groups: 1, activeGroups: 1, repasseGroups: 0, numbers: 1, connectedNumbers: 0 } }),
      user({ id: "c", email: "c@ex.com", counts: { groups: 0, activeGroups: 0, repasseGroups: 0, numbers: 1, connectedNumbers: 1 } }),
    ]);
    render(<PageAdminUsers currentUser={{ id: "admin" }} />);

    const card = (await screen.findByText("Operando")).parentElement;
    expect(card.textContent).toMatch(/1de 3/);
  });

  it("clicar no usuário busca a ficha uma vez e reaproveita no segundo clique", async () => {
    mostrar([user()]);
    render(<PageAdminUsers currentUser={{ id: "admin" }} />);

    const linha = await screen.findByRole("button", { name: /Ficha de Fulano/ });

    fireEvent.click(linha);
    await waitFor(() => expect(adminUserDetail).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Assinatura")).toBeInTheDocument();

    fireEvent.click(linha);                    // fecha
    await waitFor(() => expect(screen.queryByText("Assinatura")).not.toBeInTheDocument());
    fireEvent.click(linha);                    // reabre
    expect(await screen.findByText("Assinatura")).toBeInTheDocument();
    // Cache: reabrir não pode bater na rota que junta seis consultas.
    expect(adminUserDetail).toHaveBeenCalledTimes(1);
  });

  it("a ficha mostra número travado com o erro, não só 'desconectado'", async () => {
    mostrar([user()]);
    adminUserDetail.mockResolvedValue(ficha({
      numbers: [{ id: "n1", label: "Loja", phone: "5511999", status: "reconnecting", stuck: true, lastError: "conexão recusada", planPaused: false }],
    }));
    render(<PageAdminUsers currentUser={{ id: "admin" }} />);

    fireEvent.click(await screen.findByRole("button", { name: /Ficha de Fulano/ }));
    expect(await screen.findByText("travado")).toBeInTheDocument();
    expect(screen.getByText("conexão recusada")).toBeInTheDocument();
  });

  it("clicar em Suspender não expande a linha", async () => {
    mostrar([user()]);
    adminSetUserSuspended.mockResolvedValue({});
    render(<PageAdminUsers currentUser={{ id: "admin" }} />);

    fireEvent.click(await screen.findByRole("button", { name: "Suspender" }));
    await waitFor(() => expect(adminSetUserSuspended).toHaveBeenCalled());
    // O card inteiro é clicável agora — sem stopPropagation, cada ação abriria
    // a ficha junto.
    expect(adminUserDetail).not.toHaveBeenCalled();
    expect(screen.queryByText("Assinatura")).not.toBeInTheDocument();
  });

  it("erro ao carregar a ficha oferece tentar de novo", async () => {
    mostrar([user()]);
    adminUserDetail.mockRejectedValueOnce(new Error("deu ruim"));
    render(<PageAdminUsers currentUser={{ id: "admin" }} />);

    fireEvent.click(await screen.findByRole("button", { name: /Ficha de Fulano/ }));
    expect(await screen.findByText("deu ruim")).toBeInTheDocument();

    adminUserDetail.mockResolvedValue(ficha());
    fireEvent.click(screen.getByRole("button", { name: /Tentar de novo/ }));
    expect(await screen.findByText("Assinatura")).toBeInTheDocument();
  });
});
