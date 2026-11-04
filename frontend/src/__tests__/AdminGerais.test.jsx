// Admin → Gerais: interruptores de função (backend/feature-flags.js).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("../data/api", () => ({
  errText: (err, fallback) => err?.message || fallback,
  featuresGet: vi.fn(),
  adminFeaturesSave: vi.fn(),
}));

import PageAdminGerais from "../pages/AdminGerais.jsx";
import { featuresGet, adminFeaturesSave } from "../data/api";

beforeEach(() => {
  vi.clearAllMocks();
  featuresGet.mockResolvedValue({ flags: { repasseWordFilter: true } });
});

describe("AdminGerais", () => {
  it("desligar a lista de palavras grava na hora", async () => {
    adminFeaturesSave.mockResolvedValue({ ok: true, flags: { repasseWordFilter: false } });
    render(<PageAdminGerais />);
    const sw = await screen.findByRole("switch", { name: "Lista de palavras no repasse" });
    expect(sw).toHaveAttribute("aria-checked", "true");

    fireEvent.click(sw);
    expect(adminFeaturesSave).toHaveBeenCalledWith({ repasseWordFilter: false });
    await waitFor(() => expect(sw).toHaveAttribute("aria-checked", "false"));
    expect(await screen.findByText(/Salvo/)).toBeInTheDocument();
  });

  it("erro ao salvar volta a chave pro estado anterior", async () => {
    adminFeaturesSave.mockRejectedValue(new Error("sem rede"));
    render(<PageAdminGerais />);
    const sw = await screen.findByRole("switch", { name: "Lista de palavras no repasse" });
    fireEvent.click(sw);
    expect(await screen.findByText("sem rede")).toBeInTheDocument();
    expect(sw).toHaveAttribute("aria-checked", "true");
  });
});
