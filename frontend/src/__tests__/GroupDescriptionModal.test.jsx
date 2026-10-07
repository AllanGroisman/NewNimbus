// Popup "Editar descrição" (task 3): a descrição real do grupo no WhatsApp. O que
// importa aqui é o popup abrir com o texto ATUAL do WhatsApp, gravar só onde o
// usuário mandou (este grupo ou todos da campanha) e não esconder falha.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("../data/api", () => ({
  errText: (err, fallback) => err?.message || fallback,
  getWAGroupDescription: vi.fn(),
  setWAGroupDescription: vi.fn(),
}));

import GroupDescriptionModal, { DESC_MAX } from "../components/campaign/GroupDescriptionModal.jsx";
import { getWAGroupDescription, setWAGroupDescription } from "../data/api";

const G1 = { id: "g1@g.us", name: "Ofertas", numberId: "n1", description: "texto velho do Nimbus", connected: true };
const G2 = { id: "g2@g.us", name: "Ofertas #2", numberId: "n1", connected: true };
const G3 = { id: "g3@g.us", name: "Outro", numberId: "n2", connected: false };

function abrir(props = {}) {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  render(<GroupDescriptionModal grupo={G1} grupos={[G1, G2, G3]} onSaved={onSaved} onClose={onClose} gapMs={0} {...props} />);
  return { onSaved, onClose };
}
const campo = () => screen.getByLabelText("Descrição do grupo");

beforeEach(() => {
  vi.clearAllMocks();
  getWAGroupDescription.mockResolvedValue({ description: "Regras: só ofertas" });
  setWAGroupDescription.mockResolvedValue({ ok: true });
});

describe("abrir", () => {
  it("vem com a descrição atual lida do WhatsApp", async () => {
    abrir();
    await waitFor(() => expect(campo()).toHaveValue("Regras: só ofertas"));
    expect(getWAGroupDescription).toHaveBeenCalledWith("n1", "g1@g.us");
    expect(screen.getByText(/Descrição atual do grupo no WhatsApp/)).toBeInTheDocument();
  });

  it("sem conseguir ler, fica com a última do Nimbus e avisa", async () => {
    getWAGroupDescription.mockRejectedValue(new Error("O número deste grupo está desconectado."));
    abrir();
    expect(await screen.findByText(/Não deu para ler a descrição do WhatsApp/)).toBeInTheDocument();
    expect(campo()).toHaveValue("texto velho do Nimbus");
  });

  it("não salva enquanto lê", () => {
    getWAGroupDescription.mockReturnValue(new Promise(() => {}));
    abrir();
    expect(screen.getByRole("button", { name: "Salvar só neste grupo" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Aplicar em todos/ })).toBeDisabled();
  });

  it("o que o usuário já digitou não é atropelado pela leitura", async () => {
    let responder;
    getWAGroupDescription.mockReturnValue(new Promise(r => { responder = r; }));
    abrir();
    fireEvent.change(campo(), { target: { value: "meu texto" } });
    responder({ description: "do WhatsApp" });
    await screen.findByText(/Descrição atual do grupo no WhatsApp/);
    expect(campo()).toHaveValue("meu texto");
  });
});

describe("salvar", () => {
  it("'Salvar só neste grupo' grava só ele e fecha", async () => {
    const { onSaved, onClose } = abrir();
    await waitFor(() => expect(campo()).toHaveValue("Regras: só ofertas"));
    fireEvent.change(campo(), { target: { value: "  Nova descrição  " } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar só neste grupo" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(setWAGroupDescription).toHaveBeenCalledTimes(1);
    expect(setWAGroupDescription).toHaveBeenCalledWith("n1", "g1@g.us", "Nova descrição");
    expect(onSaved).toHaveBeenCalledWith([{ id: "g1@g.us", name: "Ofertas", ok: true }], "Nova descrição");
  });

  it("'Aplicar em todos' pede confirmação, avisa quem está desconectado e grava um por um", async () => {
    const { onSaved, onClose } = abrir({ grupos: [G1, G2] });
    await waitFor(() => expect(campo()).toHaveValue("Regras: só ofertas"));
    fireEvent.click(screen.getByRole("button", { name: "Aplicar em todos os 2 grupos" }));
    expect(setWAGroupDescription).not.toHaveBeenCalled();
    expect(screen.getByText(/vai ser trocada por esta/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Aplicar em 2 grupos" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(setWAGroupDescription.mock.calls).toEqual([
      ["n1", "g1@g.us", "Regras: só ofertas"],
      ["n1", "g2@g.us", "Regras: só ofertas"],
    ]);
    expect(onSaved.mock.calls[0][0].every(r => r.ok)).toBe(true);
  });

  it("na confirmação, o grupo de número desconectado vem marcado", async () => {
    abrir();
    await waitFor(() => expect(campo()).toHaveValue("Regras: só ofertas"));
    fireEvent.click(screen.getByRole("button", { name: "Aplicar em todos os 3 grupos" }));
    expect(screen.getByText(/número desconectado — vai falhar/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Voltar" }));
    expect(campo()).toHaveValue("Regras: só ofertas");
  });

  it("falha parcial: o popup fica aberto com o motivo de cada um", async () => {
    setWAGroupDescription.mockImplementation(async (numberId, jid) => {
      if (jid === "g3@g.us") throw new Error("O número deste grupo está desconectado.");
      return { ok: true };
    });
    const { onSaved, onClose } = abrir();
    await waitFor(() => expect(campo()).toHaveValue("Regras: só ofertas"));
    fireEvent.click(screen.getByRole("button", { name: "Aplicar em todos os 3 grupos" }));
    fireEvent.click(screen.getByRole("button", { name: "Aplicar em 3 grupos" }));
    expect(await screen.findByText("Salvo em 2 de 3 grupos.")).toBeInTheDocument();
    expect(screen.getByText(/Outro — O número deste grupo está desconectado/)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(onSaved.mock.calls[0][0].map(r => r.ok)).toEqual([true, true, false]);
  });

  it("vazio apaga — e a confirmação do 'todos' diz isso", async () => {
    getWAGroupDescription.mockResolvedValue({ description: "" });
    abrir({ grupos: [G1, G2] });
    await screen.findByText(/Descrição atual do grupo no WhatsApp/);
    expect(screen.getByText("Vazio apaga a descrição do grupo.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Aplicar em todos os 2 grupos" }));
    expect(screen.getByText("apagada")).toBeInTheDocument();
  });

  it("acima do máximo do WhatsApp não deixa salvar", async () => {
    abrir();
    await waitFor(() => expect(campo()).toHaveValue("Regras: só ofertas"));
    fireEvent.change(campo(), { target: { value: "x".repeat(DESC_MAX + 1) } });
    expect(screen.getByRole("button", { name: "Salvar só neste grupo" })).toBeDisabled();
  });

  it("campanha com um grupo só: sem 'Aplicar em todos'", async () => {
    abrir({ grupos: [G1] });
    await waitFor(() => expect(campo()).toHaveValue("Regras: só ofertas"));
    expect(screen.queryByRole("button", { name: /Aplicar em todos/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Salvar" })).toBeEnabled();
  });
});
