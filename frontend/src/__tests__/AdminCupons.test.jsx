// Admin › Cupons (task 17): navegar pelos cupons guardados — resumo, filtros,
// cartões e o painel de um cupom com os produtos dele.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

vi.mock("../data/api", () => ({
  errText: (err, fallback) => err?.message || fallback,
  adminCuponsResumo: vi.fn(),
  adminCuponsListar: vi.fn(),
  adminCupomDetalhe: vi.fn(),
  adminCupomProdutosFiltrados: vi.fn(),
}));

import { adminCuponsResumo, adminCuponsListar, adminCupomDetalhe, adminCupomProdutosFiltrados } from "../data/api";
import PageAdminCupons from "../pages/AdminCupons.jsx";
import { prazoDoCupom as prazo } from "../data/cupomCategorias";

const FILTROS_PADRAO = {
  q: "", situacao: "vigentes", palavra: "", tipo: "", escopo: "", produtos: "", categoria: "", sortBy: "recentes",
};

const em = (h) => new Date(Date.now() + h * 36e5).toISOString();
const cupom = (id, extra = {}) => ({
  campaignId: id, title: `Cupom ${id}`, kind: "percent", value: 10, rotulo: "10% OFF",
  code: null, scope: "campaign", groupings: [], produtos: 0, expiresAt: em(24 * 10), vigente: true, ...extra,
});
const CUPONS = [
  cupom("1", { code: "CASA15", rotulo: "15% OFF", produtos: 3, minPurchase: 100, groupings: ["home"] }),
  cupom("2", { title: "Loja do Zé", scope: "store", sellerName: "Zé" }),
];
const ultima = (fn) => fn.mock.calls[fn.mock.calls.length - 1];

beforeEach(() => {
  vi.clearAllMocks();
  adminCuponsResumo.mockResolvedValue({
    total: 5, vigentes: 4, vencidos: 1, vencendo: 1, comPalavra: 1, comProdutos: 2, deLoja: 1, vinculos: 9,
    categorias: [{ chave: "home", n: 2 }], groupingLabels: { home: "Casa" },
    destaques: [{ campaignId: "1", code: "CASA15", rotulo: "15% OFF", title: "Cupom 1" }],
  });
  adminCuponsListar.mockResolvedValue({ items: CUPONS, total: 2, page: 1, pageSize: 24 });
  adminCupomDetalhe.mockImplementation(async (id) => ({
    ...CUPONS.find(c => c.campaignId === id), origens: [{ origem: "vitrine", n: 3, noCatalogo: 2 }], noCatalogo: 2,
  }));
  adminCupomProdutosFiltrados.mockResolvedValue({
    total: 2, page: 1, pageSize: 20,
    items: [
      { productKey: "k1", name: "Cadeira", price: 200, priceWithCoupon: 170, origem: "vitrine", link: "https://ml/1", inCatalog: true },
      { productKey: "k2", name: "Banquinho", price: 50, priceWithCoupon: null, origem: "vitrine", link: "https://ml/2", inCatalog: true },
    ],
  });
});

describe("prazo", () => {
  const agora = Date.parse("2026-09-26T12:00:00Z");
  it("diz quanto falta ou quanto passou", () => {
    expect(prazo(null, agora)).toMatchObject({ texto: "sem validade" });
    expect(prazo("2026-09-26T17:00:00Z", agora)).toMatchObject({ texto: "vence em 5h", tom: "urgente" });
    expect(prazo("2026-09-28T12:00:00Z", agora)).toMatchObject({ texto: "vence em 2 dias", tom: "urgente" });
    expect(prazo("2026-10-06T12:00:00Z", agora)).toMatchObject({ texto: "vence em 10 dias", tom: "ok" });
    expect(prazo("2026-09-23T12:00:00Z", agora)).toMatchObject({ texto: "venceu há 3 dias", tom: "vencido" });
  });
});

describe("PageAdminCupons", () => {
  it("mostra o resumo, os destaques e os cupons em cartões", async () => {
    render(<PageAdminCupons />);
    expect(await screen.findByText("Cupom 1")).toBeInTheDocument();
    expect(screen.getByText("Loja do Zé")).toBeInTheDocument();
    expect(screen.getByText("2 cupons")).toBeInTheDocument();
    // A palavra aparece para copiar; o cupom sem palavra diz isso.
    expect(screen.getAllByText(/CASA15/).length).toBeGreaterThan(0);
    expect(screen.getByText("sem palavra")).toBeInTheDocument();
    expect(screen.getByText("Mín. R$ 100,00")).toBeInTheDocument();
    // Categoria com o nome bonito do ML.
    expect(screen.getByText("Casa")).toBeInTheDocument();
    expect(adminCuponsListar.mock.calls[0][0]).toMatchObject({ situacao: "vigentes", sortBy: "recentes", page: 1 });
  });

  it("os filtros vão para o backend, e o número do topo vira atalho", async () => {
    render(<PageAdminCupons />);
    await screen.findByText("Cupom 1");

    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Palavra" })).getByRole("radio", { name: "Com palavra" }));
    await waitFor(() => expect(ultima(adminCuponsListar)[0]).toMatchObject({ palavra: "com" }));

    fireEvent.change(screen.getByLabelText("Ordenar cupons"), { target: { value: "desconto" } });
    await waitFor(() => expect(ultima(adminCuponsListar)[0]).toMatchObject({ palavra: "com", sortBy: "desconto" }));

    // "Vencendo" no topo troca os filtros de uma vez.
    fireEvent.click(screen.getByRole("button", { name: /Vencendo/ }));
    await waitFor(() => expect(ultima(adminCuponsListar)[0]).toMatchObject({ ...FILTROS_PADRAO, situacao: "vencendo", sortBy: "vence" }));

    fireEvent.click(screen.getByRole("button", { name: "Limpar filtros" }));
    await waitFor(() => expect(ultima(adminCuponsListar)[0]).toMatchObject(FILTROS_PADRAO));
  });

  it("a busca espera a digitação parar", async () => {
    render(<PageAdminCupons />);
    await screen.findByText("Cupom 1");
    const antes = adminCuponsListar.mock.calls.length;
    fireEvent.change(screen.getByLabelText("Buscar cupom"), { target: { value: "casa" } });
    expect(adminCuponsListar.mock.calls.length).toBe(antes);
    await waitFor(() => expect(ultima(adminCuponsListar)[0]).toMatchObject({ q: "casa" }), { timeout: 2000 });
  });

  it("abre o painel do cupom com os produtos e o preço com cupom", async () => {
    render(<PageAdminCupons />);
    fireEvent.click(await screen.findByRole("button", { name: "Abrir cupom Cupom 1" }));
    const painel = await screen.findByRole("dialog", { name: "Cupom Cupom 1" });
    expect(await within(painel).findByText("Cadeira")).toBeInTheDocument();
    expect(within(painel).getByText("R$ 170,00")).toBeInTheDocument();
    // Abaixo da compra mínima o preço fica cheio e diz que o cupom não pega.
    expect(within(painel).getByText("cupom não pega")).toBeInTheDocument();
    expect(within(painel).getByText("2 de 3 no catálogo")).toBeInTheDocument();

    fireEvent.click(within(painel).getByRole("button", { name: /Só onde o cupom pega/ }));
    await waitFor(() => expect(ultima(adminCupomProdutosFiltrados)[1]).toMatchObject({ valendo: true }));
    fireEvent.change(within(painel).getByLabelText("Ordenar produtos"), { target: { value: "vendidos" } });
    await waitFor(() => expect(ultima(adminCupomProdutosFiltrados)[1]).toMatchObject({ sortBy: "vendidos", valendo: true }));
  });

  it("as setas passam para o próximo cupom sem fechar o painel, e Esc fecha", async () => {
    render(<PageAdminCupons />);
    fireEvent.click(await screen.findByRole("button", { name: "Abrir cupom Cupom 1" }));
    await screen.findByRole("dialog", { name: "Cupom Cupom 1" });
    expect(screen.getByRole("button", { name: "Cupom anterior" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Próximo cupom" }));
    expect(await screen.findByRole("dialog", { name: "Cupom Loja do Zé" })).toBeInTheDocument();
    expect(adminCupomDetalhe).toHaveBeenLastCalledWith("2");

    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(await screen.findByRole("dialog", { name: "Cupom Cupom 1" })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("o destaque abre o cupom direto", async () => {
    render(<PageAdminCupons />);
    await screen.findByText("Cupom 1");
    fireEvent.click(screen.getByRole("button", { name: /15% OFF · CASA15/ }));
    expect(await screen.findByRole("dialog", { name: "Cupom Cupom 1" })).toBeInTheDocument();
  });
});
