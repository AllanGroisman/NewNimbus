// Admin › Cupom › aba "Repasse" — os cupons que a captura pescou nas legendas
// dos grupos líderes.
//
// O que estes testes protegem é a distinção que a tela existe pra fazer: "nunca
// testado" NÃO é "o ML não reconheceu". A esmagadora maioria das linhas nunca foi
// ao ML, e mostrar isso como veredito negativo faria o admin descartar cupom bom.
// Depois disso, que cada ação apareça só onde ela resolve alguma coisa — e que o
// teste disparado daqui marque a origem "repasse" na palavra.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

vi.mock("../data/api", () => ({
  errText: (err, fallback) => err?.message || fallback,
  adminRepasseCoupons: vi.fn(),
  adminRepasseLogs: vi.fn(),
  adminMlCuponsTestWord: vi.fn(),
  adminMlCuponsSyncProducts: vi.fn(),
  adminMlCuponsImportCampaign: vi.fn(),
  adminMlCuponsImportStatus: vi.fn(),
  adminRepasseCouponForget: vi.fn(),
  adminRepasseCouponsClear: vi.fn(),
}));

// A extensão do Chrome (extension/ na raiz). O teste de palavra prefere ela quando
// está instalada; aqui o padrão é NÃO estar, que é o caminho do servidor.
vi.mock("../data/coletor", () => ({
  coletorEntende: vi.fn(),
  testarPalavraNoChrome: vi.fn(),
}));

import CuponsDoRepasse from "../pages/AdminCupomRepasse.jsx";
import { coletorEntende, testarPalavraNoChrome } from "../data/coletor";
import {
  adminRepasseCoupons, adminRepasseLogs, adminMlCuponsTestWord,
  adminMlCuponsSyncProducts, adminMlCuponsImportCampaign, adminMlCuponsImportStatus,
  adminRepasseCouponForget, adminRepasseCouponsClear,
} from "../data/api";

const cupom = (extra = {}) => ({
  code: "JBL20",
  capturas: 12, primeira: "2026-08-01T10:00:00Z", ultima: "2026-08-30T10:00:00Z",
  campanhas: 2, usuarios: 1, aproveitados: 9,
  verdict: null, campaignId: null, couponTitle: null, inSystem: null,
  message: null, source: null, checkedAt: null, checkCount: 0, produtos: 0,
  ...extra,
});

const lista = (items) => ({ items, total: items.length, totalCapturados: items.length, page: 1, pageSize: 30 });

async function abrir(items) {
  adminRepasseCoupons.mockResolvedValue(lista(items));
  render(<CuponsDoRepasse />);
  await waitFor(() => expect(adminRepasseCoupons).toHaveBeenCalled());
  return screen.findByText("JBL20");
}

// A linha da tabela onde aquele código está — as ações são todas por linha.
function linhaDe(code) {
  return screen.getByText(code).closest("tr");
}

beforeEach(() => {
  vi.clearAllMocks();
  // Sem extensão é o padrão: o teste de palavra cai no caminho do servidor.
  coletorEntende.mockResolvedValue(false);
  adminRepasseLogs.mockResolvedValue({ items: [] });
});

describe("Admin › Cupom › Repasse", () => {
  it("cupom nunca testado aparece como tal, e não como 'o ML não reconheceu'", async () => {
    await abrir([cupom()]);
    // Dentro da LINHA: "o ML não reconheceu" também é o rótulo de um filtro lá em
    // cima, e a busca solta acharia o <option> em vez do veredito.
    const linha = linhaDe("JBL20");
    expect(within(linha).getByText(/nunca testado/)).toBeTruthy();
    expect(within(linha).queryByText(/não reconheceu/)).toBeNull();
  });

  it("mostra o que o repasse viu: capturas, quantas foram pra fila e desde quando", async () => {
    await abrir([cupom()]);
    const linha = linhaDe("JBL20");
    expect(within(linha).getByText("12")).toBeTruthy();
    expect(within(linha).getByText(/9 na fila · 2 campanha/)).toBeTruthy();
  });

  it("testar manda a palavra com origem 'repasse' e atualiza a linha no lugar", async () => {
    await abrir([cupom()]);
    adminMlCuponsTestWord.mockResolvedValue({
      result: { word: "JBL20", verdict: "valid", campaignId: "13907402", coupon: { title: "20% JBL" } },
    });

    fireEvent.click(within(linhaDe("JBL20")).getByText("Testar"));

    await waitFor(() => expect(screen.getByText("20% JBL")).toBeTruthy());
    expect(adminMlCuponsTestWord).toHaveBeenCalledWith("JBL20", true, "repasse");
    expect(screen.getByText(/palavra existe/)).toBeTruthy();
    // A lista NÃO é recarregada: um filtro "nunca testados" jogaria a linha
    // recém-testada pra fora no meio da leitura.
    expect(adminRepasseCoupons).toHaveBeenCalledTimes(1);
  });

  it("'trazer campanha' só aparece quando a palavra vale e a campanha não está aqui", async () => {
    await abrir([
      cupom({ code: "JBL20", verdict: "valid", campaignId: "111", inSystem: false }),
    ]);
    // Na linha, não na página: o texto de apresentação da aba cita o botão.
    expect(within(linhaDe("JBL20")).getByText("Trazer campanha")).toBeTruthy();
  });

  it("campanha já no sistema não oferece 'trazer campanha'", async () => {
    await abrir([
      cupom({ verdict: "valid", campaignId: "111", inSystem: true, couponTitle: "20% JBL", produtos: 40 }),
    ]);
    const linha = linhaDe("JBL20");
    expect(within(linha).queryByText("Trazer campanha")).toBeNull();
    expect(within(linha).getByText(/no sistema · 40 produto/)).toBeTruthy();
  });

  it("campanha no sistema mas sem vitrine oferece raspar — e mostra o que veio", async () => {
    await abrir([
      cupom({ verdict: "valid", campaignId: "111", inSystem: true, couponTitle: "20% JBL", produtos: 0 }),
    ]);
    adminMlCuponsSyncProducts.mockResolvedValue({ produtos: 37 });

    fireEvent.click(screen.getByText("Raspar vitrine"));

    // O número aparece duas vezes de propósito: no aviso do que acabou de rodar e
    // na coluna da campanha, que a linha atualizou sozinha.
    await waitFor(() => expect(screen.getByText(/Vitrine raspada: 37 produto/)).toBeTruthy());
    expect(within(linhaDe("JBL20")).getByText(/no sistema · 37 produto/)).toBeTruthy();
    expect(adminMlCuponsSyncProducts).toHaveBeenCalledWith("111");
  });

  it("trocar o filtro de situação recarrega a lista com o status novo", async () => {
    await abrir([cupom()]);
    fireEvent.change(screen.getByLabelText("Situação"), { target: { value: "nao-testado" } });
    await waitFor(() => expect(adminRepasseCoupons).toHaveBeenCalledTimes(2));
    expect(adminRepasseCoupons.mock.calls[1][0]).toMatchObject({ status: "nao-testado", page: 1 });
  });

  it("expandir a linha busca as capturas daquele cupom", async () => {
    await abrir([cupom()]);
    adminRepasseLogs.mockResolvedValue({
      items: [{ id: "1", createdAt: "2026-08-30T10:00:00Z", outcome: "queued", groupName: "Ofertas TOP", productName: "Fone JBL" }],
    });

    fireEvent.click(screen.getByText("▼ capturas"));

    await waitFor(() => expect(screen.getByText("Fone JBL")).toBeTruthy());
    expect(adminRepasseLogs).toHaveBeenCalledWith({ coupon: "JBL20", pageSize: 20 });
    expect(screen.getByText("Ofertas TOP")).toBeTruthy();
  });

  it("o popup de trazer campanha reusa o da aba Descobrir palavra", async () => {
    await abrir([cupom({ verdict: "valid", campaignId: "13907402", inSystem: false })]);
    adminMlCuponsImportCampaign.mockResolvedValue({ already: true, ok: true, coupon: { title: "20% JBL" } });
    adminMlCuponsImportStatus.mockResolvedValue({ running: false });

    fireEvent.click(within(linhaDe("JBL20")).getByText("Trazer campanha"));
    expect(screen.getByText(/Essa campanha não está no sistema/)).toBeTruthy();

    fireEvent.click(screen.getByText(/Buscar/));
    await waitFor(() => expect(adminMlCuponsImportCampaign).toHaveBeenCalledWith("13907402", true));
  });

  it("lista vazia diz que não há cupom, sem parecer erro", async () => {
    adminRepasseCoupons.mockResolvedValue(lista([]));
    render(<CuponsDoRepasse />);
    await waitFor(() => expect(screen.getByText(/Nenhum cupom capturado/)).toBeTruthy());
  });
});

// A lista acumula lixo do extractCoupon ("AQUI", "PROMO"), que enterra o cupom de
// verdade. Excluir é uma ação destrutiva de nome enganoso — nada é apagado do log
// — então o que se protege aqui é: só apaga depois de confirmar, e a confirmação
// diz a verdade sobre o que acontece.
describe("Admin › Cupom › Repasse — excluir", () => {
  it("o Excluir da linha só chama a API depois da confirmação", async () => {
    await abrir([cupom()]);
    adminRepasseCouponForget.mockResolvedValue({ ok: true, capturas: 12 });

    fireEvent.click(within(linhaDe("JBL20")).getByText("Excluir"));
    expect(adminRepasseCouponForget).not.toHaveBeenCalled();
    expect(screen.getByText("Excluir o cupom JBL20?")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Excluir cupom" }));
    await waitFor(() => expect(adminRepasseCouponForget).toHaveBeenCalledWith("JBL20"));
    // Recarrega de verdade: a linha some e o total tem que acompanhar.
    await waitFor(() => expect(adminRepasseCoupons).toHaveBeenCalledTimes(2));
  });

  it("cancelar não apaga nada", async () => {
    await abrir([cupom()]);
    fireEvent.click(within(linhaDe("JBL20")).getByText("Excluir"));
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));

    await waitFor(() => expect(screen.queryByText("Excluir o cupom JBL20?")).toBeNull());
    expect(adminRepasseCouponForget).not.toHaveBeenCalled();
    expect(adminRepasseCoupons).toHaveBeenCalledTimes(1);
  });

  it("a confirmação avisa que a captura fica e que o cupom pode voltar", async () => {
    await abrir([cupom()]);
    fireEvent.click(within(linhaDe("JBL20")).getByText("Excluir"));

    expect(screen.getByText(/continuam no log/)).toBeTruthy();
    expect(screen.getByText(/continua guardada/)).toBeTruthy();
    expect(screen.getByText(/volta pra esta lista/)).toBeTruthy();
  });

  it("o Limpar lista manda os filtros em vigor, e os nomeia na confirmação", async () => {
    await abrir([cupom({ verdict: "invalid" })]);
    adminRepasseCouponsClear.mockResolvedValue({ ok: true, cupons: 1, capturas: 12 });

    fireEvent.change(screen.getByLabelText("Situação"), { target: { value: "invalid" } });
    await waitFor(() => expect(adminRepasseCoupons).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByText(/Limpar lista \(/));
    // O filtro vai escrito por extenso: limpar 200 achando que eram os 12 da tela
    // é o erro caro aqui. Dentro do modal: os mesmos rótulos são <option> dos
    // selects lá em cima, e a busca solta acharia os dois.
    const modal = screen.getByRole("dialog");
    expect(within(modal).getByText("O ML não reconheceu")).toBeTruthy();
    expect(within(modal).getByText("90 dias")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Limpar lista" }));
    await waitFor(() => expect(adminRepasseCouponsClear).toHaveBeenCalledWith({
      days: "90", status: "invalid", q: "",
    }));
  });

  it("sem cupom na lista não há o que limpar", async () => {
    adminRepasseCoupons.mockResolvedValue(lista([]));
    render(<CuponsDoRepasse />);
    await waitFor(() => expect(screen.getByText(/Nenhum cupom capturado/)).toBeTruthy());
    expect(screen.getByText("🗑 Limpar lista (0)").disabled).toBe(true);
  });
});
