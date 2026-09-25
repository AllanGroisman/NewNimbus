// Admin › Produtos: o "Apagar todos" só apaga depois de confirmar no modal, e a
// lista recarrega em seguida.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("../data/api", () => ({
  errText: (err, fallback) => err?.message || fallback,
  adminCatalog: vi.fn(),
  adminScraperConfig: vi.fn(),
  adminRunScraper: vi.fn(),
  adminScraperStatus: vi.fn(),
  adminClearCatalog: vi.fn(),
}));

import PageProducts from "../pages/Products.jsx";
import { adminCatalog, adminScraperConfig, adminScraperStatus, adminClearCatalog } from "../data/api";

beforeEach(() => {
  vi.clearAllMocks();
  adminScraperConfig.mockResolvedValue({ available: { categories: [], sources: [] } });
  adminScraperStatus.mockResolvedValue({ running: false });
  adminCatalog.mockResolvedValue({ items: [], total: 5 });
  adminClearCatalog.mockResolvedValue({ ok: true, removed: 5 });
});

describe("Apagar todos os produtos", () => {
  it("confirma no modal, apaga e recarrega a lista", async () => {
    render(<PageProducts />);
    await screen.findByText(/5 produtos no filtro atual/);
    const chamadasAntes = adminCatalog.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: /Apagar todos/ }));
    expect(adminClearCatalog).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Apagar tudo" }));

    await waitFor(() => expect(adminClearCatalog).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(adminCatalog.mock.calls.length).toBeGreaterThan(chamadasAntes));
  });

  it("cancelar não apaga nada", async () => {
    render(<PageProducts />);
    await screen.findByText(/5 produtos no filtro atual/);
    fireEvent.click(screen.getByRole("button", { name: /Apagar todos/ }));
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByText("Apagar todo o catálogo?")).toBeNull();
    expect(adminClearCatalog).not.toHaveBeenCalled();
  });
});
