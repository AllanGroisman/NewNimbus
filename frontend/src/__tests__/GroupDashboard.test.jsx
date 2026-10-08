// Smoke tests do GroupDashboard — foca no botão pausar/retomar que ficou no header
// (recém-movido pra ser visível em todas as abas). Não cobre toda a UI, só os
// pontos críticos que mudaram recentemente.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

// Mock dos imports de api antes de importar o componente
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
  getWAGroupPicture: vi.fn().mockResolvedValue({ url: null }),
  getWAInvite: vi.fn().mockResolvedValue({ inviteLink: "https://chat.whatsapp.com/ABC" }),
  getWAGroupDescription: vi.fn().mockResolvedValue({ description: "Regras do grupo" }),
  setWAGroupDescription: vi.fn().mockResolvedValue({ ok: true }),
  listDmBroadcasts: vi.fn().mockResolvedValue({ broadcasts: [] }),
  startDmBroadcast: vi.fn(),
  cancelDmBroadcast: vi.fn(),
}));

import GroupDashboard from "../components/GroupDashboard.jsx";
import { createWAGroup, fetchUrlMetadata, listWAGroups, getWAInvite, getWAGroupPicture, getWAGroupDescription, setWAGroupDescription, listDmBroadcasts, startDmBroadcast, cancelDmBroadcast } from "../data/api";

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

// A aba Grupos (tasks 24 e 25): cartões iguais para origem e destino, com as
// ações atrás do "⋯", e o popup de adicionar que escolhe o WhatsApp e depois o grupo.
const abrirMenu = (nome) => fireEvent.click(screen.getByRole("button", { name: `Mais ações — ${nome}` }));
const itemDoMenu = (nome) => screen.getByRole("menuitem", { name: nome });

// Mensagem no privado para os membros (tasks 4 e 6): só admin vê, o popup manda
// o grupo certo para a API e fecha, e o andamento fica no cartão de cada grupo.
describe("GroupDashboard — mensagem no privado (aba Grupos)", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => listDmBroadcasts.mockResolvedValue({ broadcasts: [] }));

  function renderGrupos(extra = {}) {
    const r = renderDashboard({
      group: { whatsappGroupIds: ["wg-1", "wg-2"] },
      numbers: [{ id: "num-1", label: "Número 1", phone: "5511999999999", status: "connected" }],
      whatsappGroups: [
        { id: "wg-1", name: "Grupo Um", numberId: "num-1", members: 5, jid: "wg-1" },
        { id: "wg-2", name: "Grupo Dois", numberId: "num-1", members: 3, jid: "wg-2" },
      ],
      ...extra,
    });
    fireEvent.click(screen.getByRole("button", { name: /Grupos/ }));
    return r;
  }
  const parte = (whatsappGroupId, extra = {}) => ({ whatsappGroupId, numberId: "num-1", total: 40, sent: 12, failed: 0, canceled: 0, pending: 28, fase: "sending", nextAt: null, motivo: null, ...extra });
  const faixas = () => screen.getAllByRole("status", { name: "Mensagem no privado" });

  it("usuário comum não vê nem o item do ⋯ nem o botão geral", () => {
    renderGrupos();
    abrirMenu("Grupo Um");
    expect(screen.queryByRole("menuitem", { name: /Mensagem no privado/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Mensagem a todos/ })).not.toBeInTheDocument();
    expect(listDmBroadcasts).not.toHaveBeenCalled();
  });

  it("admin: o ⋯ envia só para aquele grupo, o popup fecha e o cartão mostra o andamento", async () => {
    const novo = { id: "9", status: "preparing", total: 0, sent: 0, failed: 0, text: "Oi!", grupos: [parte("wg-1", { fase: "preparing", total: 0, sent: 0, pending: 0 })] };
    startDmBroadcast.mockResolvedValue({ broadcast: novo });
    listDmBroadcasts.mockResolvedValueOnce({ broadcasts: [] }).mockResolvedValue({ broadcasts: [novo] });
    renderGrupos({ isAdmin: true });
    abrirMenu("Grupo Um");
    fireEvent.click(itemDoMenu("✉ Mensagem no privado aos membros"));
    expect(screen.getByText(/Até ~4 pessoas/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Mensagem" }), { target: { value: "Oi!" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar no privado" }));
    await waitFor(() => expect(startDmBroadcast).toHaveBeenCalledWith(1, { whatsappGroupIds: ["wg-1"], text: "Oi!" }));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Mensagem" })).not.toBeInTheDocument());
    expect(screen.getByText(/começou em segundo plano/)).toBeInTheDocument();
    await waitFor(() => expect(faixas()).toHaveLength(1));
    expect(faixas()[0]).toHaveTextContent(/Montando a lista de membros/);
  });

  it("admin: o botão geral manda para todos os destinos (sem lista)", async () => {
    startDmBroadcast.mockResolvedValue({ broadcast: { id: "10", status: "preparing", total: 0, sent: 0, failed: 0, text: "Oi", grupos: [] } });
    renderGrupos({ isAdmin: true });
    fireEvent.click(screen.getByRole("button", { name: /Mensagem a todos/ }));
    expect(screen.getByText(/Todos os 2 grupos destino/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Mensagem" }), { target: { value: "Oi" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar no privado" }));
    await waitFor(() => expect(startDmBroadcast).toHaveBeenCalledWith(1, { whatsappGroupIds: undefined, text: "Oi" }));
  });

  it("admin: cada cartão mostra a parte dele; o ⋯ trava e o cancelar para só aquele grupo", async () => {
    cancelDmBroadcast.mockResolvedValue({ broadcast: {} });
    listDmBroadcasts.mockResolvedValue({ broadcasts: [{
      id: "7", status: "running", total: 60, sent: 20, failed: 0, text: "Oi",
      grupos: [parte("wg-1"), parte("wg-2", { total: 20, sent: 8, pending: 12, fase: "waiting", nextAt: new Date().toISOString(), motivo: "número desconectado" })],
    }] });
    renderGrupos({ isAdmin: true });
    await waitFor(() => expect(faixas()).toHaveLength(2));
    expect(faixas()[0]).toHaveTextContent(/12 de 40.*Enviando…/);
    expect(faixas()[1]).toHaveTextContent(/8 de 20.*Aguardando até .*número desconectado/);

    abrirMenu("Grupo Um");
    expect(itemDoMenu("✉ Mensagem no privado aos membros")).toBeDisabled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("button", { name: /Mensagem a todos/ })).toBeDisabled();

    fireEvent.click(within(faixas()[0]).getByRole("button", { name: "Cancelar" }));
    expect(screen.getByText(/Os outros grupos deste envio continuam/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar envio" }));
    await waitFor(() => expect(cancelDmBroadcast).toHaveBeenCalledWith(1, "7", "wg-1"));
  });
});

describe("GroupDashboard — remover grupo destino (aba Grupos)", () => {
  // Setup: campanha com 1 grupo de WhatsApp vinculado, na aba "Grupos".
  function renderWithLinkedGroup(extra = {}) {
    const r = renderDashboard({
      group: { whatsappGroupIds: ["wg-1"] },
      numbers: [{ id: "num-1", label: "Número 1", phone: "5511999999999", status: "connected" }],
      whatsappGroups: [{ id: "wg-1", name: "Grupo Vinculado", numberId: "num-1", members: 5, jid: "wg-1", ...extra }],
    });
    fireEvent.click(screen.getByRole("button", { name: /Grupos/ })); // vai pra aba
    return r;
  }

  it("o cartão mostra o WhatsApp de origem, a conexão e os membros", () => {
    renderWithLinkedGroup();
    const destino = within(screen.getByRole("region", { name: "Grupos Destino" }));
    expect(destino.getByText("Grupo Vinculado")).toBeInTheDocument();
    expect(destino.getByText("Conectado")).toBeInTheDocument();
    expect(destino.getByText(/Número 1/)).toBeInTheDocument();
    expect(destino.getByText(/5 membros/)).toBeInTheDocument();
  });

  it("remover fica no ⋯ e pede confirmação (não desvincula direto)", () => {
    const { props } = renderWithLinkedGroup();
    expect(screen.queryByRole("button", { name: /^Desvincular$/ })).not.toBeInTheDocument();
    abrirMenu("Grupo Vinculado");
    fireEvent.click(itemDoMenu("Remover da campanha"));
    expect(screen.getByText(/Remover grupo da campanha\?/i)).toBeInTheDocument();
    expect(props.onUpdate).not.toHaveBeenCalled(); // ainda não mexeu no estado
  });

  it("confirmar no modal chama onUpdate removendo o grupo dos vinculados", () => {
    const { props } = renderWithLinkedGroup();
    abrirMenu("Grupo Vinculado");
    fireEvent.click(itemDoMenu("Remover da campanha"));
    fireEvent.click(screen.getByRole("button", { name: /^Remover$/ }));
    expect(props.onUpdate).toHaveBeenCalledWith(1, { whatsappGroupIds: [] });
  });

  it("copiar o link de convite busca o link quando o grupo ainda não tem", async () => {
    const { props } = renderWithLinkedGroup();
    abrirMenu("Grupo Vinculado");
    fireEvent.click(itemDoMenu("🔗 Copiar link de convite"));
    await waitFor(() => expect(getWAInvite).toHaveBeenCalledWith("num-1", "wg-1"));
    expect(props.onUpdateWhatsappGroup).toHaveBeenCalledWith("wg-1", { inviteLink: "https://chat.whatsapp.com/ABC" });
    expect(await screen.findByText(/Link de convite de "Grupo Vinculado" copiado/)).toBeInTheDocument();
  });

  it("a duplicação automática liga e desliga pelo ⋯", () => {
    const { props } = renderWithLinkedGroup();
    abrirMenu("Grupo Vinculado");
    const item = screen.getByRole("menuitemcheckbox", { name: /Duplicar automaticamente quando encher/ });
    expect(item).toHaveAttribute("aria-checked", "false");
    fireEvent.click(item);
    expect(props.onUpdateWhatsappGroup).toHaveBeenCalledWith("wg-1", { autoDuplicate: true });
  });

  it("grupo com a duplicação ligada ganha o selo; o que já duplicou avisa", () => {
    renderWithLinkedGroup({ autoDuplicate: true });
    expect(screen.getByText(/Duplica ao encher/)).toBeInTheDocument();
  });

  // Task 3: a descrição é a do grupo no WhatsApp, num popup — não mais uma nota
  // do Nimbus editada dentro do cartão.
  it("'Editar descrição' abre o popup com a descrição do WhatsApp e grava a cópia local", async () => {
    const { props } = renderWithLinkedGroup({ description: "antiga" });
    expect(screen.getByText("antiga")).toBeInTheDocument();
    abrirMenu("Grupo Vinculado");
    fireEvent.click(itemDoMenu("✎ Editar descrição"));
    await waitFor(() => expect(screen.getByLabelText("Descrição do grupo")).toHaveValue("Regras do grupo"));
    expect(getWAGroupDescription).toHaveBeenCalledWith("num-1", "wg-1");
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(setWAGroupDescription).toHaveBeenCalledWith("num-1", "wg-1", "Regras do grupo"));
    await waitFor(() => expect(props.onUpdateWhatsappGroup).toHaveBeenCalledWith("wg-1", { description: "Regras do grupo" }));
    expect(await screen.findByText(/Descrição de "Grupo Vinculado" salva no WhatsApp/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Descrição do grupo")).not.toBeInTheDocument();
  });

  it("'Duplicar grupo' abre a criação com o nome base e o próximo número da série", () => {
    renderWithLinkedGroup();
    abrirMenu("Grupo Vinculado");
    fireEvent.click(itemDoMenu("⎘ Duplicar grupo"));
    expect(screen.getByLabelText("Nome do grupo")).toHaveValue("Grupo Vinculado");
    expect(screen.getByLabelText("Número")).toHaveValue(2);
    expect(screen.getByText("Grupo Vinculado #2")).toBeInTheDocument();
  });

  it("'Duplicar grupo' de um '#1' soma 1 (não repete o nome)", () => {
    renderWithLinkedGroup({ name: "Ofertas Tech #1" });
    abrirMenu("Ofertas Tech #1");
    fireEvent.click(itemDoMenu("⎘ Duplicar grupo"));
    expect(screen.getByLabelText("Nome do grupo")).toHaveValue("Ofertas Tech");
    expect(screen.getByLabelText("Número")).toHaveValue(2);
  });
});

describe("GroupDashboard — foto do grupo", () => {
  it("mostra a miniatura do WhatsApp; sem foto, as iniciais", async () => {
    getWAGroupPicture.mockImplementation(async (numberId, jid) => ({ url: jid === "foto@g.us" ? "https://pps.whatsapp.net/foto.jpg" : null }));
    const { container } = renderDashboard({
      group: { whatsappGroupIds: ["foto@g.us", "semfoto@g.us"] },
      numbers: [{ id: "num-1", label: "Número 1", status: "connected" }],
      whatsappGroups: [
        { id: "foto@g.us", name: "Com Foto", numberId: "num-1" },
        { id: "semfoto@g.us", name: "Sem Foto Aqui", numberId: "num-1" },
      ],
    });
    fireEvent.click(screen.getByRole("button", { name: /Grupos/ }));
    await waitFor(() => expect(container.querySelector('img[src="https://pps.whatsapp.net/foto.jpg"]')).toBeTruthy());
    expect(getWAGroupPicture).toHaveBeenCalledWith("num-1", "semfoto@g.us");
    expect(screen.getByText("SF")).toBeInTheDocument();
  });
});

describe("GroupDashboard — adicionar grupo destino (WhatsApp → grupo)", () => {
  // O happy-dom tem IntersectionObserver, mas ele nunca avisa: aqui toda linha
  // "aparece" assim que é observada.
  beforeEach(() => {
    vi.stubGlobal("IntersectionObserver", class {
      constructor(cb) { this.cb = cb; }
      observe(el) { this.cb([{ isIntersecting: true, target: el }]); }
      disconnect() {}
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  function abrir(extra = {}) {
    const r = renderDashboard({
      numbers: [
        { id: "num-1", label: "Número 1", phone: "5511999999999", status: "connected" },
        { id: "num-2", label: "Número 2", phone: "5511888888888", status: "disconnected" },
      ],
      ...extra,
    });
    fireEvent.click(screen.getByRole("button", { name: /Grupos/ }));
    fireEvent.click(screen.getByRole("button", { name: "Adicionar grupo destino" }));
    return r;
  }

  it("primeiro o WhatsApp (desconectado não entra), depois os grupos dele", async () => {
    listWAGroups.mockResolvedValueOnce([{ jid: "g1@g.us", name: "Grupo Um", members: 12, description: "Regras do Um" }]);
    const { props } = abrir();
    expect(screen.getByRole("button", { name: /Número 2/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /Número 1/ }));
    await waitFor(() => expect(listWAGroups).toHaveBeenCalledWith("num-1"));
    fireEvent.click(await screen.findByRole("button", { name: /Grupo Um/ }));
    // A descrição do WhatsApp já vem junto: o cartão mostra antes de abrir o popup.
    await waitFor(() => expect(props.onCreateWhatsappGroup).toHaveBeenCalledWith(expect.objectContaining({ id: "g1@g.us", name: "Grupo Um", numberId: "num-1", description: "Regras do Um" })));
  });

  it("a lista do popup mostra a foto de cada grupo", async () => {
    getWAGroupPicture.mockImplementation(async (numberId, jid) => ({ url: jid === "popfoto@g.us" ? "https://pps.whatsapp.net/pop.jpg" : null }));
    listWAGroups.mockResolvedValueOnce([
      { jid: "popfoto@g.us", name: "Grupo Foto", members: 3 },
      { jid: "popsem@g.us", name: "Outro Grupo", members: 5 },
    ]);
    const { container } = abrir();
    fireEvent.click(screen.getByRole("button", { name: /Número 1/ }));
    await waitFor(() => expect(container.ownerDocument.querySelector('img[src="https://pps.whatsapp.net/pop.jpg"]')).toBeTruthy());
    expect(getWAGroupPicture).toHaveBeenCalledWith("num-1", "popsem@g.us");
    expect(screen.getByText("OG")).toBeInTheDocument();
  });

  it("com muitos grupos, no máximo 4 fotos são pedidas ao mesmo tempo", async () => {
    const pendentes = [];
    let maxAndando = 0;
    getWAGroupPicture.mockImplementation(() => new Promise(resolve => {
      pendentes.push(resolve);
      maxAndando = Math.max(maxAndando, pendentes.length);
    }));
    listWAGroups.mockResolvedValueOnce(Array.from({ length: 10 }, (_, i) => ({ jid: `fila${i}@g.us`, name: `Fila ${i}`, members: 1 })));
    abrir();
    fireEvent.click(screen.getByRole("button", { name: /Número 1/ }));
    await screen.findByRole("button", { name: /Fila 9/ });
    let atendidos = 0;
    while (atendidos < 10) {
      await waitFor(() => expect(pendentes.length).toBeGreaterThan(0));
      expect(pendentes.length).toBeLessThanOrEqual(4);
      const lote = pendentes.splice(0);
      atendidos += lote.length;
      lote.forEach(r => r({ url: null }));
    }
    expect(maxAndando).toBe(4);
    expect(getWAGroupPicture.mock.calls.filter(([, jid]) => jid.startsWith("fila")).length).toBe(10);
  });
});

describe("GroupDashboard — criar grupo com envio só para admins", () => {
  // Abre o popup, escolhe o WhatsApp e vai em "criar grupo novo".
  async function abrirCriacao() {
    const rendered = renderDashboard({
      numbers: [{ id: "num-1", label: "Número 1", phone: "5511999999999", status: "connected" }],
    });
    fireEvent.click(screen.getByRole("button", { name: /Grupos/ }));
    fireEvent.click(screen.getByRole("button", { name: /Adicionar primeiro grupo/ }));
    fireEvent.click(screen.getByRole("button", { name: /Número 1/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Criar grupo novo neste WhatsApp/ }));
    fireEvent.change(screen.getByPlaceholderText(/Regional/), { target: { value: "Grupo Novo" } });
    return rendered;
  }

  it("adminOnly=false mantém o modal aberto com aviso pra ajustar na mão", async () => {
    createWAGroup.mockResolvedValue({
      jid: "wg-novo@g.us", name: "Grupo Novo", inviteLink: null, adminOnly: false, participants: [],
    });
    await abrirCriacao();
    fireEvent.click(screen.getByRole("button", { name: /Criar e vincular/ }));

    await waitFor(() => expect(screen.getByText(/só para admins/i)).toBeInTheDocument());
    // Modal continua aberto pro usuário ler o aviso
    expect(screen.getByPlaceholderText(/Regional/)).toBeInTheDocument();
  });

  it("adminOnly=true fecha o modal sem aviso e vincula o grupo", async () => {
    createWAGroup.mockResolvedValue({
      jid: "wg-novo@g.us", name: "Grupo Novo", inviteLink: null, adminOnly: true, participants: [],
    });
    const { props } = await abrirCriacao();
    fireEvent.click(screen.getByRole("button", { name: /Criar e vincular/ }));

    await waitFor(() => expect(screen.queryByPlaceholderText(/Regional/)).not.toBeInTheDocument());
    expect(screen.queryByText(/só para admins/i)).not.toBeInTheDocument();
    expect(createWAGroup).toHaveBeenCalledWith("num-1", "Grupo Novo #1", []);
    expect(props.onCreateWhatsappGroup).toHaveBeenCalledWith(expect.objectContaining({ id: "wg-novo@g.us", numberId: "num-1" }));
  });
});

// Task 6: o nome sai "Nome #N" — o número começa em 1 e pode ser trocado.
describe("GroupDashboard — número do grupo na criação", () => {
  beforeEach(() => vi.clearAllMocks());

  async function abrirCriacao() {
    createWAGroup.mockResolvedValue({ jid: "wg-novo@g.us", name: "x", inviteLink: null, adminOnly: true, participants: [] });
    renderDashboard({
      numbers: [{ id: "num-1", label: "Número 1", phone: "5511999999999", status: "connected" }],
    });
    fireEvent.click(screen.getByRole("button", { name: /Grupos/ }));
    fireEvent.click(screen.getByRole("button", { name: /Adicionar primeiro grupo/ }));
    fireEvent.click(screen.getByRole("button", { name: /Número 1/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Criar grupo novo neste WhatsApp/ }));
    fireEvent.change(screen.getByLabelText("Nome do grupo"), { target: { value: "Ofertas Tech" } });
  }
  const criar = () => fireEvent.click(screen.getByRole("button", { name: /Criar e vincular/ }));

  it("vem com 1 e mostra como o nome vai ficar", async () => {
    await abrirCriacao();
    expect(screen.getByLabelText("Número")).toHaveValue(1);
    expect(screen.getByText("Ofertas Tech #1")).toBeInTheDocument();
  });

  it("número trocado vai no nome", async () => {
    await abrirCriacao();
    fireEvent.change(screen.getByLabelText("Número"), { target: { value: "7" } });
    criar();
    await waitFor(() => expect(createWAGroup).toHaveBeenCalledWith("num-1", "Ofertas Tech #7", []));
  });

  it("número vazio cria só com o nome", async () => {
    await abrirCriacao();
    fireEvent.change(screen.getByLabelText("Número"), { target: { value: "" } });
    criar();
    await waitFor(() => expect(createWAGroup).toHaveBeenCalledWith("num-1", "Ofertas Tech", []));
  });

  it("número inválido trava o botão", async () => {
    await abrirCriacao();
    fireEvent.change(screen.getByLabelText("Número"), { target: { value: "0" } });
    expect(screen.getByRole("button", { name: /Criar e vincular/ })).toBeDisabled();
    expect(screen.getByText(/inteiro, a partir de 1/)).toBeInTheDocument();
  });

  it("'#N' digitado no nome vai pro campo Número", async () => {
    await abrirCriacao();
    const nome = screen.getByLabelText("Nome do grupo");
    fireEvent.change(nome, { target: { value: "Ofertas Tech #3" } });
    fireEvent.blur(nome);
    expect(nome).toHaveValue("Ofertas Tech");
    expect(screen.getByLabelText("Número")).toHaveValue(3);
  });
});

describe("GroupDashboard — fila vazia no modo repasse", () => {
  it("mostra mensagem/botão de repasse (Grupos), não de Busca de Produtos", () => {
    renderDashboard({
      group: { scraping: { kind: "repasse", sources: [], filters: {} }, queue: [] },
    });
    fireEvent.click(screen.getByRole("button", { name: /Fila/ })); // aba Fila

    expect(screen.getByText(/grupos de origem/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Ir para Grupos/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Ir para Busca de Produtos/i })).not.toBeInTheDocument();
  });
});

describe("GroupDashboard — grupos de origem do repasse", () => {
  function abrirRepasse(overrides) {
    const r = renderDashboard(overrides);
    // Os grupos de origem moram na aba Grupos desde que a aba Repasse foi removida.
    fireEvent.click(screen.getByRole("button", { name: /^Grupos/ }));
    return r;
  }

  function renderRepasse(leaders, limitLeaders = 3, numbers = [{ id: "n1", label: "Número 1" }]) {
    return abrirRepasse({
      group: { scraping: { kind: "repasse", sources: [], filters: {}, repasse: { leaders } } },
      numbers,
      limits: { leadersPerCampaign: limitLeaders },
    });
  }

  it("lista todas as origens da campanha, cada uma com o seu ⋯", () => {
    renderRepasse([
      { numberId: "n1", jid: "111@g.us", name: "Ofertas A" },
      { numberId: "n1", jid: "222@g.us", name: "Ofertas B" },
    ]);
    expect(screen.getByText("Ofertas A")).toBeInTheDocument();
    expect(screen.getByText("Ofertas B")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mais ações — Ofertas A" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mais ações — Ofertas B" })).toBeInTheDocument();
  });

  it("remover uma origem pede confirmação e grava na hora", () => {
    const { props } = renderRepasse([
      { numberId: "n1", jid: "111@g.us", name: "Ofertas A" },
      { numberId: "n1", jid: "222@g.us", name: "Ofertas B" },
    ]);
    abrirMenu("Ofertas A");
    fireEvent.click(itemDoMenu("Remover da origem"));
    expect(screen.getByText(/Remover grupo de origem\?/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Remover$/ }));
    const scraping = props.onUpdate.mock.calls.at(-1)[1].scraping;
    expect(scraping.repasse.leaders).toEqual([{ numberId: "n1", jid: "222@g.us", name: "Ofertas B" }]);
    expect(screen.queryByText("Ofertas A")).not.toBeInTheDocument();
  });

  it("adicionar origem: escolhe o WhatsApp, depois o grupo, e grava na hora", async () => {
    listWAGroups.mockResolvedValueOnce([
      { jid: "111@g.us", name: "Ofertas A", members: 50 },
      { jid: "333@g.us", name: "Ofertas C", members: 80 },
    ]);
    const { props } = renderRepasse([{ numberId: "n1", jid: "111@g.us", name: "Ofertas A" }], 3,
      [{ id: "n1", label: "Número 1", status: "connected" }]);
    fireEvent.click(screen.getByRole("button", { name: "Adicionar grupo de origem" }));
    fireEvent.click(screen.getByRole("button", { name: /Número 1/ }));
    // O que já é origem aparece travado.
    expect(await screen.findByRole("button", { name: /Ofertas A.*Já é origem/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /Ofertas C/ }));
    await waitFor(() => expect(props.onUpdate).toHaveBeenCalled());
    const scraping = props.onUpdate.mock.calls.at(-1)[1].scraping;
    expect(scraping.repasse.leaders.map(l => l.jid)).toEqual(["111@g.us", "333@g.us"]);
  });

  it("entende o formato antigo de líder único", () => {
    abrirRepasse({
      group: { scraping: { kind: "repasse", sources: [], filters: {}, repasse: { leaderNumberId: "n1", leaderJid: "111@g.us", leaderName: "Ofertas Antigas" } } },
      numbers: [{ id: "n1", label: "Número 1" }],
      limits: { leadersPerCampaign: 3 },
    });
    expect(screen.getByText("Ofertas Antigas")).toBeInTheDocument();
  });

  it("no limite do plano, trava o adicionar e explica o porquê", () => {
    renderRepasse([{ numberId: "n1", jid: "111@g.us", name: "Ofertas A" }], 1);
    expect(screen.getByText(/limite de 1 grupo de origem do seu plano/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Adicionar grupo de origem" })).toBeDisabled();
  });

  it("a aba Repasse não existe mais — as origens ficam na aba Grupos e a aprovação no Gerenciar", () => {
    renderDashboard({
      group: { scraping: { kind: "repasse", sources: [], filters: {}, repasse: { leaders: [] } } },
      numbers: [{ id: "n1", label: "Número 1" }],
      limits: { leadersPerCampaign: 3 },
    });
    expect(screen.queryByRole("button", { name: /^Repasse$/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Grupos/ }));
    expect(screen.getByText("Grupos Origem")).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Aprovação automática" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Gerenciar$/ }));
    expect(screen.getByRole("switch", { name: "Aprovação automática" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Repassar a mensagem original" })).toBeInTheDocument();
  });

  it("campanha de busca continua com a aba Busca de Produtos", () => {
    renderDashboard({ group: { scraping: { kind: "scraping", sources: ["Amazon"], filters: {} } } });
    expect(screen.getByRole("button", { name: /Busca de Produtos/ })).toBeInTheDocument();
  });

  it("a origem vem antes do destino, ligadas pela seta", () => {
    const { container } = renderRepasse([{ numberId: "n1", jid: "111@g.us", name: "Ofertas A" }]);
    const origem = container.querySelector('[data-tour="pr-leader"]');
    const envio = container.querySelector('[data-tour="wg-list"]');
    expect(origem).toBeTruthy();
    expect(envio).toBeTruthy();
    expect(origem.compareDocumentPosition(envio) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelector(".groups-flow-arrow")).toBeTruthy();
    expect(screen.getByText("Grupos Destino")).toBeInTheDocument();
  });

  it("campanha de busca não ganha seção de origem na aba Grupos", () => {
    const { container } = renderDashboard({ group: { scraping: { kind: "scraping", sources: ["Amazon"], filters: {} } } });
    fireEvent.click(screen.getByRole("button", { name: /^Grupos/ }));
    expect(container.querySelector('[data-tour="pr-leader"]')).toBeNull();
    expect(container.querySelector(".groups-flow-arrow")).toBeNull();
    expect(screen.getByText("Grupos Destino")).toBeInTheDocument();
  });

  it("origem com número conectado mostra 'Conectado'", () => {
    abrirRepasse({
      group: { scraping: { kind: "repasse", sources: [], filters: {}, repasse: { leaders: [{ numberId: "n1", jid: "111@g.us", name: "Ofertas A" }] } } },
      numbers: [{ id: "n1", label: "Número 1", status: "connected" }],
      limits: { leadersPerCampaign: 3 },
    });
    expect(screen.getByText("Conectado")).toBeInTheDocument();
  });

  it("origem com número desconectado avisa que nada é capturado", () => {
    renderRepasse([{ numberId: "n1", jid: "111@g.us", name: "Ofertas A" }]);
    expect(screen.getByText("Desconectado")).toBeInTheDocument();
    expect(screen.getByText(/nada é capturado neste grupo/i)).toBeInTheDocument();
  });

  it("origem cujo número sumiu aparece como removido", () => {
    abrirRepasse({
      group: { scraping: { kind: "repasse", sources: [], filters: {}, repasse: { leaders: [{ numberId: "n9", jid: "111@g.us", name: "Ofertas A" }] } } },
      numbers: [{ id: "n1", label: "Número 1", status: "connected" }],
      limits: { leadersPerCampaign: 3 },
    });
    expect(screen.getByText(/número removido/i)).toBeInTheDocument();
  });

  it("repasse sem nenhuma origem avisa que a campanha não captura nada", () => {
    renderRepasse([]);
    expect(screen.getByText(/Nenhum grupo de origem escolhido/i)).toBeInTheDocument();
  });

  it("grupo que é destino e origem ao mesmo tempo ganha o selo nos dois lados", () => {
    abrirRepasse({
      group: {
        whatsappGroupIds: ["111@g.us"],
        scraping: { kind: "repasse", sources: [], filters: {}, repasse: { leaders: [{ numberId: "n1", jid: "111@g.us", name: "Ofertas A" }] } },
      },
      whatsappGroups: [{ id: "111@g.us", name: "Ofertas A", numberId: "n1", status: "connected", members: 10 }],
      numbers: [{ id: "n1", label: "Número 1", status: "connected" }],
      limits: { leadersPerCampaign: 3 },
    });
    expect(screen.getByText(/Também é origem/)).toBeInTheDocument();
    expect(screen.getByText(/Também é destino/)).toBeInTheDocument();
  });
});

// ── Adicionar link manualmente: o que a UI diz quando o ML bloqueia ──────────
// A página de produto do ML responde CAPTCHA, então o backend cai na landing de
// afiliado e, em último caso, no catálogo já raspado. Nos dois desfechos ruins a
// mensagem precisa ser honesta: preço de catálogo pede conferência, e cookie
// vencido pede AÇÃO — nunca "espere um pouco".
describe("GroupDashboard — Adicionar link manualmente", () => {
  const abrirEBuscar = async (url = "https://www.mercadolivre.com.br/x/p/MLB1") => {
    renderDashboard();
    fireEvent.click(screen.getByRole("button", { name: /Fila/ }));
    fireEvent.click(screen.getAllByRole("button", { name: /Adicionar link manualmente/ })[0]);
    const input = await screen.findByPlaceholderText("ex: https://www.mercadolivre.com.br/...");
    fireEvent.change(input, { target: { value: url } });
    fireEvent.click(screen.getByRole("button", { name: /Buscar dados/ }));
  };

  it("dados do catálogo saem com aviso pra conferir o preço", async () => {
    fetchUrlMetadata.mockResolvedValueOnce({
      name: "Produto do catálogo",
      link: "https://www.mercadolivre.com.br/x/p/MLB1",
      price: 149, img: "https://http2.mlstatic.com/c.jpg", store: "Mercado Livre",
      fromCatalog: true, scrapedAt: "2026-08-25T12:00:00.000Z",
    });
    await abrirEBuscar();
    expect(await screen.findByText(/Dados do catálogo/i)).toBeInTheDocument();
    expect(screen.getByText(/confira o preço/i)).toBeInTheDocument();
  });

  it("cookie vencido: mostra a mensagem do backend, sem o 'Falha ao buscar dados'", async () => {
    const err = new Error("O cookie de afiliado do Mercado Livre venceu — cole um novo em Configurações › Afiliados.");
    err.code = "login-wall";
    fetchUrlMetadata.mockRejectedValueOnce(err);
    await abrirEBuscar();
    expect(await screen.findByText(/cookie de afiliado do Mercado Livre venceu/i)).toBeInTheDocument();
    expect(screen.queryByText(/Falha ao buscar dados/i)).not.toBeInTheDocument();
  });

  it("erro sem motivo tipado mantém o texto genérico de sempre", async () => {
    fetchUrlMetadata.mockRejectedValueOnce(new Error("timeout"));
    await abrirEBuscar();
    expect(await screen.findByText(/Falha ao buscar dados: timeout/i)).toBeInTheDocument();
  });
});
