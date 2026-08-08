// Card de campanha no painel: o estado "pausada por falta de janela de envio"
// precisa aparecer como pausa e o botão precisa dizer o que ele faz de verdade
// (abrir a aba Janelas de envio — ele não ativa a campanha sozinho).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import PageDashboard from "../pages/Dashboard.jsx";

function makeGroup(overrides = {}) {
  return {
    id: 1,
    name: "Campanha Teste",
    paused: false,
    categories: ["gamer"],
    whatsappGroupIds: ["wa-1"],
    scraping: { auto: true, sources: ["Amazon"], filters: {} },
    schedule: { windows: [{ id: 1, from: "08:00", to: "22:00", interval: 30 }], cooldownValue: 24, cooldownUnit: "horas" },
    queue: [],
    pending: [],
    history: [],
    sentToday: 0, sentWeek: 0, weekData: [0, 0, 0, 0, 0, 0, 0],
    lastSend: "—", avgDiscount: "—",
    ...overrides,
  };
}

function renderDashboard(groupOver = {}) {
  const props = {
    groups: [makeGroup(groupOver)],
    whatsappGroups: [{ id: "wa-1", name: "Grupo", numberId: "n1", jid: "g@g.us", status: "connected", members: 10 }],
    onSelectGroup: vi.fn(),
    onCreateGroup: vi.fn(),
    onUpdate: vi.fn(),
    affiliateConfigured: { ml: true, amazon: true, shopee: true },
    onGoToSettings: vi.fn(),
  };
  render(<PageDashboard {...props} />);
  return props;
}

describe("PageDashboard — campanha sem janela de envio", () => {
  beforeEach(() => localStorage.clear());

  it("mostra o selo de pausada e o botão vira 'Adicionar janela'", () => {
    const props = renderDashboard({ schedule: { windows: [], cooldownValue: 24, cooldownUnit: "horas" } });

    expect(screen.getByText(/Pausada · sem janela de envio/)).toBeInTheDocument();
    const btn = screen.getByRole("button", { name: /Adicionar janela/ });
    expect(btn).toBeInTheDocument();

    // Clicar abre a campanha já na aba onde a janela é criada, sem pausar/retomar nada.
    fireEvent.click(btn);
    expect(props.onSelectGroup).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
    expect(props.onUpdate).not.toHaveBeenCalled();
    expect(localStorage.getItem("nimbus:campaignTab")).toMatch(/schedule/);
  });

  it("com janela configurada o botão continua sendo 'Pausar'", () => {
    renderDashboard();
    expect(screen.queryByText(/sem janela de envio/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Pausar/ })).toBeInTheDocument();
  });
});
