// Admin › Cupom › aba "Repasse" — os cupons que a captura pescou nas legendas
// dos grupos líderes.
//
// O que estes testes protegem é a distinção que a tela existe pra fazer: "nunca
// testado" NÃO é "o ML não reconheceu". A esmagadora maioria das linhas nunca foi
// ao ML, e mostrar isso como veredito negativo faria o admin descartar cupom bom.
// Depois disso, que cada ação apareça só onde ela resolve alguma coisa — e que o
// teste disparado daqui marque a origem "repasse" na palavra.
//
// E, desde que o robô existe, que a tela diga QUEM testou: "por aqui" (alguém
// clicou) e "automático" (o coupon-autotest.js) são a mesma data com significados
// diferentes, e é essa diferença que o admin vem conferir.

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
  adminRepasseAutotest: vi.fn(),
  adminRepasseAutotestSave: vi.fn(),
  adminRepasseAutotestRun: vi.fn(),
  adminRepasseAutotestLog: vi.fn(),
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
  adminRepasseAutotest, adminRepasseAutotestSave, adminRepasseAutotestRun, adminRepasseAutotestLog,
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

const statusRobo = (extra = {}) => ({
  enabled: true, running: false, agendado: true,
  lastRunAt: "2026-09-19T11:00:00Z", lastDuration: 42000,
  testados: 3, importados: 1, vitrines: 0,
  pulada: null, bloqueadoAte: null, lastError: null,
  nextRunAt: "2026-09-19T11:15:00Z", intervaloMs: 900000,
  ...extra,
});

const configRobo = {
  enabled: true, intervaloMs: 900000, maxPorRodada: 5, pausaEntrePalavrasMs: 20000,
  diasDeBusca: 90, minCapturas: 1, importarCampanha: true, rasparVitrine: true,
  maxImportsPorRodada: 1, maxTentativas: 3, esperaAposIndeterminadoHoras: 6,
  pausaAposBloqueioMin: 60,
};

// Abre o card do robô (ele nasce fechado: a config muda uma vez por mês e a aba
// já faz a sua própria consulta ao abrir).
async function abrirCardDoRobo() {
  fireEvent.click(screen.getByText(/Teste automático dos cupons/));
  await waitFor(() => expect(adminRepasseAutotest).toHaveBeenCalled());
}

beforeEach(() => {
  vi.clearAllMocks();
  // Sem extensão é o padrão: o teste de palavra cai no caminho do servidor.
  coletorEntende.mockResolvedValue(false);
  adminRepasseLogs.mockResolvedValue({ items: [] });
  adminRepasseAutotest.mockResolvedValue({ config: configRobo, defaults: configRobo, status: statusRobo() });
  adminRepasseAutotestLog.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
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

describe("Admin › Cupom › Repasse — quem testou a palavra", () => {
  it("separa o teste pedido na tela do que o robô fez sozinho", async () => {
    // A mesma data com origens diferentes. Sem o rótulo, a tela diria "testado
    // 14h32" e deixaria no ar se alguém clicou ou se aquilo aconteceu sozinho.
    await abrir([
      cupom({ code: "JBL20", verdict: "valid", checkedAt: "2026-09-01T14:32:00Z", source: "repasse" }),
      cupom({ code: "AUTO10", verdict: "valid", checkedAt: "2026-09-02T09:10:00Z", source: "repasse-auto" }),
    ]);

    expect(within(linhaDe("JBL20")).getByText(/\(por aqui\)/)).toBeTruthy();
    expect(within(linhaDe("AUTO10")).getByText(/\(automático\)/)).toBeTruthy();
  });

  it("palavra testada pelo admin em outra aba não ganha rótulo de origem", async () => {
    await abrir([cupom({ verdict: "valid", checkedAt: "2026-09-01T14:32:00Z", source: "admin" })]);
    const linha = within(linhaDe("JBL20"));
    expect(linha.getByText(/testado/)).toBeTruthy();
    expect(linha.queryByText(/\(por aqui\)|\(automático\)/)).toBeNull();
  });
});

describe("Admin › Cupom › Repasse — o card do robô", () => {
  it("nasce fechado e não consulta nada até ser aberto", async () => {
    await abrir([cupom()]);
    expect(adminRepasseAutotest).not.toHaveBeenCalled();

    await abrirCardDoRobo();
    expect(adminRepasseAutotestLog).toHaveBeenCalled();
  });

  it("mostra o que a última rodada fez", async () => {
    await abrir([cupom()]);
    await abrirCardDoRobo();

    expect(await screen.findByText(/3 testada\(s\).*1 campanha\(s\)/)).toBeTruthy();
    expect(screen.getByText("ligado")).toBeTruthy();
  });

  it("explica a rodada que desistiu, em vez de mostrar só zero", async () => {
    adminRepasseAutotest.mockResolvedValue({
      config: configRobo, defaults: configRobo,
      status: statusRobo({ testados: 0, pulada: "Tem uma rodada de cupons do admin rodando — a rodada automática ficou pra próxima." }),
    });
    await abrir([cupom()]);
    await abrirCardDoRobo();

    expect(await screen.findByText(/rodada de cupons do admin rodando/)).toBeTruthy();
  });

  it("avisa quando o ML barrou e quando ele volta a tentar", async () => {
    const amanha = new Date(Date.now() + 3600_000).toISOString();
    adminRepasseAutotest.mockResolvedValue({
      config: configRobo, defaults: configRobo,
      status: statusRobo({ bloqueadoAte: amanha }),
    });
    await abrir([cupom()]);
    await abrirCardDoRobo();

    expect(await screen.findByText(/o ML barrou/)).toBeTruthy();
  });

  it("o diário lista o que o robô fez em cada cupom", async () => {
    adminRepasseAutotestLog.mockResolvedValue({
      total: 2, page: 1, pageSize: 20,
      items: [
        { id: "2", code: "JBL20", action: "import", ok: true, verdict: null, campaignId: "42", produtos: 34, errorKind: null, message: null, durationMs: 120000, createdAt: "2026-09-19T11:02:00Z" },
        { id: "1", code: "NAOEXISTE", action: "test", ok: false, verdict: "invalid", campaignId: null, produtos: null, errorKind: null, message: "Confira se o cupom está correto", durationMs: 30000, createdAt: "2026-09-19T11:00:00Z" },
      ],
    });
    await abrir([cupom()]);
    await abrirCardDoRobo();

    expect(await screen.findByText("trouxe a campanha")).toBeTruthy();
    expect(screen.getByText(/34 produto\(s\)/)).toBeTruthy();
    expect(screen.getByText(/o ML não reconheceu/)).toBeTruthy();
    expect(screen.getByText(/Confira se o cupom/)).toBeTruthy();
  });

  it("converte minutos e segundos pra ms ao salvar — a config guardada fala em ms", async () => {
    adminRepasseAutotestSave.mockResolvedValue({ config: configRobo, status: statusRobo() });
    await abrir([cupom()]);
    await abrirCardDoRobo();

    const campo = await screen.findByLabelText("A cada quantos minutos");
    expect(campo.value).toBe("15");
    fireEvent.change(campo, { target: { value: "30" } });
    fireEvent.click(screen.getByText("Salvar"));

    await waitFor(() => expect(adminRepasseAutotestSave).toHaveBeenCalled());
    expect(adminRepasseAutotestSave.mock.calls[0][0]).toMatchObject({ intervaloMs: 30 * 60_000 });
    // O campo de formulário não pode viajar junto: o servidor só conhece os ms.
    expect(adminRepasseAutotestSave.mock.calls[0][0]).not.toHaveProperty("intervaloMinutos");
  });

  it("avisa que trazer a campanha escreve na conta do ML", async () => {
    // É a única escrita que o sistema faz lá; quem liga o robô precisa saber.
    await abrir([cupom()]);
    await abrirCardDoRobo();
    expect(await screen.findByText(/ativa o cupom na conta do Mercado Livre/)).toBeTruthy();
  });

  it("o 'Rodar agora' dispara e relê o diário", async () => {
    adminRepasseAutotestRun.mockResolvedValue({ started: true, status: statusRobo() });
    await abrir([cupom()]);
    await abrirCardDoRobo();

    fireEvent.click(screen.getByText("Rodar agora"));
    await waitFor(() => expect(adminRepasseAutotestRun).toHaveBeenCalled());
    // A rodada segue solta no servidor; o card espera um instante antes de reler
    // pra primeira linha do diário já aparecer no clique. Daí o timeout folgado.
    await waitFor(() => expect(adminRepasseAutotest).toHaveBeenCalledTimes(2), { timeout: 4000 });
  });
});
