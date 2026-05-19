// Smoke tests do GroupDashboard — foca no botão pausar/retomar que ficou no header
// (recém-movido pra ser visível em todas as abas). Não cobre toda a UI, só os
// pontos críticos que mudaram recentemente.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// Mock dos imports de api antes de importar o componente
vi.mock("../data/api", () => ({
  createWAGroup: vi.fn(),
  leaveWAGroup: vi.fn(),
  revokeWAInvite: vi.fn(),
  sendNextNow: vi.fn(),
  loadAppOps: vi.fn().mockResolvedValue({ groups: [] }),
  listWAGroups: vi.fn().mockResolvedValue([]),
  refillQueueNow: vi.fn(),
  clearGroupHistory: vi.fn(),
  approvePendingItem: vi.fn(),
  rejectPendingItem: vi.fn(),
  fetchUrlMetadata: vi.fn(),
  manualAddToQueue: vi.fn(),
}));

import GroupDashboard from "../components/GroupDashboard.jsx";

function makeGroup(overrides = {}) {
  return {
    id: 1,
    name: "Campanha Teste",
    paused: false,
    categories: ["gamer"],
    whatsappGroupIds: [],
    messageTemplate: "{produto} por {preco}",
    scraping: { auto: true, sources: ["Amazon"], filters: {} },
    schedule: { windows: [{ from: "08:00", to: "22:00", interval: 30 }], cooldownValue: 24, cooldownUnit: "horas" },
    queue: [],
    pending: [],
    history: [],
    sentToday: 0, sentWeek: 0, weekData: [0,0,0,0,0,0,0],
    lastSend: "—", avgDiscount: "—",
    ...overrides,
  };
}

function renderDashboard(overrides = {}) {
  const { group: groupOver, ...rest } = overrides;
  const props = {
    group: makeGroup(groupOver),
    numbers: [],
    whatsappGroups: [],
    affiliateConfigured: { ml: true, amazon: true, shopee: true },
    affiliateStatus: { ml: { configured: true }, amazon: { configured: true }, shopee: { configured: true } },
    onBack: vi.fn(),
    onUpdate: vi.fn(),
    onDelete: vi.fn(),
    onCreateWhatsappGroup: vi.fn(),
    onDeleteWhatsappGroup: vi.fn(),
    onUpdateWhatsappGroup: vi.fn(),
    onGoToAffiliate: vi.fn(),
    onGoToSettings: vi.fn(),
    ...rest,
  };
  return { props, ...render(<GroupDashboard {...props} />) };
}

describe("GroupDashboard — botão pausar/retomar no header", () => {
  it("mostra '⏸ Pausar' quando group.paused=false", () => {
    renderDashboard();
    expect(screen.getByRole("button", { name: /Pausar/ })).toBeInTheDocument();
  });

  it("mostra '▶ Retomar' quando group.paused=true", () => {
    renderDashboard({ group: { paused: true } });
    // Tanto o botão do header quanto o banner mostram "Retomar"
    expect(screen.getAllByRole("button", { name: /Retomar/ }).length).toBeGreaterThan(0);
  });

  it("clicar 'Pausar' abre modal de confirmação (não chama onUpdate direto)", () => {
    const { props } = renderDashboard();
    fireEvent.click(screen.getByRole("button", { name: /Pausar/ }));
    expect(screen.getByText(/Pausar campanha\?/i)).toBeInTheDocument();
    expect(props.onUpdate).not.toHaveBeenCalled();
  });

  it("confirmar pausa no modal chama onUpdate com paused=true", async () => {
    const { props } = renderDashboard();
    fireEvent.click(screen.getByRole("button", { name: /Pausar/ }));
    fireEvent.click(screen.getByRole("button", { name: /Sim, pausar/i }));
    await waitFor(() => expect(props.onUpdate).toHaveBeenCalledWith(1, { paused: true }));
  });

  it("clicar 'Retomar' do header chama onUpdate(id, { paused: false }) direto, sem modal", () => {
    const { props } = renderDashboard({ group: { paused: true } });
    // O do header é o primeiro em DOM order
    const btn = screen.getAllByRole("button", { name: /Retomar/ })[0];
    fireEvent.click(btn);
    expect(props.onUpdate).toHaveBeenCalledWith(1, { paused: false });
  });
});

describe("GroupDashboard — header sempre visível independente da aba", () => {
  it("botão pausar continua visível depois de trocar pra aba 'Gerenciar'", () => {
    renderDashboard();
    expect(screen.getByRole("button", { name: /Pausar/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Gerenciar/ }));
    // Mesmo botão (no header) continua presente
    expect(screen.getByRole("button", { name: /Pausar/ })).toBeInTheDocument();
  });

  it("botão pausar continua visível depois de trocar pra aba 'Histórico'", () => {
    renderDashboard();
    fireEvent.click(screen.getByRole("button", { name: /Histórico/ }));
    expect(screen.getByRole("button", { name: /Pausar/ })).toBeInTheDocument();
  });
});

describe("GroupDashboard — banners de pausa", () => {
  it("group.paused=true mostra badge 'Pausada' no header", () => {
    renderDashboard({ group: { paused: true } });
    // Badge "Pausada" no header
    expect(screen.getByText(/^Pausada$/)).toBeInTheDocument();
    // Texto-âncora do banner (RTL: getByText procura em elementos folha,
    // o trecho "pausada manualmente" tá dentro de <strong>)
    expect(screen.getByText("pausada manualmente")).toBeInTheDocument();
  });

  it("ML não configurado + grupo usa ML → mostra botão 'Configurar Mercado Livre'", () => {
    renderDashboard({
      group: { paused: false, scraping: { auto: true, sources: ["Mercado Livre"], filters: {} } },
      // Quando affiliateStatus é null, componente cai pro affiliateConfigured (booleano legado).
      affiliateStatus: null,
      affiliateConfigured: false,
    });
    expect(screen.getByRole("button", { name: /Configurar Mercado Livre/i })).toBeInTheDocument();
  });
});

describe("GroupDashboard — voltar", () => {
  it("clicar 'Voltar' chama onBack", () => {
    const { props } = renderDashboard();
    fireEvent.click(screen.getByText(/Voltar/));
    expect(props.onBack).toHaveBeenCalled();
  });
});
