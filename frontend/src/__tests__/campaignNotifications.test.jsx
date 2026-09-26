// Avisos por campanha (task 23): card na aba Gerenciar que grava em
// scraping.notifications e só silencia o que a conta já manda.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("../data/api", () => ({
  // errText é helper puro (não faz rede) — usa a implementação de verdade.
  errText: (err, fallback) => err?.message || fallback,
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
  clearGroupQueue: vi.fn(),
  saveGroupQueue: vi.fn(),
  approveAllPending: vi.fn(),
  rejectAllPending: vi.fn(),
  browseCatalog: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 24 }),
}));

import GroupDashboard from "../components/GroupDashboard.jsx";

function makeGroup(scraping = {}) {
  return {
    id: 1, name: "Campanha Teste", paused: false, categories: ["gamer"], whatsappGroupIds: [],
    messageTemplate: "{produto} por {preco}",
    scraping: { auto: true, sources: ["Mercado Livre"], filters: {}, ...scraping },
    schedule: { windows: [{ from: "08:00", to: "22:00", interval: 30 }], cooldownValue: 24, cooldownUnit: "horas" },
    queue: [], pending: [], history: [],
    sentToday: 0, sentWeek: 0, weekData: [0, 0, 0, 0, 0, 0, 0], lastSend: "—", avgDiscount: "—",
  };
}

function renderManage({ scraping, notificationSettings = { enabled: true, events: {} } } = {}) {
  const onUpdate = vi.fn();
  render(<GroupDashboard
    group={makeGroup(scraping)} numbers={[]} whatsappGroups={[]}
    affiliateConfigured={{ ml: true, amazon: true, shopee: true }}
    affiliateStatus={{ ml: { configured: true }, amazon: { configured: true }, shopee: { configured: true } }}
    storeLocks={{}} notificationSettings={notificationSettings}
    onBack={vi.fn()} onUpdate={onUpdate} onDelete={vi.fn()}
    onCreateWhatsappGroup={vi.fn()} onDeleteWhatsappGroup={vi.fn()} onUpdateWhatsappGroup={vi.fn()}
    onGoToAffiliate={vi.fn()} onGoToSettings={vi.fn()}
  />);
  fireEvent.click(screen.getByRole("button", { name: /^Gerenciar$/ }));
  return { onUpdate };
}

beforeEach(() => { try { localStorage.clear(); } catch { /* ignore */ } });

describe("GroupDashboard — notificações da campanha", () => {
  it("campanha sem preferência: tudo ligado", () => {
    renderManage();
    expect(screen.getByRole("switch", { name: "Receber avisos desta campanha" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("switch", { name: "Busca de produtos" })).toHaveAttribute("aria-checked", "true");
  });

  it("desligar a chave geral trava os eventos e salva enabled=false", () => {
    const { onUpdate } = renderManage();
    fireEvent.click(screen.getByRole("switch", { name: "Receber avisos desta campanha" }));
    expect(screen.getByRole("switch", { name: "Fila vazia" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /Salvar alterações/ }));
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate.mock.calls[0][1].scraping.notifications.enabled).toBe(false);
  });

  it("desligar um evento salva só ele", () => {
    const { onUpdate } = renderManage();
    fireEvent.click(screen.getByRole("switch", { name: "Busca de produtos" }));
    fireEvent.click(screen.getByRole("button", { name: /Salvar alterações/ }));
    expect(onUpdate.mock.calls[0][1].scraping.notifications).toEqual({ events: { productSearch: false } });
  });

  it("envio instantâneo desliga a fila vazia", () => {
    renderManage({ scraping: { kind: "repasse", autoSend: true } });
    const sw = screen.getByRole("switch", { name: "Fila vazia" });
    expect(sw).toBeDisabled();
    expect(sw).toHaveAttribute("aria-checked", "false");
  });

  it("avisa quando a conta está com as notificações desligadas", () => {
    renderManage({ notificationSettings: { enabled: false } });
    expect(screen.getByText(/desligadas na sua conta/)).toBeInTheDocument();
  });
});
