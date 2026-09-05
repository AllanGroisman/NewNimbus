// Tela que pede o telefone de quem entrou sem um (conta anterior à regra, conta
// criada pelo Google, conta provisionada por pagamento sem o número).
// O que importa aqui: manda o número JÁ normalizado, não bate no servidor com
// número torto, e o "Agora não" só existe quando pular é permitido.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import ConfirmarTelefone from "../pages/ConfirmarTelefone.jsx";

vi.mock("../data/api.js", () => ({
  // errText é helper puro (não faz rede) — usa a implementação de verdade.
  errText: (err, fallback) => err?.message || fallback,
  accountSetPhone: vi.fn(),
}));

import { accountSetPhone } from "../data/api.js";

const USER = { id: "u1", email: "fulano@example.com" };

function digitar(valor) {
  fireEvent.change(screen.getByPlaceholderText("(11) 99999-9999"), { target: { value: valor } });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ConfirmarTelefone — salvar", () => {
  it("manda o número normalizado (55 + DDD + 9 dígitos) e devolve o user novo", async () => {
    const userAtualizado = { ...USER, phone: "5511999999999", phoneRequired: false };
    accountSetPhone.mockResolvedValue({ ok: true, user: userAtualizado });
    const onDone = vi.fn();

    render(<ConfirmarTelefone user={USER} onDone={onDone} />);
    digitar("11999999999");
    fireEvent.click(screen.getByRole("button", { name: /Salvar e continuar/i }));

    await waitFor(() => expect(accountSetPhone).toHaveBeenCalledWith("5511999999999"));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(userAtualizado));
  });

  it("mascara enquanto digita", () => {
    render(<ConfirmarTelefone user={USER} onDone={vi.fn()} />);
    digitar("11999999999");
    expect(screen.getByPlaceholderText("(11) 99999-9999")).toHaveValue("(11) 99999-9999");
  });

  it("número inválido nem chega no servidor", async () => {
    render(<ConfirmarTelefone user={USER} onDone={vi.fn()} />);
    digitar("1133334444"); // fixo — não serve pra WhatsApp
    fireEvent.click(screen.getByRole("button", { name: /Salvar e continuar/i }));

    expect(await screen.findByText(/celular válido com DDD/i)).toBeInTheDocument();
    expect(accountSetPhone).not.toHaveBeenCalled();
  });

  it("erro do servidor aparece na tela e não fecha a tela", async () => {
    accountSetPhone.mockRejectedValue(new Error("Deu ruim no servidor"));
    const onDone = vi.fn();

    render(<ConfirmarTelefone user={USER} onDone={onDone} />);
    digitar("11999999999");
    fireEvent.click(screen.getByRole("button", { name: /Salvar e continuar/i }));

    expect(await screen.findByText("Deu ruim no servidor")).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
  });
});

describe("ConfirmarTelefone — pular", () => {
  it("com onSkip, o 'Agora não' chama quem passou a prop sem tocar no servidor", () => {
    const onSkip = vi.fn();
    render(<ConfirmarTelefone user={USER} onDone={vi.fn()} onSkip={onSkip} />);

    fireEvent.click(screen.getByRole("button", { name: /Agora não/i }));
    expect(onSkip).toHaveBeenCalled();
    expect(accountSetPhone).not.toHaveBeenCalled();
  });

  // É assim que a mesma tela serve nos pontos em que o número é inegociável.
  it("sem onSkip não há como pular", () => {
    render(<ConfirmarTelefone user={USER} onDone={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /Agora não/i })).toBeNull();
  });

  it("mostra a conta em que a pessoa está, pra não pedir o número da conta errada", () => {
    render(<ConfirmarTelefone user={USER} onDone={vi.fn()} />);
    expect(screen.getByText(USER.email)).toBeInTheDocument();
  });
});
