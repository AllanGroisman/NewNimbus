// Popup da mensagem no privado (tasks 4 e 6): a estimativa e o formulário. O
// ritmo de verdade mora no servidor; aqui o que importa é o popup não mentir
// sobre quantas pessoas e quanto tempo, e entregar o envio para o segundo plano.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("../data/api", () => ({
  errText: (err, fallback) => err?.message || fallback,
  startDmBroadcast: vi.fn(),
}));

import DmMembersModal, { estimativa } from "../components/campaign/DmMembersModal.jsx";
import { startDmBroadcast } from "../data/api";

const G1 = { id: "g1", name: "Ofertas", numberId: "n1", members: 11, connected: true };
const G2 = { id: "g2", name: "Ofertas #2", numberId: "n1", members: 501, connected: true };
const G3 = { id: "g3", name: "Outro", numberId: "n2", members: 51, connected: false };
const G4 = { id: "g4", name: "Ocupado", numberId: "n2", members: 21, connected: true, ocupado: true };

beforeEach(() => vi.clearAllMocks());

describe("estimativa", () => {
  it("desconta o próprio número de cada grupo", () => {
    expect(estimativa([G1]).pessoas).toBe(10);
  });
  it("pouca gente: minutos", () => {
    expect(estimativa([G1]).tempo).toMatch(/min/);
  });
  it("acima do teto diário de um número: dias", () => {
    // 10 + 500 no mesmo número → 510 → 3 dias de 200.
    expect(estimativa([G1, G2]).tempo).toMatch(/3 dias/);
  });
  it("números diferentes andam juntos: o tempo é o do número mais cheio", () => {
    // 100 em cada número: ~54 min, e não o dobro.
    const a = { numberId: "n1", members: 101 };
    const b = { numberId: "n2", members: 101 };
    expect(estimativa([a, b])).toEqual({ pessoas: 200, tempo: estimativa([a]).tempo });
  });
});

describe("DmMembersModal", () => {
  it("não envia sem texto", () => {
    render(<DmMembersModal campaignId={1} grupos={[G1]} onClose={() => {}} />);
    expect(screen.getByRole("button", { name: "Enviar no privado" })).toBeDisabled();
  });

  it("avisa quem fica de fora: número desconectado e grupo com envio andando", () => {
    render(<DmMembersModal campaignId={1} grupos={[G1, G3, G4]} todos onClose={() => {}} />);
    expect(screen.getByText(/"Outro" está com o número desconectado/)).toBeInTheDocument();
    expect(screen.getByText(/"Ocupado" já tem uma mensagem no privado indo/)).toBeInTheDocument();
    // Só o G1 vai.
    expect(screen.getByText(/Até ~10 pessoas/)).toBeInTheDocument();
  });

  it("sem nenhum grupo livre, não envia", () => {
    render(<DmMembersModal campaignId={1} grupos={[G4]} onClose={() => {}} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Mensagem" }), { target: { value: "Oi" } });
    expect(screen.getByRole("button", { name: "Enviar no privado" })).toBeDisabled();
  });

  it("envia e entrega para o segundo plano (onStarted), sem tela de progresso", async () => {
    startDmBroadcast.mockResolvedValue({ broadcast: { id: "5", status: "preparing", grupos: [] } });
    const onStarted = vi.fn();
    render(<DmMembersModal campaignId={1} grupos={[G1]} onClose={() => {}} onStarted={onStarted} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Mensagem" }), { target: { value: "  Oi  " } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar no privado" }));
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith(expect.objectContaining({ id: "5" })));
    expect(startDmBroadcast).toHaveBeenCalledWith(1, { whatsappGroupIds: ["g1"], text: "Oi" });
    expect(screen.queryByRole("button", { name: "Cancelar envio" })).not.toBeInTheDocument();
  });

  it("erro do servidor fica no popup e libera o botão", async () => {
    startDmBroadcast.mockRejectedValue(Object.assign(new Error('"Ofertas" já tem uma mensagem no privado indo.'), { status: 409 }));
    const onStarted = vi.fn();
    render(<DmMembersModal campaignId={1} grupos={[G1]} onClose={() => {}} onStarted={onStarted} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Mensagem" }), { target: { value: "Oi" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar no privado" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/já tem uma mensagem no privado indo/);
    expect(screen.getByRole("button", { name: "Enviar no privado" })).not.toBeDisabled();
    expect(onStarted).not.toHaveBeenCalled();
  });
});
