// Admin › Cupom › Cupons do produto (task 12): a resposta pelo lado do produto e a
// sonda do checkout. O que a tela não pode fazer é dizer "nenhum cupom vale" quando
// o que ela sabe é "nenhuma vitrine lida trouxe este produto".
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("../data/api", () => ({
  errText: (err, fallback) => err?.message || fallback,
  adminProdutoCupons: vi.fn(),
  adminSondaCheckoutCupons: vi.fn(),
  adminSondaLoteAlvos: vi.fn(),
  adminSondaLoteResultado: vi.fn(),
  adminSondaLoteConfig: vi.fn(),
  adminSondaLoteSalvarConfig: vi.fn(),
  adminSondaLoteRuns: vi.fn(),
}));
vi.mock("../data/coletor", () => ({
  coletorEntende: vi.fn(),
  sondarCuponsNoCheckout: vi.fn(),
}));

import CuponsDoProduto from "../pages/AdminCupomProduto.jsx";
import { adminProdutoCupons, adminSondaCheckoutCupons, adminSondaLoteAlvos, adminSondaLoteResultado, adminSondaLoteConfig, adminSondaLoteSalvarConfig, adminSondaLoteRuns } from "../data/api";
import { coletorEntende, sondarCuponsNoCheckout } from "../data/coletor";

const LINK = "https://www.mercadolivre.com.br/fone/p/MLB22222222";

function buscar() {
  fireEvent.change(screen.getByLabelText(/Link do produto/), { target: { value: LINK } });
  fireEvent.click(screen.getByRole("button", { name: "Ver cupons" }));
}

beforeEach(() => {
  vi.clearAllMocks();
  coletorEntende.mockResolvedValue(false);
  adminSondaLoteAlvos.mockResolvedValue({ produtos: [], total: 0, porCategoria: [], cfg: { pausaMs: 0 } });
  adminSondaLoteConfig.mockResolvedValue({
    config: { paralelo: 1, pausaMs: 5000, settleMs: 1500, esperaCheckoutMs: 30000, esperaNavMs: 20000, modoRapido: true },
    faixas: { paralelo: [1, 4], pausaMs: [0, 60000] },
  });
  adminSondaLoteRuns.mockResolvedValue({ runs: [] });
});

describe("Cupons do produto", () => {
  it("mostra cada cupom com o preço neste produto e de onde o sistema sabe", async () => {
    adminProdutoCupons.mockResolvedValue({
      produto: { name: "Fone Bluetooth", price: 200 },
      semVinculo: false,
      cupons: [{ campaignId: "B", title: "25% OFF Áudio", kind: "percent", value: 25, code: null,
        priceWithCoupon: 150, economia: 50, origemRotulo: "miniatura do card do cupom", expiresAt: null }],
    });
    render(<CuponsDoProduto />);
    buscar();
    expect(await screen.findByText("25% OFF Áudio")).toBeTruthy();
    expect(adminProdutoCupons).toHaveBeenCalledWith({ url: LINK });
    expect(screen.getByText("miniatura do card do cupom")).toBeTruthy();
    expect(screen.getByText(/R\$ 150,00/)).toBeTruthy();
    expect(screen.getByText(/sem palavra/)).toBeTruthy();
  });

  it("sem vínculo, diz que isso NÃO quer dizer que nenhum cupom vale", async () => {
    adminProdutoCupons.mockResolvedValue({ produto: { name: "Fone", price: 200 }, semVinculo: true, cupons: [] });
    render(<CuponsDoProduto />);
    buscar();
    expect(await screen.findByText(/Nenhuma vitrine lida até agora trouxe este produto/)).toBeTruthy();
  });

  it("sem a extensão nova, avisa a versão em vez de oferecer a sonda", async () => {
    render(<CuponsDoProduto />);
    expect(await screen.findByText(/precisa da versão 2.2.5/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Sondar/ })).toBeNull();
  });

  it("a sonda manda o material pro servidor e mostra onde ficou", async () => {
    coletorEntende.mockResolvedValue(true);
    sondarCuponsNoCheckout.mockResolvedValue({ checkout: { reached: true }, capturaDosCupons: { texto: "x", html: "<p/>", respostas: [] } });
    adminSondaCheckoutCupons.mockResolvedValue({
      pasta: "logs/ml-checkout-cupons/2026-09-19T16-00-00-000Z",
      resumo: { chegouNosCupons: true, viuAtivos: true, passos: 3, respostasDeApi: 2, muro: null, carrinhoLimpo: null,
        cupomAplicado: { emUso: 1, disponiveis: 1, desconto: 10.59 },
        checkout: { ok: true, economia: 20, valem: ["14167118"], gravado: { vinculados: 2, cuponsNovos: 0 },
          cupons: [{ campaignId: "14167118", titulo: "25% OFF em Itens para Casa", aplicado: true, descontoNoCarrinho: 20, minPurchase: 25, maxDiscount: 20 }] } },
    });
    render(<CuponsDoProduto />);
    fireEvent.change(screen.getByLabelText(/Link do produto/), { target: { value: LINK } });
    fireEvent.click(await screen.findByRole("button", { name: "Sondar o checkout deste produto" }));
    expect(await screen.findByText(/chegou na tela dos cupons/)).toBeTruthy();
    expect(screen.getByText(/O ML aplicou sozinho 1 de 1 cupom\(ns\) — R\$ 10,59 de desconto/)).toBeTruthy();
    expect(sondarCuponsNoCheckout).toHaveBeenCalledWith(LINK, expect.any(Object));
    await waitFor(() => expect(adminSondaCheckoutCupons).toHaveBeenCalledWith(expect.objectContaining({ url: LINK })));
    expect(screen.getByText(/backend\/logs\/ml-checkout-cupons/)).toBeTruthy();
    expect(screen.getByText("25% OFF em Itens para Casa")).toBeTruthy();
    expect(screen.getByText(/aplicado pelo ML · −R\$ 20,00 neste carrinho/)).toBeTruthy();
    expect(screen.getByText(/passa a carregar 1 cupom\(ns\) com origem “checkout”/)).toBeTruthy();
  });

  it("popup que não abriu não é falha quando a página de cupons foi lida direto", async () => {
    coletorEntende.mockResolvedValue(true);
    sondarCuponsNoCheckout.mockResolvedValue({ checkout: { reached: true }, paginaDosCupons: { ok: true, html: "<html/>" } });
    adminSondaCheckoutCupons.mockResolvedValue({
      pasta: "logs/ml-checkout-cupons/2026-09-19T20-00-00-000Z",
      resumo: { chegouNosCupons: false, leuPaginaDosCupons: true, viuAtivos: false, passos: 0, respostasDeApi: 0,
        muro: null, carrinhoLimpo: null, cupomAplicado: null, motivo: null,
        checkout: { ok: true, economia: null, valem: [], gravado: null, cupons: [] } },
    });
    render(<CuponsDoProduto />);
    fireEvent.change(screen.getByLabelText(/Link do produto/), { target: { value: LINK } });
    fireEvent.click(await screen.findByRole("button", { name: "Sondar o checkout deste produto" }));
    expect(await screen.findByText(/leu a lista de cupons do checkout/)).toBeTruthy();
    expect(screen.getByText(/O checkout não listou cupom nenhum para este produto/)).toBeTruthy();
    expect(screen.queryByText(/não leu a lista de cupons/)).toBeNull();
  });

  it("testar os produtos do scraping: filtros por categoria, progresso e o desfecho de cada um", async () => {
    coletorEntende.mockResolvedValue(true);
    const prod = { key: "k1", name: "Fone Bluetooth", link: LINK, category: "gamer" };
    adminSondaLoteAlvos.mockResolvedValue({
      produtos: [prod], total: 4, cfg: { pausaMs: 0 },
      porCategoria: [{ category: "gamer", elegiveis: 4, sondados: 10, comCupom: 3 }],
    });
    sondarCuponsNoCheckout.mockResolvedValue({ checkout: { reached: true } });
    adminSondaLoteResultado.mockResolvedValue({ ok: true, cupons: [{ campaignId: "C1", titulo: "10% OFF Games", descontoNoCarrinho: 20 }] });

    render(<CuponsDoProduto />);
    expect(await screen.findByText(/1 produto\(s\) neste lote, de 4 elegível/)).toBeTruthy();
    expect(screen.getByText(/cupom em 3\/10 \(30%\)/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Testar produtos" }));
    expect(await screen.findByText(/10% OFF Games \(−R\$ 20,00\)/)).toBeTruthy();
    expect(screen.getByText(/1 com cupom · 0 sem · 0 não chegou/)).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("1");
    expect(adminSondaLoteResultado).toHaveBeenCalledWith(expect.objectContaining({ key: "k1", url: LINK }));
  });

  it("o ritmo do lote: mostra o que está gravado e salva só o que mudou, em ms", async () => {
    coletorEntende.mockResolvedValue(true);
    adminSondaLoteSalvarConfig.mockImplementation(async (patch) => ({
      config: { paralelo: 2, pausaMs: 2000, settleMs: 1500, esperaCheckoutMs: 30000, esperaNavMs: 20000, modoRapido: true, ...patch },
    }));
    render(<CuponsDoProduto />);
    expect(await screen.findByText(/Ritmo: 1 aba\(s\), pausa de 5s, modo rápido/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Abas ao mesmo tempo"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText(/Pausa entre produtos/), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar ritmo" }));

    await waitFor(() => expect(adminSondaLoteSalvarConfig).toHaveBeenCalledWith({ paralelo: 2, pausaMs: 2000 }));
    expect(await screen.findByText(/Ritmo: 2 aba\(s\), pausa de 2s/)).toBeTruthy();
  });

  it("o ritmo: avisa acima de 4 abas e diz quando o servidor cortou o valor", async () => {
    coletorEntende.mockResolvedValue(true);
    adminSondaLoteConfig.mockResolvedValue({
      config: { paralelo: 1, pausaMs: 5000, settleMs: 1500, esperaCheckoutMs: 30000, esperaNavMs: 20000, modoRapido: true },
      faixas: { paralelo: [1, 8] },
    });
    adminSondaLoteSalvarConfig.mockResolvedValue({
      config: { paralelo: 8, pausaMs: 5000, settleMs: 1500, esperaCheckoutMs: 30000, esperaNavMs: 20000, modoRapido: true },
    });
    render(<CuponsDoProduto />);
    await screen.findByText(/Ritmo: 1 aba/);
    expect(screen.queryByText(/Acima de 4 abas/)).toBeNull();

    fireEvent.change(screen.getByLabelText("Abas ao mesmo tempo"), { target: { value: "9" } });
    expect(screen.getByText(/Acima de 4 abas/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Salvar ritmo" }));
    expect(await screen.findByText(/Abas ao mesmo tempo ajustado para 8 \(máximo 8\)/)).toBeTruthy();
  });

  it("o histórico das execuções: ritmo por produto, sonda média e como terminou", async () => {
    coletorEntende.mockResolvedValue(true);
    adminSondaLoteRuns.mockResolvedValue({ runs: [{
      inicio: "2026-09-21T22:30:00.000Z", fim: "2026-09-21T22:32:00.000Z", duracaoMs: 120000,
      produtos: 20, naFila: 20, ok: 18, comCupom: 3, falhas: 2, mediaSondaMs: 11500,
      ritmo: { paralelo: 2, pausaMs: 0, settleMs: 1500, modoRapido: true }, parado: null, muro: false,
    }] });
    render(<CuponsDoProduto />);
    expect(await screen.findByText("Últimas execuções")).toBeTruthy();
    expect(screen.getByText("2 min 0 s")).toBeTruthy();
    expect(screen.getByText("6,0 s")).toBeTruthy();      // 120 s ÷ 20 produtos
    expect(screen.getByText("11,5 s")).toBeTruthy();
    expect(screen.getByText(/2 aba\(s\) · pausa 0,0 s · rápido/)).toBeTruthy();
    expect(screen.getByText("completo")).toBeTruthy();
  });
});
