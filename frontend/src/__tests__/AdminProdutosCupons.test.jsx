// Admin › Produtos: filtros de cupom e a lista de cupons no card.
//
// É a tela de conferência do vínculo cupom ↔ produto: o filtro tem que chegar ao
// backend (e não ser feito na página, que mentiria o total) e o card tem que
// mostrar TODOS os cupons do produto, com a origem do vínculo.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

vi.mock("../data/api", () => ({
  errText: (err, fallback) => err?.message || fallback,
  adminCatalog: vi.fn(),
  adminScraperConfig: vi.fn(),
  adminRunScraper: vi.fn(),
  adminScraperStatus: vi.fn(),
}));

import { adminCatalog, adminScraperConfig, adminScraperStatus } from "../data/api";
import PageProducts from "../pages/Products.jsx";
import { ProductGridCard } from "../components/ui/ProductCard.jsx";

const comCupons = {
  key: "k1", name: "Furadeira Boa", link: "https://ml.com/p/1", price: 100, discount: 20,
  store: "Mercado Livre", img: null,
  coupons: [
    { campaignId: "111", code: "CASA15", title: "Cupom Casa", kind: "percent", value: 15, origem: "vitrine", rotulo: "15% OFF" },
    { campaignId: "222", code: null, title: "Cupom Ferramentas", kind: "percent", value: 10, origem: "amostra" },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  adminScraperConfig.mockResolvedValue({ available: { categories: [], sources: [] } });
  adminScraperStatus.mockResolvedValue({ running: false });
  adminCatalog.mockResolvedValue({ items: [comCupons], total: 1 });
});

describe("ProductGridCard showCoupons", () => {
  it("lista cada cupom com palavra, título, origem e id", () => {
    render(<ProductGridCard product={comCupons} showCoupons />);
    const lista = screen.getByTestId("coupon-list");
    expect(within(lista).getByText(/CASA15/)).toBeTruthy();
    expect(within(lista).getByText(/sem palavra/)).toBeTruthy();
    expect(within(lista).getByText("Cupom Ferramentas")).toBeTruthy();
    expect(within(lista).getByText(/vitrine · #111/)).toBeTruthy();
    expect(within(lista).getByText(/amostra · #222/)).toBeTruthy();
  });

  it("sem cupom diz isso, e sem a prop o card não mostra a lista", () => {
    render(<ProductGridCard product={{ ...comCupons, coupons: undefined }} showCoupons />);
    expect(screen.getByText("Sem cupom vinculado")).toBeTruthy();
  });

  it("sem showCoupons fica o selo resumido de sempre", () => {
    render(<ProductGridCard product={comCupons} />);
    expect(screen.queryByTestId("coupon-list")).toBeNull();
  });
});

describe("PageProducts — filtros de cupom", () => {
  it("status, busca e origem vão para o backend", async () => {
    render(<PageProducts />);
    await waitFor(() => expect(adminCatalog).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText("Filtro de cupom"), { target: { value: "com-palavra" } });
    await waitFor(() => expect(adminCatalog).toHaveBeenLastCalledWith(expect.objectContaining({ cupom: "com-palavra" })));

    fireEvent.change(screen.getByLabelText("Origem do vínculo"), { target: { value: "amostra" } });
    await waitFor(() => expect(adminCatalog).toHaveBeenLastCalledWith(expect.objectContaining({ cupomOrigem: "amostra" })));

    fireEvent.change(screen.getByPlaceholderText(/Cupom: ID, palavra ou nome/), { target: { value: "CASA15" } });
    await waitFor(() => expect(adminCatalog).toHaveBeenLastCalledWith(expect.objectContaining({ cupomBusca: "CASA15" })), { timeout: 2000 });

    expect(await screen.findByTestId("coupon-list")).toBeTruthy();
  });

  it("desconto mínimo vai para o backend", async () => {
    render(<PageProducts />);
    await waitFor(() => expect(adminCatalog).toHaveBeenCalled());
    fireEvent.change(screen.getByDisplayValue("Todos descontos"), { target: { value: "30" } });
    await waitFor(() => expect(adminCatalog).toHaveBeenLastCalledWith(expect.objectContaining({ minDiscount: 30 })));
  });
});
