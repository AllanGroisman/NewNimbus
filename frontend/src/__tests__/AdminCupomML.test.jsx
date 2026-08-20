// Admin › Cupons ML — o convite pra trazer a campanha que uma palavra apontou.
//
// O ML só responde o ID da campanha. Quando esse ID não está no sistema, a tela
// mostrava um número solto e o único caminho era rodar a coleta inteira (minutos
// de Chrome com a conta do sistema). O popup é o atalho — e o que estes testes
// protegem é justamente ele NÃO aparecer quando a campanha já está aqui, que é o
// caso comum e onde um popup à toa vira ruído a cada teste de palavra.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("../data/api", () => ({
  // errText é helper puro (não faz rede) — usa a implementação de verdade.
  errText: (err, fallback) => err?.message || fallback,
  adminMlCupons: vi.fn(),
  adminMlCuponsStatus: vi.fn(),
  adminMlCuponsRun: vi.fn(),
  adminMlCuponsCancel: vi.fn(),
  adminMlCuponsSaveConfig: vi.fn(),
  adminMlCuponsProducts: vi.fn(),
  adminMlCuponsSyncProducts: vi.fn(),
  adminMlCuponsTestWord: vi.fn(),
  adminMlCuponsCodes: vi.fn(),
  adminMlCuponsClearAll: vi.fn(),
  adminMlCuponsImportCampaign: vi.fn(),
  adminMlCuponsImportStatus: vi.fn(),
}));

import PageCuponsML from "../pages/AdminCupomML.jsx";
import {
  adminMlCupons,
  adminMlCuponsStatus,
  adminMlCuponsCodes,
  adminMlCuponsTestWord,
  adminMlCuponsImportCampaign,
  adminMlCuponsImportStatus,
} from "../data/api";

const VAZIO = { items: [], total: 0, page: 1, pageSize: 50 };

// A resposta do POST /code. `coupon: null` é o caso que abre o popup: o ML
// reconheceu a palavra e o sistema não tem a campanha.
const resposta = (extra = {}) => ({
  result: {
    word: "BRINQUEDOS", verdict: "valid", campaignId: "13907402",
    coupon: null, message: "Cupom aplicado", cached: false, ...extra,
  },
});

async function abrirTela() {
  render(<PageCuponsML />);
  await waitFor(() => expect(adminMlCupons).toHaveBeenCalled());
}

async function testarPalavra() {
  fireEvent.change(screen.getByPlaceholderText("BRINQUEDOS"), { target: { value: "brinquedos" } });
  fireEvent.click(screen.getByRole("button", { name: /testar palavra/i }));
}

beforeEach(() => {
  vi.clearAllMocks();
  adminMlCuponsStatus.mockResolvedValue({ config: {}, running: false });
  adminMlCupons.mockResolvedValue(VAZIO);
  adminMlCuponsCodes.mockResolvedValue({ codes: [] });
  // A busca roda solta: o POST só dispara, o desfecho vem pelo status.
  adminMlCuponsImportCampaign.mockResolvedValue({ started: true, running: true });
  adminMlCuponsImportStatus.mockResolvedValue({ running: false, result: null, error: null });
});

describe("popup de campanha que falta", () => {
  it("abre quando a palavra vale e a campanha não está no sistema", async () => {
    adminMlCuponsTestWord.mockResolvedValue(resposta());
    await abrirTela();
    await testarPalavra();

    expect(await screen.findByText("Essa campanha não está no sistema")).toBeInTheDocument();
    // A palavra vai maiúscula pro backend, como o campo mostra.
    expect(adminMlCuponsTestWord).toHaveBeenCalledWith("BRINQUEDOS", false);
  });

  it("NÃO abre quando a campanha já está aqui", async () => {
    adminMlCuponsTestWord.mockResolvedValue(resposta({ coupon: { campaignId: "13907402", title: "20% OFF" } }));
    await abrirTela();
    await testarPalavra();

    await screen.findByText(/20% OFF/);
    expect(screen.queryByText("Essa campanha não está no sistema")).not.toBeInTheDocument();
  });

  it("NÃO abre quando o ML não reconheceu a palavra", async () => {
    adminMlCuponsTestWord.mockResolvedValue(resposta({ verdict: "invalid", campaignId: null }));
    await abrirTela();
    await testarPalavra();

    await waitFor(() => expect(adminMlCuponsTestWord).toHaveBeenCalled());
    expect(screen.queryByText("Essa campanha não está no sistema")).not.toBeInTheDocument();
  });

  it("abre também para resposta guardada — o cache diz do veredito, não da campanha", async () => {
    adminMlCuponsTestWord.mockResolvedValue(resposta({ cached: true, checkedAt: new Date().toISOString() }));
    await abrirTela();
    await testarPalavra();

    expect(await screen.findByText("Essa campanha não está no sistema")).toBeInTheDocument();
  });

  it("busca com os produtos por padrão, mostra o progresso e depois o que entrou", async () => {
    adminMlCuponsTestWord.mockResolvedValue(resposta());
    // Primeiro tick: ainda varrendo. Segundo: terminou.
    adminMlCuponsImportStatus
      .mockResolvedValueOnce({ running: true, progress: { etapa: "cupons", pagina: 2, de: 13, cupons: 60 } })
      .mockResolvedValue({
        running: false,
        result: { ok: true, coupon: { campaignId: "13907402", title: "Até 20% OFF em brinquedos" }, produtos: 52, vinculos: 52 },
      });
    await abrirTela();
    await testarPalavra();
    await screen.findByText("Essa campanha não está no sistema");

    fireEvent.click(screen.getByRole("button", { name: /buscar e adicionar/i }));

    await waitFor(() => expect(adminMlCuponsImportCampaign).toHaveBeenCalledWith("13907402", true));
    expect(await screen.findByText(/página 2\/13/)).toBeInTheDocument();
    // O desfecho só chega na leitura seguinte, 3s depois.
    expect(await screen.findByText(/52 produtos/, {}, { timeout: 5000 })).toBeInTheDocument();
  });

  it("campanha que já estava no sistema é desfecho na hora, sem acompanhar", async () => {
    adminMlCuponsTestWord.mockResolvedValue(resposta());
    adminMlCuponsImportCampaign.mockResolvedValue({
      ok: true, already: true, coupon: { campaignId: "13907402", title: "Já estava aqui" },
    });
    await abrirTela();
    await testarPalavra();
    await screen.findByText("Essa campanha não está no sistema");

    fireEvent.click(screen.getByRole("button", { name: /buscar e adicionar/i }));

    expect(await screen.findByText(/Já estava aqui/)).toBeInTheDocument();
    expect(adminMlCuponsImportStatus).not.toHaveBeenCalled();
  });

  it("desmarcar o checkbox traz só a campanha", async () => {
    adminMlCuponsTestWord.mockResolvedValue(resposta());
    adminMlCuponsImportStatus.mockResolvedValue({
      running: false, result: { ok: true, coupon: { campaignId: "13907402", title: "Só a campanha" }, produtos: 0 },
    });
    await abrirTela();
    await testarPalavra();
    await screen.findByText("Essa campanha não está no sistema");

    // Pelo rótulo, não por role: a tela tem outros checkboxes (o filtro e o
    // "ignorar cupom de loja" da configuração da rodada).
    fireEvent.click(screen.getByLabelText(/Trazer também os produtos da vitrine/));
    fireEvent.click(screen.getByRole("button", { name: /buscar e adicionar/i }));

    await waitFor(() => expect(adminMlCuponsImportCampaign).toHaveBeenCalledWith("13907402", false));
  });

  it("erro do servidor durante a busca aparece no modal", async () => {
    adminMlCuponsTestWord.mockResolvedValue(resposta());
    adminMlCuponsImportStatus.mockResolvedValue({
      running: false, error: "Sem sessão do Mercado Livre do sistema.",
    });
    await abrirTela();
    await testarPalavra();
    await screen.findByText("Essa campanha não está no sistema");

    fireEvent.click(screen.getByRole("button", { name: /buscar e adicionar/i }));

    expect(await screen.findByText("Sem sessão do Mercado Livre do sistema.")).toBeInTheDocument();
  });

  // A busca dura minutos e o modal diz que dá pra fechar. Se o intervalo ficasse
  // vivo, ele seguiria chamando a API e gravando estado em componente desmontado.
  it("fechar no meio da busca não deixa o acompanhamento rodando", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      adminMlCuponsTestWord.mockResolvedValue(resposta());
      adminMlCuponsImportStatus.mockResolvedValue({ running: true, progress: { etapa: "abrindo" } });
      await abrirTela();
      await testarPalavra();
      await screen.findByText("Essa campanha não está no sistema");

      fireEvent.click(screen.getByRole("button", { name: /buscar e adicionar/i }));
      await waitFor(() => expect(adminMlCuponsImportStatus).toHaveBeenCalled());

      fireEvent.click(screen.getByRole("button", { name: /a busca continua/i }));
      await waitFor(() => expect(screen.queryByText("Essa campanha não está no sistema")).not.toBeInTheDocument());

      const antes = adminMlCuponsImportStatus.mock.calls.length;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(adminMlCuponsImportStatus.mock.calls.length).toBe(antes);
    } finally {
      vi.useRealTimers();
    }
  });

  it("campanha não achada na lista mostra o motivo e não fecha sozinho", async () => {
    adminMlCuponsTestWord.mockResolvedValue(resposta());
    adminMlCuponsImportStatus.mockResolvedValue({
      running: false, result: { ok: false, reason: "Essa campanha não aparece na lista da conta." },
    });
    await abrirTela();
    await testarPalavra();
    await screen.findByText("Essa campanha não está no sistema");

    fireEvent.click(screen.getByRole("button", { name: /buscar e adicionar/i }));

    expect(await screen.findByText("Essa campanha não aparece na lista da conta.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /buscar e adicionar/i })).toBeInTheDocument();
  });
});

describe("palavras já testadas", () => {
  const historico = [
    { code: "REPASSE10", verdict: "valid", campaignId: "13907402", inSystem: false, checkedAt: new Date().toISOString(), message: null },
    { code: "GAMER", verdict: "valid", campaignId: "14030498", inSystem: true, couponTitle: "15% OFF", checkedAt: new Date().toISOString(), message: null },
  ];

  it("só a palavra cuja campanha falta ganha o botão de adicionar", async () => {
    adminMlCuponsCodes.mockResolvedValue({ codes: historico });
    await abrirTela();

    // "Palavras já testadas" só existe depois que o histórico carrega — e "BRINQUEDOS"
    // não serve de âncora: a explicação do card usa a mesma palavra de exemplo.
    await screen.findByText("Palavras já testadas");
    expect(screen.getAllByRole("button", { name: /adicionar/i })).toHaveLength(1);
  });

  it("o botão do histórico abre o mesmo popup, com aquela campanha", async () => {
    adminMlCuponsCodes.mockResolvedValue({ codes: historico });
    adminMlCuponsImportStatus.mockResolvedValue({
      running: false, result: { ok: true, coupon: { campaignId: "13907402", title: "Achada" }, produtos: 3 },
    });
    await abrirTela();

    fireEvent.click(await screen.findByRole("button", { name: /adicionar/i }));
    await screen.findByText("Essa campanha não está no sistema");
    fireEvent.click(screen.getByRole("button", { name: /buscar e adicionar/i }));

    await waitFor(() => expect(adminMlCuponsImportCampaign).toHaveBeenCalledWith("13907402", true));
  });
});

// "Tivemos um problema" é o ML engasgando antes de avaliar a palavra — não é ele
// dizendo que a palavra não existe. A tela chamava isso de "o ML não reconheceu"
// para uma palavra que já era uma campanha viva aqui dentro.
describe("engasgo do ML (indeterminado)", () => {
  const engasgo = (extra = {}) => ({
    result: {
      word: "BRINQUEDOS", verdict: "indeterminado", campaignId: null, coupon: null,
      message: "Tivemos um problema", cached: false, knownLocally: false, ...extra,
    },
  });

  it("não diz 'não reconheceu' — diz que o ML não respondeu", async () => {
    adminMlCuponsTestWord.mockResolvedValue(engasgo());
    await abrirTela();
    await testarPalavra();

    expect(await screen.findByText(/o ML não respondeu/)).toBeTruthy();
    expect(screen.queryByText(/não reconheceu/)).toBe(null);
  });

  it("oferece testar de novo, e aí sim ignora o cache (force)", async () => {
    adminMlCuponsTestWord.mockResolvedValue(engasgo());
    await abrirTela();
    await testarPalavra();

    // O teste normal NÃO manda force: senão todo teste queimaria um Chrome à toa.
    expect(adminMlCuponsTestWord).toHaveBeenCalledWith("BRINQUEDOS", false);

    fireEvent.click(await screen.findByRole("button", { name: /testar de novo/i }));
    await waitFor(() => expect(adminMlCuponsTestWord).toHaveBeenCalledWith("BRINQUEDOS", true));
  });

  it("mostra a campanha que o sistema já sabe, e não oferece importar ela", async () => {
    adminMlCuponsTestWord.mockResolvedValue(engasgo({
      campaignId: "13471229",
      knownLocally: true,
      coupon: { campaignId: "13471229", title: "15% OFF com BRINCADEIRAS" },
    }));
    await abrirTela();
    await testarPalavra();

    expect(await screen.findByText("13471229")).toBeTruthy();
    expect(screen.getByText(/já está carimbada nela/)).toBeTruthy();
    // O popup é só pra campanha que FALTA: essa está aqui.
    expect(screen.queryByRole("button", { name: /buscar e adicionar/i })).toBe(null);
  });
});
