// Seletor de período (components/ui/SeletorPeriodo.jsx): chips, "Escolher
// datas" (só aplica no "Ver") e a linha ‹ período › com os limites da tela.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import SeletorPeriodo from "../components/ui/SeletorPeriodo.jsx";

// 19/10/2026 (segunda) às 15h em Brasília.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-19T18:00:00Z"));
});
afterEach(() => vi.useRealTimers());

const PRESETS = ["ontem", "7d", "30d"];

function monta(props = {}) {
  const onChange = vi.fn();
  const utils = render(<SeletorPeriodo valor={{ id: "7d" }} onChange={onChange} presets={PRESETS} max="2026-10-18" maxDias={180} {...props} />);
  return { onChange, ...utils };
}

describe("SeletorPeriodo", () => {
  it("o chip do período acende e o rótulo mostra as datas", () => {
    monta();
    expect(screen.getByRole("button", { name: "7 dias" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("12/10 a 18/10")).toBeInTheDocument();
  });

  it("‹ volta o mesmo tamanho; › some no limite", () => {
    const { onChange } = monta();
    expect(screen.getByRole("button", { name: "Próximo período" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Período anterior" }));
    expect(onChange).toHaveBeenCalledWith({ id: "custom", from: "2026-10-05", to: "2026-10-11" });
  });

  it("voltar pra um intervalo que é um preset acende o chip de novo", () => {
    const { onChange } = monta({ valor: { id: "custom", from: "2026-10-05", to: "2026-10-11" } });
    fireEvent.click(screen.getByRole("button", { name: "Próximo período" }));
    expect(onChange).toHaveBeenCalledWith({ id: "7d" });
  });

  it("'Escolher datas' só aplica no 'Ver'; 'De' depois do 'Até' leva o 'Até' junto", () => {
    const { onChange, container } = monta();
    fireEvent.click(screen.getByRole("button", { name: "Escolher datas" }));
    expect(screen.getByText(/Para um dia só, use a mesma data/)).toBeInTheDocument();
    const [de, ate] = container.querySelectorAll('input[type="date"]');
    expect(de).toHaveValue("2026-10-12");
    expect(ate).toHaveAttribute("max", "2026-10-18");

    fireEvent.change(de, { target: { value: "2026-10-15" } });
    expect(ate).toHaveValue("2026-10-18");
    fireEvent.change(ate, { target: { value: "2026-10-15" } });
    fireEvent.change(de, { target: { value: "2026-10-16" } });
    expect(ate).toHaveValue("2026-10-16");
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Ver" }));
    expect(onChange).toHaveBeenCalledWith({ id: "custom", from: "2026-10-16", to: "2026-10-16" });
  });

  it("um dia que é 'Ontem' vira o preset; período longo demais é recusado ali mesmo", () => {
    const { onChange, container } = monta();
    fireEvent.click(screen.getByRole("button", { name: "Escolher datas" }));
    const [de, ate] = container.querySelectorAll('input[type="date"]');
    fireEvent.change(de, { target: { value: "2026-01-01" } });
    fireEvent.change(ate, { target: { value: "2026-10-18" } });
    fireEvent.click(screen.getByRole("button", { name: "Ver" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Escolha um período de até 180 dias.");
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.change(de, { target: { value: "2026-10-18" } });
    fireEvent.click(screen.getByRole("button", { name: "Ver" }));
    expect(onChange).toHaveBeenCalledWith({ id: "ontem" });
  });
});
