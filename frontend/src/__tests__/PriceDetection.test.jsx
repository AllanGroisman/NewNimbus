// Admin › Repasse › Detecção de preço (Shopee): o card carrega a config só ao
// abrir, o testador mostra o preço achado e se ele troca o da Shopee.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("../data/api", () => ({
  errText: (err, fallback) => err?.message || fallback,
  adminRepassePriceConfig: vi.fn(),
  adminRepassePriceConfigSave: vi.fn(),
  adminRepassePriceTest: vi.fn(),
}));

import PriceDetection from "../components/admin/PriceDetection.jsx";
import { adminRepassePriceConfig, adminRepassePriceConfigSave, adminRepassePriceTest } from "../data/api";

const CONFIG = { triggers: ["r$", "por", "pix"], ignore: ["off", "frete"], minPct: 50 };

beforeEach(() => {
  vi.clearAllMocks();
  adminRepassePriceConfig.mockResolvedValue({ config: CONFIG, defaults: CONFIG });
});

function abrir() {
  render(<PriceDetection />);
  fireEvent.click(screen.getByText(/Detecção de preço na legenda/));
}

describe("PriceDetection", () => {
  it("só busca a config quando o card abre", async () => {
    render(<PriceDetection />);
    expect(adminRepassePriceConfig).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText(/Detecção de preço na legenda/));
    await screen.findByText("Palavras-gatilho");
    expect(adminRepassePriceConfig).toHaveBeenCalledTimes(1);
  });

  it("testador mostra o preço achado e o De/Por do envio", async () => {
    adminRepassePriceTest.mockResolvedValue({
      price: 1520, candidates: [1739.9, 1520],
      troca: { price: 1520, originalPrice: 1739.9, discount: 13 },
    });
    abrir();
    fireEvent.click(await screen.findByText("Testar"));
    await screen.findByText(/R\$ 1\.520,00/, { selector: "strong" });
    expect(screen.getByText(/13% OFF/)).toBeTruthy();
    expect(adminRepassePriceTest).toHaveBeenCalledWith(expect.any(String), CONFIG, 1739.9);
  });

  it("diz quando não troca e quando não acha preço", async () => {
    adminRepassePriceTest.mockResolvedValueOnce({ price: 800, candidates: [800], troca: null });
    abrir();
    fireEvent.click(await screen.findByText("Testar"));
    await screen.findByText(/Não troca/);

    adminRepassePriceTest.mockResolvedValueOnce({ price: null, candidates: [] });
    fireEvent.click(screen.getByText("Testar"));
    await screen.findByText("Nenhum preço detectado.");
  });

  it("salvar manda a config e mostra a que o servidor gravou", async () => {
    adminRepassePriceConfigSave.mockResolvedValue({ config: { ...CONFIG, minPct: 60 } });
    abrir();
    fireEvent.click(await screen.findByText("Salvar"));
    await screen.findByText("Salvo.");
    expect(adminRepassePriceConfigSave).toHaveBeenCalledWith(CONFIG);
    await waitFor(() => expect(screen.getByDisplayValue("60")).toBeTruthy());
  });
});
