// Faixa da mensagem no privado no cartão do grupo (task 6): o texto de cada
// fase, qual parte cada cartão mostra, e os botões de cancelar e dispensar.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import DmProgresso from "../components/campaign/DmProgresso.jsx";
import { textoDaParte, partesPorGrupo, lerDispensados, gravarDispensados } from "../components/campaign/dmPartes.js";

const parte = (extra = {}) => ({ whatsappGroupId: "g1", total: 40, sent: 12, failed: 0, canceled: 0, pending: 28, fase: "sending", nextAt: null, motivo: null, ...extra });
const envio = (extra = {}) => ({ id: "1", status: "running", text: "Oi", error: null, finishedAt: null, grupos: [], ...extra });

describe("textoDaParte", () => {
  it("cada fase em poucas palavras", () => {
    expect(textoDaParte(parte({ fase: "preparing" }), envio())).toMatch(/Montando a lista/);
    expect(textoDaParte(parte({ fase: "queued" }), envio())).toMatch(/Na fila/);
    expect(textoDaParte(parte(), envio())).toBe("Enviando…");
    expect(textoDaParte(parte({ fase: "waiting", nextAt: new Date().toISOString(), motivo: "teto de 200 por dia deste número" }), envio()))
      .toMatch(/^Aguardando até \d{2}:\d{2} \(teto de 200/);
  });
  it("terminada: concluído, cancelado ou o motivo da parada", () => {
    expect(textoDaParte(parte({ fase: "finished", pending: 0 }), envio({ status: "done" }))).toBe("Concluído");
    expect(textoDaParte(parte({ fase: "finished", pending: 0, canceled: 3 }), envio())).toBe("Cancelado");
    expect(textoDaParte(parte({ fase: "finished" }), envio({ status: "failed", error: "5 falhas" }))).toBe("Parou: 5 falhas");
  });
});

describe("partesPorGrupo", () => {
  const agora = Date.parse("2026-09-30T12:00:00Z");
  const horasAtras = (h) => new Date(agora - h * 3600e3).toISOString();

  it("a parte andando ganha de uma terminada mais nova", () => {
    const lista = [
      envio({ id: "2", status: "done", finishedAt: horasAtras(1), grupos: [parte({ fase: "finished" })] }),
      envio({ id: "1", grupos: [parte({ fase: "queued" })] }),
    ];
    expect(partesPorGrupo(lista, [], agora).get("g1").broadcast.id).toBe("1");
  });

  it("terminada: só a mais recente, por 24h, e some quando dispensada", () => {
    const lista = [
      envio({ id: "3", status: "done", finishedAt: horasAtras(2), grupos: [parte({ fase: "finished" })] }),
      envio({ id: "2", status: "done", finishedAt: horasAtras(3), grupos: [parte({ fase: "finished" })] }),
    ];
    expect(partesPorGrupo(lista, [], agora).get("g1").broadcast.id).toBe("3");
    // Dispensou a mais recente: a anterior não volta no lugar dela.
    expect(partesPorGrupo(lista, ["3:g1"], agora).has("g1")).toBe(false);
    const velha = [envio({ id: "9", status: "done", finishedAt: horasAtras(25), grupos: [parte({ fase: "finished" })] })];
    expect(partesPorGrupo(velha, [], agora).has("g1")).toBe(false);
  });

  it("cada grupo de um envio para todos tem a sua parte", () => {
    const lista = [envio({ grupos: [parte(), parte({ whatsappGroupId: "g2", fase: "waiting" })] })];
    const m = partesPorGrupo(lista, [], agora);
    expect(m.get("g1").parte.fase).toBe("sending");
    expect(m.get("g2").parte.fase).toBe("waiting");
  });
});

describe("dispensados no navegador", () => {
  beforeEach(() => localStorage.clear());
  it("grava e lê, guardando só os últimos 100", () => {
    gravarDispensados(Array.from({ length: 120 }, (_, i) => `${i}:g1`));
    const lidos = lerDispensados();
    expect(lidos).toHaveLength(100);
    expect(lidos[0]).toBe("20:g1");
  });
  it("lixo no storage vira lista vazia", () => {
    localStorage.setItem("nimbus.dmDispensados", "{quebrado");
    expect(lerDispensados()).toEqual([]);
  });
});

describe("DmProgresso", () => {
  it("andando: contagem, falhas e cancelar", () => {
    const onCancelar = vi.fn();
    render(<DmProgresso parte={parte({ failed: 2 })} broadcast={envio()} onCancelar={onCancelar} />);
    expect(screen.getByRole("status", { name: "Mensagem no privado" })).toHaveTextContent(/12 de 40.*Enviando….*2 com falha/);
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(onCancelar).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Dispensar" })).not.toBeInTheDocument();
  });

  it("terminada: sem cancelar, com dispensar", () => {
    const onDispensar = vi.fn();
    render(<DmProgresso parte={parte({ fase: "finished", sent: 40, pending: 0 })} broadcast={envio({ status: "done" })} onDispensar={onDispensar} />);
    expect(screen.getByRole("status")).toHaveTextContent(/40 de 40.*Concluído/);
    expect(screen.queryByRole("button", { name: "Cancelar" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dispensar" }));
    expect(onDispensar).toHaveBeenCalled();
  });
});
