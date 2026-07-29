import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import TourOverlay from "../components/onboarding/TourOverlay";

// jsdom não faz layout: todo elemento mede 0x0 e o TourOverlay trataria isso
// como "alvo invisível". Aqui damos tamanho a quem tem data-tour — menos ao
// alvo "sumido", que é justamente o caso que o tour precisa pular.
const mk = (top, left) => ({ top, left, width: 120, height: 40, right: left + 120, bottom: top + 40, x: left, y: top });
const rect = mk(100, 50);
const zero = { top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0 };
// "dois" fica mais abaixo na tela: é o que permite conferir o retângulo único
// que cobre vários alvos de um passo só.
const rects = { um: rect, dois: mk(200, 50) };

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.getBoundingClientRect = function () {
    const anchor = this.getAttribute?.("data-tour");
    if (!anchor || anchor === "sumido") return { ...zero, toJSON: () => zero };
    const r = rects[anchor] || rect;
    return { ...r, toJSON: () => r };
  };
});
afterEach(cleanup);

const Alvos = () => (
  <div>
    <button data-tour="um">Um</button>
    <button data-tour="dois">Dois</button>
    <button data-tour="sumido">Some no layout</button>
  </div>
);

const tour = {
  id: "teste",
  title: "Tour de teste",
  steps: [
    { anchor: "um", title: "Primeiro", text: "Explicação um" },
    { anchor: "dois", title: "Segundo", text: "Explicação dois" },
  ],
};

describe("TourOverlay", () => {
  it("mostra o passo atual e avança/volta", async () => {
    render(<><Alvos /><TourOverlay tour={tour} onFinish={vi.fn()} /></>);

    expect(await screen.findByText("Primeiro")).toBeInTheDocument();
    expect(screen.getByText(/1 de 2/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Próximo/ }));
    expect(await screen.findByText("Segundo")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Voltar/ }));
    expect(await screen.findByText("Primeiro")).toBeInTheDocument();
  });

  it("no último passo o botão termina o tour", async () => {
    const onFinish = vi.fn();
    render(<><Alvos /><TourOverlay tour={tour} onFinish={onFinish} /></>);
    await screen.findByText("Primeiro");

    fireEvent.click(screen.getByRole("button", { name: /Próximo/ }));
    await screen.findByText("Segundo");
    fireEvent.click(screen.getByRole("button", { name: /Terminar/ }));

    expect(onFinish).toHaveBeenCalled();
  });

  it("ESC sai do tour", async () => {
    const onFinish = vi.fn();
    render(<><Alvos /><TourOverlay tour={tour} onFinish={onFinish} /></>);
    await screen.findByText("Primeiro");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onFinish).toHaveBeenCalled();
  });

  it("passo com alvo que não existe na tela é pulado sem travar", async () => {
    const comSumido = {
      ...tour,
      steps: [
        { anchor: "nao-existe-em-lugar-nenhum", title: "Fantasma", text: "não deve aparecer" },
        { anchor: "sumido", title: "Escondido", text: "também não" },
        { anchor: "dois", title: "Segundo", text: "Explicação dois" },
      ],
    };
    render(<><Alvos /><TourOverlay tour={comSumido} onFinish={vi.fn()} /></>);

    await waitFor(() => expect(screen.getByText("Segundo")).toBeInTheDocument(), { timeout: 4000 });
    expect(screen.queryByText("Fantasma")).not.toBeInTheDocument();
  });

  it("tour sem nenhum alvo na tela termina em vez de travar", async () => {
    const onFinish = vi.fn();
    const fantasma = { ...tour, steps: [{ anchor: "nada", title: "X", text: "y" }] };
    render(<TourOverlay tour={fantasma} onFinish={onFinish} />);

    await waitFor(() => expect(onFinish).toHaveBeenCalled(), { timeout: 4000 });
  });

  it("passo com vários alvos ilumina um retângulo cobrindo todos", async () => {
    const varios = {
      ...tour,
      steps: [{ anchor: ["um", "dois", "nao-existe"], title: "Os dois", text: "junto" }],
    };
    render(<><Alvos /><TourOverlay tour={varios} onFinish={vi.fn()} /></>);
    await screen.findByText("Os dois");

    // "um" começa em y=100 e "dois" termina em y=240 → 140px de altura, mais a
    // folga de 6px de cada lado que o holofote aplica.
    const holofote = document.querySelector('[aria-hidden="true"]');
    expect(holofote.style.top).toBe("94px");
    expect(holofote.style.height).toBe("152px");
  });

  it("passo com aba avisa a campanha pra abrir aquela aba", async () => {
    const abas = { ...tour, steps: [{ tab: "queue", anchor: "um", title: "Fila", text: "z" }] };
    const ouvinte = vi.fn();
    window.addEventListener("nimbus:tour-tab", ouvinte);
    render(<><Alvos /><TourOverlay tour={abas} onFinish={vi.fn()} /></>);
    await screen.findByText("Fila");
    window.removeEventListener("nimbus:tour-tab", ouvinte);

    expect(ouvinte).toHaveBeenCalled();
    expect(ouvinte.mock.calls[0][0].detail).toBe("queue");
  });

  it("enquanto o alvo não foi medido, nenhum balão aparece no meio da tela", () => {
    const varios = { ...tour, steps: [{ anchor: "um", title: "Primeiro", text: "Explicação um" }] };
    render(<><Alvos /><TourOverlay tour={varios} onFinish={vi.fn()} /></>);

    // Antes do primeiro quadro só existe o escurecido — o balão só nasce colado
    // no alvo (era isso que fazia o popup piscar no centro).
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
