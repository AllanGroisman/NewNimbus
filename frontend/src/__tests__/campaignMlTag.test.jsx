// Etiqueta do ML por campanha (task 5): select na aba Gerenciar que grava em
// scraping.mlTag. As opções são as etiquetas da conta (aba Mercado Livre);
// vazio = a padrão da conta.

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

const TAGS = [
  { tag: "allangroisman", inUse: true, createdAt: null },
  { tag: "grupo-ofertas", inUse: false, createdAt: null },
];

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

function renderManage({ scraping, mlTags = TAGS, ml = true } = {}) {
  const onUpdate = vi.fn();
  const onGoToAffiliate = vi.fn();
  render(<GroupDashboard
    group={makeGroup(scraping)} numbers={[]} whatsappGroups={[]}
    affiliateStatus={{ ml, amazon: true, shopee: true, mlTags, mlDefaultTag: mlTags[0]?.tag || null }}
    storeLocks={{}}
    onBack={vi.fn()} onUpdate={onUpdate} onDelete={vi.fn()}
    onCreateWhatsappGroup={vi.fn()} onDeleteWhatsappGroup={vi.fn()} onUpdateWhatsappGroup={vi.fn()}
    onGoToAffiliate={onGoToAffiliate} onGoToSettings={vi.fn()}
  />);
  fireEvent.click(screen.getByRole("button", { name: /^Gerenciar$/ }));
  return { onUpdate, onGoToAffiliate };
}

const select = () => screen.getByRole("combobox", { name: "Etiqueta do Mercado Livre" });

beforeEach(() => { try { localStorage.clear(); } catch { /* ignore */ } });

describe("GroupDashboard — etiqueta do Mercado Livre", () => {
  it("campanha sem escolha mostra a padrão da conta e as etiquetas", () => {
    renderManage();
    expect(select().value).toBe("");
    expect(screen.getByRole("option", { name: "Padrão da conta (allangroisman)" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "grupo-ofertas" })).toBeInTheDocument();
  });

  it("escolher e salvar grava em scraping.mlTag", () => {
    const { onUpdate } = renderManage();
    fireEvent.change(select(), { target: { value: "grupo-ofertas" } });
    fireEvent.click(screen.getByRole("button", { name: /Salvar alterações/ }));
    expect(onUpdate).toHaveBeenCalledWith(1, expect.objectContaining({
      scraping: expect.objectContaining({ mlTag: "grupo-ofertas" }),
    }));
  });

  it("voltar pra padrão tira o mlTag", () => {
    const { onUpdate } = renderManage({ scraping: { mlTag: "grupo-ofertas" } });
    expect(select().value).toBe("grupo-ofertas");
    fireEvent.change(select(), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /Salvar alterações/ }));
    const scraping = onUpdate.mock.calls.at(-1)[1].scraping;
    expect(scraping.mlTag).toBeUndefined();
  });

  it("etiqueta que sumiu da conta: avisa que sai com a padrão", () => {
    renderManage({ scraping: { mlTag: "apagada" } });
    expect(screen.getByText(/não está mais na sua conta do Mercado Livre/)).toBeInTheDocument();
    expect(select().value).toBe("apagada");
  });

  it("sem a lista carregada, aponta pra aba Mercado Livre", () => {
    const { onGoToAffiliate } = renderManage({ mlTags: [] });
    expect(screen.queryByRole("combobox", { name: "Etiqueta do Mercado Livre" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Abrir Mercado Livre" }));
    expect(onGoToAffiliate).toHaveBeenCalledWith("ml");
  });

  it("campanha sem ML não mostra a escolha", () => {
    renderManage({ scraping: { sources: ["Amazon"] } });
    expect(screen.queryByText("Etiqueta do Mercado Livre")).not.toBeInTheDocument();
  });

  it("ML sem afiliado configurado não mostra a escolha", () => {
    renderManage({ ml: false });
    expect(screen.queryByText("Etiqueta do Mercado Livre")).not.toBeInTheDocument();
  });
});
