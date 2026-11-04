// Admin › Scraping Cupons › Cupons Teste — a conferência do preço com cupom dos
// envios, produto a produto, no Chrome do admin.
//
// O que estes testes protegem: a prévia diz o que vai acontecer, a barra anda um
// produto por vez, o Parar fecha a rodada como "cancelada" (e não deixa ela
// "rodando" pra sempre), e sem a extensão o botão não promete o que não faz.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("../data/api", () => ({
  errText: (err, fallback) => err?.message || fallback,
  adminCuponsTesteConfig: vi.fn(),
  adminCuponsTesteSalvarConfig: vi.fn(),
  adminCuponsTesteAlvos: vi.fn(),
  adminCuponsTesteRuns: vi.fn(),
  adminCuponsTesteRun: vi.fn(),
  adminCuponsTesteAbrirRun: vi.fn(),
  adminCuponsTesteItem: vi.fn(),
  adminCuponsTesteFecharRun: vi.fn(),
}));

vi.mock("../data/coletor", () => ({
  coletorEntende: vi.fn(),
  cupomNoCheckout: vi.fn(),
}));

import CuponsTeste from "../pages/AdminCupomTeste.jsx";
import {
  adminCuponsTesteConfig, adminCuponsTesteAlvos, adminCuponsTesteRuns, adminCuponsTesteAbrirRun,
  adminCuponsTesteItem, adminCuponsTesteFecharRun, adminCuponsTesteSalvarConfig,
} from "../data/api";
import { coletorEntende, cupomNoCheckout } from "../data/coletor";

const CFG = { dias: 3, maxProdutos: 20, soRepasse: false, campanhas: [], toleranciaReais: 0.1, pausaEntreMs: 0, umPorProduto: true };
const alvo = (n) => ({
  historyId: String(n), groupId: "1", groupName: "Ofertas", key: `k${n}`, name: `Produto ${n}`,
  link: `https://meli.la/${n}`, coupon: "CASA25", sentAt: new Date().toISOString(), estimado: n === 2,
  prometidoPreco: 100, prometidoComCupom: 90,
});
const ALVOS = { alvos: [alvo(1), alvo(2)], total: 2, disponiveis: 2, campanhas: 1, envios: 5, semCupom: 3, estimados: 1, config: CFG };

const item = (n, status = "ok") => ({
  id: String(n), runId: "9", name: `Produto ${n}`, link: `https://meli.la/${n}`, coupon: "CASA25",
  groupName: "Ofertas", prometidoPreco: 100, prometidoComCupom: 90, precoPagina: 100, descontoMl: 10,
  realComCupom: 90, diferenca: 0, status, motivo: status === "ok" ? "Bate." : "A mensagem disse R$ 90,00…",
  estimado: false,
});

beforeEach(() => {
  vi.clearAllMocks();
  coletorEntende.mockResolvedValue(true);
  adminCuponsTesteConfig.mockResolvedValue({ config: CFG, defaults: CFG, faixas: {}, campanhas: [{ id: "1", name: "Ofertas", repasse: false }] });
  adminCuponsTesteAlvos.mockResolvedValue(ALVOS);
  adminCuponsTesteRuns.mockResolvedValue({ runs: [] });
  adminCuponsTesteAbrirRun.mockResolvedValue({ run: { id: "9" } });
  adminCuponsTesteFecharRun.mockResolvedValue({ fechada: true });
  cupomNoCheckout.mockResolvedValue({ produto: { price: 100 } });
});

describe("Cupons Teste", () => {
  it("a prévia diz quantos produtos e de quantas campanhas, e quantos são estimados", async () => {
    render(<CuponsTeste />);
    expect(await screen.findByText(/Vai conferir 2 produto\(s\) de 1 campanha\(s\)/)).toBeTruthy();
    expect(screen.getByText(/1 estimado/)).toBeTruthy();
    expect(screen.getByText(/Nunca compra nada/)).toBeTruthy();
  });

  it("confere um por um: a barra anda, a tabela mostra o resultado e a rodada fecha como concluída", async () => {
    adminCuponsTesteItem
      .mockResolvedValueOnce({ item: item(1, "ok"), muro: false })
      .mockResolvedValueOnce({ item: item(2, "divergente"), muro: false });
    render(<CuponsTeste />);
    fireEvent.click(await screen.findByRole("button", { name: "Conferir preços" }));

    await waitFor(() => expect(adminCuponsTesteFecharRun).toHaveBeenCalledWith("9", { status: "concluida", motivo: null }));
    expect(cupomNoCheckout).toHaveBeenCalledTimes(2);
    expect(cupomNoCheckout.mock.calls[0][0]).toEqual({ url: "https://meli.la/1", code: "CASA25" });
    expect(await screen.findByText("2 de 2 conferido(s)")).toBeTruthy();
    expect(screen.getByText("Rodada concluída.")).toBeTruthy();
    expect(screen.getAllByText("⚠️ divergente").length).toBeGreaterThan(0);
  });

  it("Parar: termina o produto aberto, não começa o próximo e fecha como cancelada", async () => {
    let soltar;
    cupomNoCheckout.mockImplementationOnce(() => new Promise(r => { soltar = r; }));
    adminCuponsTesteItem.mockResolvedValue({ item: item(1), muro: false });
    render(<CuponsTeste />);
    fireEvent.click(await screen.findByRole("button", { name: "Conferir preços" }));

    fireEvent.click(await screen.findByRole("button", { name: "Parar" }));
    expect(screen.getByText(/parando depois do produto aberto/)).toBeTruthy();
    soltar({ produto: { price: 100 } });

    await waitFor(() => expect(adminCuponsTesteFecharRun).toHaveBeenCalledWith("9", { status: "cancelada", motivo: "Parado por você." }));
    expect(cupomNoCheckout).toHaveBeenCalledTimes(1);
    expect(adminCuponsTesteItem).toHaveBeenCalledTimes(1);
  });

  it("verificação do ML não resolvida para a rodada toda", async () => {
    adminCuponsTesteItem.mockResolvedValue({ item: item(1, "falhou"), muro: true });
    render(<CuponsTeste />);
    fireEvent.click(await screen.findByRole("button", { name: "Conferir preços" }));

    await waitFor(() => expect(adminCuponsTesteFecharRun).toHaveBeenCalledWith("9", expect.objectContaining({ status: "interrompida" })));
    expect(cupomNoCheckout).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/pediu verificação e ela não foi resolvida/)).toBeTruthy();
  });

  it("extensão que falhou no meio vira um item 'falhou', e a rodada segue", async () => {
    cupomNoCheckout.mockRejectedValueOnce(new Error("A extensão não respondeu a tempo."));
    adminCuponsTesteItem
      .mockResolvedValueOnce({ item: item(1, "falhou"), muro: false })
      .mockResolvedValueOnce({ item: item(2), muro: false });
    render(<CuponsTeste />);
    fireEvent.click(await screen.findByRole("button", { name: "Conferir preços" }));

    await waitFor(() => expect(adminCuponsTesteFecharRun).toHaveBeenCalled());
    expect(adminCuponsTesteItem.mock.calls[0][1]).toMatchObject({ material: null, erro: "A extensão não respondeu a tempo." });
    expect(cupomNoCheckout).toHaveBeenCalledTimes(2);
  });

  it("sem a extensão o botão fica desligado e a tela diz o que fazer", async () => {
    coletorEntende.mockResolvedValue(false);
    render(<CuponsTeste />);
    expect(await screen.findByText(/A extensão não respondeu/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Conferir preços" }).disabled).toBe(true);
  });

  it("salvar a configuração manda só o que mudou (pausa em ms)", async () => {
    adminCuponsTesteSalvarConfig.mockResolvedValue({ config: { ...CFG, pausaEntreMs: 20000 } });
    render(<CuponsTeste />);
    const campo = await screen.findByLabelText("Pausa entre produtos (s)");
    fireEvent.change(campo, { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar configuração" }));
    await waitFor(() => expect(adminCuponsTesteSalvarConfig).toHaveBeenCalledWith({ pausaEntreMs: 20000 }));
    expect(await screen.findByText("Configuração salva.")).toBeTruthy();
  });
});
