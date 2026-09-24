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
  adminRepasseCupomCheckoutPendentes: vi.fn(),
  adminRepasseCupomCheckoutReivindicar: vi.fn(),
  adminRepasseCupomCheckoutResultado: vi.fn(),
  adminRepasseCupomCheckoutAuto: vi.fn(),
  adminRepasseCupomCheckoutManual: vi.fn(),
  adminRepasseCupomCheckoutManualRemover: vi.fn(),
}));

// A extensão do Chrome (extension/ na raiz). O teste de palavra prefere ela quando
// está instalada; aqui o padrão é NÃO estar, que é o caminho do servidor.
vi.mock("../data/coletor", () => ({
  coletorEntende: vi.fn(),
  testarPalavraNoChrome: vi.fn(),
  cupomNoCheckout: vi.fn(),
}));

import CuponsDoRepasse from "../pages/AdminCupomRepasse.jsx";
import { coletorEntende, testarPalavraNoChrome, cupomNoCheckout } from "../data/coletor";
import {
  adminRepasseCoupons, adminRepasseLogs, adminMlCuponsTestWord,
  adminMlCuponsSyncProducts, adminMlCuponsImportCampaign, adminMlCuponsImportStatus,
  adminRepasseCouponForget, adminRepasseCouponsClear,
  adminRepasseAutotest, adminRepasseAutotestSave, adminRepasseAutotestRun, adminRepasseAutotestLog,
  adminRepasseCupomCheckoutPendentes, adminRepasseCupomCheckoutReivindicar, adminRepasseCupomCheckoutResultado,
  adminRepasseCupomCheckoutAuto, adminRepasseCupomCheckoutManual, adminRepasseCupomCheckoutManualRemover,
} from "../data/api";

const cupom = (extra = {}) => ({
  code: "JBL20",
  capturas: 12, primeira: "2026-08-01T10:00:00Z", ultima: "2026-08-30T10:00:00Z",
  campanhas: 2, usuarios: 1, aproveitados: 9,
  verdict: null, campaignId: null, couponTitle: null, inSystem: null,
  message: null, source: null, checkedAt: null, checkCount: 0, produtos: 0,
  ...extra,
});

// A resposta da fila do teste no checkout.
const fila = (itens, extra = {}) => ({ itens, total: itens.length, auto: true, checkoutAuto: true, bloqueadoAte: null, ...extra });

const lista = (items) => ({ items, total: items.length, totalCapturados: items.length, page: 1, pageSize: 30 });

async function abrir(items) {
  adminRepasseCoupons.mockResolvedValue(lista(items));
  render(<CuponsDoRepasse />);
  await waitFor(() => expect(adminRepasseCoupons).toHaveBeenCalled());
  return (await screen.findAllByText("JBL20"))[0];
}

// A linha da tabela onde aquele código está — as ações são todas por linha.
// O mesmo código pode estar também no card da fila: a linha certa é a que tem o
// expansor das capturas.
function linhaDe(code) {
  return screen.getAllByText(code).map(el => el.closest("tr")).find(tr => tr && within(tr).queryByText(/capturas/));
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
  adminRepasseCupomCheckoutPendentes.mockResolvedValue(fila([]));
  adminRepasseCupomCheckoutReivindicar.mockResolvedValue({ ok: true });
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

// Task 7: o cupom testado no checkout do produto que chegou com ele, pela extensão.
describe("Admin › Cupom › Repasse — teste no checkout", () => {
  const LINK = "https://www.mercadolivre.com.br/caixa-jbl/p/MLB111";
  const MATERIAL = { checkout: { reached: true }, modal: { aberto: true } };
  const RESPOSTA = {
    verdict: "valid", message: "Aplicado no checkout · 20% OFF · mínimo R$ 99",
    campaignId: null, checkedAt: "2026-09-24T10:00:00Z", checkCount: 1, source: "repasse-checkout",
    resultado: { status: "aplicado_agora" },
  };
  const itemRepasse = (extra = {}) => ({ origem: "repasse", code: "JBL20", url: LINK, motivo: "nunca-testado", capturas: 12, criadoEm: "2026-08-01T10:00:00Z", reservado: false, ...extra });
  const itemManual = (extra = {}) => ({ origem: "manual", manualId: "7", code: "MELIKIDS", url: "https://www.mercadolivre.com.br/boneca/p/MLB9", motivo: "manual", criadoEm: "2026-09-24T09:00:00Z", reservado: false, ...extra });

  // Com a extensão nova: ela entende "cupom-no-checkout".
  const comExtensao = () => coletorEntende.mockImplementation(async (cmd) => cmd === "cupom-no-checkout");
  const cardDaFila = () => screen.getByRole("region", { name: "Fila do teste no checkout" });

  it("Testar da lista leva o código ao checkout do link que chegou com ele", async () => {
    comExtensao();
    adminRepasseCupomCheckoutPendentes.mockResolvedValue(fila([], { checkoutAuto: false, auto: false }));
    cupomNoCheckout.mockResolvedValue(MATERIAL);
    adminRepasseCupomCheckoutResultado.mockResolvedValue(RESPOSTA);
    await abrir([cupom({ link: LINK })]);
    await waitFor(() => expect(coletorEntende).toHaveBeenCalled());

    fireEvent.click(within(linhaDe("JBL20")).getByText("Testar"));

    await waitFor(() => expect(screen.getByText(/Aplicado no checkout · 20% OFF/)).toBeTruthy());
    expect(cupomNoCheckout).toHaveBeenCalledWith({ url: LINK, code: "JBL20" }, expect.anything());
    expect(adminRepasseCupomCheckoutResultado).toHaveBeenCalledWith(expect.objectContaining({
      code: "JBL20", url: LINK, material: MATERIAL, source: "repasse-checkout",
    }));
    expect(within(linhaDe("JBL20")).getByText(/no checkout, por aqui/)).toBeTruthy();
    expect(adminMlCuponsTestWord).not.toHaveBeenCalled();
    expect(testarPalavraNoChrome).not.toHaveBeenCalled();
  });

  it("sem link do ML, o Testar da lista cai no teste da palavra", async () => {
    comExtensao();
    adminMlCuponsTestWord.mockResolvedValue({ result: { word: "JBL20", verdict: "invalid" } });
    await abrir([cupom()]);
    await waitFor(() => expect(coletorEntende).toHaveBeenCalled());

    fireEvent.click(within(linhaDe("JBL20")).getByText("Testar"));

    await waitFor(() => expect(adminMlCuponsTestWord).toHaveBeenCalled());
    expect(cupomNoCheckout).not.toHaveBeenCalled();
  });

  it("a fila aparece com código, link e origem", async () => {
    adminRepasseCupomCheckoutPendentes.mockResolvedValue(fila([itemManual(), itemRepasse()], { checkoutAuto: false, auto: false }));
    await abrir([cupom()]);

    expect(await screen.findByText("MELIKIDS")).toBeTruthy();
    const card = cardDaFila();
    expect(within(card).getByText("manual")).toBeTruthy();
    expect(within(card).getByText(/repasse · 12 captura/)).toBeTruthy();
    expect(within(card).getByText(/caixa-jbl/).closest("a").getAttribute("href")).toBe(LINK);
    expect(within(card).getByText(/Testar todos \(2\)/)).toBeTruthy();
  });

  it("com o automático ligado, pega o primeiro da fila, reivindica, testa e atualiza a linha", async () => {
    comExtensao();
    // A primeira volta chega antes de se saber se há extensão; quem testa é a
    // volta que vem logo depois da resposta dela.
    adminRepasseCupomCheckoutPendentes.mockResolvedValue(fila([itemRepasse()]));
    cupomNoCheckout.mockResolvedValue(MATERIAL);
    adminRepasseCupomCheckoutResultado.mockResolvedValue({ ...RESPOSTA, source: "repasse-checkout-auto" });
    await abrir([cupom({ link: LINK })]);

    await waitFor(() => expect(adminRepasseCupomCheckoutResultado).toHaveBeenCalled());
    expect(adminRepasseCupomCheckoutReivindicar).toHaveBeenCalledWith("JBL20");
    expect(adminRepasseCupomCheckoutResultado.mock.calls[0][0]).toMatchObject({ code: "JBL20", url: LINK, source: "repasse-checkout-auto" });
    await waitFor(() => expect(within(linhaDe("JBL20")).getByText(/no checkout, automático/)).toBeTruthy());
  });

  it("com o automático desligado, a fila aparece mas nada é testado sozinho", async () => {
    comExtensao();
    adminRepasseCupomCheckoutPendentes.mockResolvedValue(fila([itemRepasse()], { checkoutAuto: false, auto: false }));
    await abrir([cupom({ link: LINK })]);
    await screen.findByText(/Testar todos \(1\)/);
    await waitFor(() => expect(coletorEntende).toHaveBeenCalled());
    expect(cupomNoCheckout).not.toHaveBeenCalled();
    expect(adminRepasseCupomCheckoutReivindicar).not.toHaveBeenCalled();
  });

  it("a checkbox liga e desliga o automático", async () => {
    adminRepasseCupomCheckoutPendentes.mockResolvedValue(fila([], { checkoutAuto: false, auto: false }));
    adminRepasseCupomCheckoutAuto.mockResolvedValue({ checkoutAuto: true });
    await abrir([cupom()]);
    const caixa = await screen.findByLabelText("Testar automaticamente");
    await waitFor(() => expect(caixa.disabled).toBe(false));

    fireEvent.click(caixa);
    await waitFor(() => expect(adminRepasseCupomCheckoutAuto).toHaveBeenCalledWith(true));
  });

  it("o Testar de um item testa só aquele, com o manualId do pedido", async () => {
    comExtensao();
    adminRepasseCupomCheckoutPendentes.mockResolvedValue(fila([itemManual(), itemRepasse()], { checkoutAuto: false, auto: false }));
    cupomNoCheckout.mockResolvedValue(MATERIAL);
    adminRepasseCupomCheckoutResultado.mockResolvedValue({ ...RESPOSTA, message: "Já estava aplicado no checkout" });
    await abrir([cupom({ link: LINK })]);
    await screen.findByText("MELIKIDS");
    await waitFor(() => expect(coletorEntende).toHaveBeenCalled());

    const linhaManual = within(cardDaFila()).getByText("MELIKIDS").closest("tr");
    await waitFor(() => expect(within(linhaManual).getByText("Testar").disabled).toBe(false));
    fireEvent.click(within(linhaManual).getByText("Testar"));

    await waitFor(() => expect(adminRepasseCupomCheckoutResultado).toHaveBeenCalledTimes(1));
    expect(adminRepasseCupomCheckoutResultado.mock.calls[0][0]).toMatchObject({ code: "MELIKIDS", manualId: "7", source: "repasse-checkout" });
    expect(await screen.findByText(/Já estava aplicado no checkout/)).toBeTruthy();
  });

  it("Testar todos anda a fila na ordem, um de cada vez", async () => {
    comExtensao();
    adminRepasseCupomCheckoutPendentes.mockResolvedValue(fila([itemManual(), itemRepasse()], { checkoutAuto: false, auto: false }));
    const ordem = [];
    cupomNoCheckout.mockImplementation(async ({ code }) => { ordem.push(code); return MATERIAL; });
    adminRepasseCupomCheckoutResultado.mockResolvedValue(RESPOSTA);
    await abrir([cupom({ link: LINK })]);
    await waitFor(() => expect(coletorEntende).toHaveBeenCalled());
    const botao = await screen.findByText(/Testar todos \(2\)/);
    await waitFor(() => expect(botao.disabled).toBe(false));

    fireEvent.click(botao);

    await waitFor(() => expect(ordem).toEqual(["MELIKIDS", "JBL20"]));
  });

  it("Parar interrompe o Testar todos depois do cupom atual", async () => {
    comExtensao();
    adminRepasseCupomCheckoutPendentes.mockResolvedValue(fila([itemManual(), itemRepasse()], { checkoutAuto: false, auto: false }));
    let soltar;
    cupomNoCheckout.mockImplementationOnce(() => new Promise(r => { soltar = () => r(MATERIAL); }));
    adminRepasseCupomCheckoutResultado.mockResolvedValue(RESPOSTA);
    await abrir([cupom({ link: LINK })]);
    await waitFor(() => expect(coletorEntende).toHaveBeenCalled());
    const botao = await screen.findByText(/Testar todos \(2\)/);
    await waitFor(() => expect(botao.disabled).toBe(false));

    fireEvent.click(botao);
    fireEvent.click(await screen.findByText("■ Parar"));
    await waitFor(() => expect(soltar).toBeTypeOf("function"));
    soltar();

    await waitFor(() => expect(screen.getByText(/Testar todos/)).toBeTruthy());
    expect(cupomNoCheckout).toHaveBeenCalledTimes(1);
  });

  it("+ Adicionar teste manda link e código, e o item entra na fila", async () => {
    adminRepasseCupomCheckoutManual.mockResolvedValue(itemManual());
    await abrir([cupom()]);

    fireEvent.click(await screen.findByText("+ Adicionar teste"));
    fireEvent.change(screen.getByLabelText("Link do produto (Mercado Livre)"), { target: { value: "https://www.mercadolivre.com.br/boneca/p/MLB9" } });
    fireEvent.change(screen.getByLabelText("Código do cupom"), { target: { value: "melikids" } });
    adminRepasseCupomCheckoutPendentes.mockResolvedValue(fila([itemManual()], { checkoutAuto: false, auto: false }));
    fireEvent.click(screen.getByText("Adicionar à fila"));

    await waitFor(() => expect(adminRepasseCupomCheckoutManual).toHaveBeenCalledWith({ code: "MELIKIDS", url: "https://www.mercadolivre.com.br/boneca/p/MLB9" }));
    expect(await screen.findByText(/MELIKIDS entrou no começo da fila/)).toBeTruthy();
  });

  it("o erro do servidor aparece no próprio modal", async () => {
    adminRepasseCupomCheckoutManual.mockRejectedValue(new Error("O link precisa ser de um produto do Mercado Livre."));
    await abrir([cupom()]);

    fireEvent.click(await screen.findByText("+ Adicionar teste"));
    fireEvent.change(screen.getByLabelText("Link do produto (Mercado Livre)"), { target: { value: "https://amazon.com.br/x" } });
    fireEvent.change(screen.getByLabelText("Código do cupom"), { target: { value: "X10" } });
    fireEvent.click(screen.getByText("Adicionar à fila"));

    expect(await screen.findByText(/precisa ser de um produto do Mercado Livre/)).toBeTruthy();
  });

  it("Remover tira o pedido manual da fila", async () => {
    adminRepasseCupomCheckoutPendentes.mockResolvedValue(fila([itemManual()], { checkoutAuto: false, auto: false }));
    adminRepasseCupomCheckoutManualRemover.mockResolvedValue({ removido: 1 });
    await abrir([cupom()]);

    fireEvent.click(await screen.findByText("Remover"));
    await waitFor(() => expect(adminRepasseCupomCheckoutManualRemover).toHaveBeenCalledWith("7"));
  });

  it("sem a extensão nova, avisa e nada da fila é testado", async () => {
    adminRepasseCupomCheckoutPendentes.mockResolvedValue(fila([itemRepasse()]));
    await abrir([cupom({ link: LINK })]);
    expect(await screen.findByText(/não está instalada nesta aba, ou está desatualizada/)).toBeTruthy();
    expect(cupomNoCheckout).not.toHaveBeenCalled();
    expect(adminRepasseCupomCheckoutReivindicar).not.toHaveBeenCalled();
  });
});
