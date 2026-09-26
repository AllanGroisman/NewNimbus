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

// Os avisos específicos ficam atrás de um clique (task 26).
const abrirEspecificos = () => fireEvent.click(screen.getByRole("button", { name: /Avisos específicos/ }));

describe("GroupDashboard — notificações da campanha", () => {
  it("campanha sem preferência: tudo ligado, com os específicos recolhidos", () => {
    renderManage();
    expect(screen.getByRole("switch", { name: "Receber avisos desta campanha" })).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByRole("switch", { name: "Busca de produtos" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Avisos específicos/ })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("5 de 5 ligados")).toBeInTheDocument();
    abrirEspecificos();
    expect(screen.getByRole("switch", { name: "Busca de produtos" })).toHaveAttribute("aria-checked", "true");
  });

  it("desligar a chave geral esconde os específicos e salva enabled=false", () => {
    const { onUpdate } = renderManage();
    abrirEspecificos();
    fireEvent.click(screen.getByRole("switch", { name: "Receber avisos desta campanha" }));
    expect(screen.queryByRole("switch", { name: "Fila vazia" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Avisos específicos/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Nenhum aviso do WhatsNimbus sobre esta campanha/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Salvar alterações/ }));
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate.mock.calls[0][1].scraping.notifications.enabled).toBe(false);
  });

  it("desligar um evento salva só ele, e a contagem acompanha", () => {
    const { onUpdate } = renderManage();
    abrirEspecificos();
    fireEvent.click(screen.getByRole("switch", { name: "Busca de produtos" }));
    expect(screen.getByText("4 de 5 ligados")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Salvar alterações/ }));
    expect(onUpdate.mock.calls[0][1].scraping.notifications).toEqual({ events: { productSearch: false } });
  });

  it("envio instantâneo desliga a fila vazia", () => {
    renderManage({ scraping: { kind: "repasse", autoSend: true } });
    abrirEspecificos();
    const sw = screen.getByRole("switch", { name: "Fila vazia" });
    expect(sw).toBeDisabled();
    expect(sw).toHaveAttribute("aria-checked", "false");
  });

  it("avisa quando a conta está com as notificações desligadas", () => {
    renderManage({ notificationSettings: { enabled: false } });
    expect(screen.getByText(/desligadas na sua conta/)).toBeInTheDocument();
  });
});

// Task 24/26: no repasse, a aprovação automática e a mensagem original moram no
// Gerenciar, junto das fontes e do tempo de espera.
describe("GroupDashboard — Gerenciar do repasse", () => {
  it("nome, fontes e tempo de espera ficam no mesmo cartão", () => {
    renderManage({ scraping: { kind: "repasse" } });
    const info = document.querySelector('[data-tour="mg-info"]');
    expect(info.querySelector('[data-tour="mg-sources"]')).toBeTruthy();
    expect(info.querySelector('[data-tour="mg-cooldown"]')).toBeTruthy();
    expect(info.querySelector("#mg-name")).toBeTruthy();
  });

  it("aprovação automática e mensagem original salvam no Salvar alterações", () => {
    const { onUpdate } = renderManage({ scraping: { kind: "repasse" } });
    fireEvent.click(screen.getByRole("switch", { name: "Aprovação automática" }));
    fireEvent.click(screen.getByRole("switch", { name: "Repassar a mensagem original" }));
    const salvar = screen.getByRole("button", { name: /Salvar alterações/ });
    expect(salvar).not.toBeDisabled();
    fireEvent.click(salvar);
    const sc = onUpdate.mock.calls[0][1].scraping;
    expect(sc.auto).toBe(false);
    expect(sc.repasse.messageMode).toBe("original");
  });

  it("campanha de busca não tem o cartão do repasse", () => {
    renderManage();
    expect(screen.queryByRole("switch", { name: "Aprovação automática" })).not.toBeInTheDocument();
    expect(document.querySelector('[data-tour="mg-sources"]')).toBeNull();
  });
});
