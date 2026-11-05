// A espera do envio pelo teste do cupom (scheduler.js:aguardandoCupom).
//
// O produto do repasse chega com uma palavra de cupom que o sistema às vezes ainda
// não conhece. Se ele sai na hora, o {preco_com_cupom} vai sem o desconto (78 dos
// 97 produtos do SEMPREPROMO num dia). A espera segura o item na fila por até
// `esperaCupomMin`, sem travar o resto da fila — e só quando ela pode dar em algo.

import "../helpers/env.js";
import { describe, it, expect, beforeEach, vi } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const backend = path.resolve(__dirname, "..", "..", "backend");
const scheduler = require(path.join(backend, "scheduler.js"));
const coupons = require(path.join(backend, "coupons"));
const autotest = require(path.join(backend, "repasse", "coupon-autotest.js"));
const cfgStore = require(path.join(backend, "repasse", "coupon-autotest-config.js"));

const MIN = 60_000;
const AGORA = new Date("2026-11-03T12:00:00Z").getTime();
const REPASSE = { id: 1, scraping: { kind: "repasse", autoSend: true } };

function item(over = {}) {
  return {
    key: "k1", name: "ETB", store: "Mercado Livre", source: "repasse", price: 1099,
    coupon: "SEMPREPROMO", addedAt: new Date(AGORA - 2 * MIN).toISOString(), ...over,
  };
}

let cfg;
beforeEach(() => {
  vi.restoreAllMocks();
  cfg = { ...cfgStore.DEFAULTS, esperaCupomMin: 15, checkoutAuto: true };
  vi.spyOn(cfgStore, "readConfig").mockImplementation(() => cfg);
  vi.spyOn(autotest, "status").mockReturnValue({ bloqueadoAte: null });
  vi.spyOn(coupons, "findCouponByCode").mockResolvedValue(null);
  vi.spyOn(coupons, "couponsListForKeys").mockResolvedValue(new Map());
  vi.spyOn(coupons, "findCodeCheck").mockResolvedValue(null);
  // Por padrão o produto sem palavra já foi sondado: os casos antigos não esperam.
  vi.spyOn(autotest, "sondaDoProduto").mockResolvedValue({ probedAt: new Date(AGORA - MIN), ok: true });
});

describe("aguardandoCupom", () => {
  it("segura o item com palavra ainda desconhecida, dentro do tempo", async () => {
    expect(await scheduler.aguardandoCupom(REPASSE, item(), AGORA)).toBe(true);
  });

  it("solta quando a espera passou", async () => {
    const velho = item({ addedAt: new Date(AGORA - 16 * MIN).toISOString() });
    expect(await scheduler.aguardandoCupom(REPASSE, velho, AGORA)).toBe(false);
  });

  it("solta assim que o cupom fica conhecido", async () => {
    coupons.findCouponByCode.mockResolvedValue({ code: "SEMPREPROMO", kind: "percent", value: 10, expiresAt: new Date(AGORA + 3600_000) });
    expect(await scheduler.aguardandoCupom(REPASSE, item(), AGORA)).toBe(false);
  });

  it("cupom conhecido mas vencido: continua esperando o novo teste", async () => {
    coupons.findCouponByCode.mockResolvedValue({ code: "SEMPREPROMO", kind: "percent", value: 10, expiresAt: new Date(AGORA - 3600_000) });
    expect(await scheduler.aguardandoCupom(REPASSE, item(), AGORA)).toBe(true);
  });

  it("palavra que o ML recusou não espera o teste dela — espera a sonda, como sem palavra", async () => {
    coupons.findCodeCheck.mockResolvedValue({ verdict: "invalid" });
    const comLink = item({ link: "https://produto.mercadolivre.com.br/MLB-1" });
    // Sonda já voltou (padrão do beforeEach): solta.
    expect(await scheduler.aguardandoCupom(REPASSE, comLink, AGORA)).toBe(false);
    // Produto ainda não sondado: segura até a sonda procurar outro cupom.
    autotest.sondaDoProduto.mockResolvedValue(null);
    expect(await scheduler.aguardandoCupom(REPASSE, comLink, AGORA)).toBe(true);
    // Opção da sonda desligada: não espera.
    cfg.sondaSemCupom = false;
    expect(await scheduler.aguardandoCupom(REPASSE, comLink, AGORA)).toBe(false);
  });

  it("palavra recusada com outro cupom ligado ao produto: não espera e conta como válido", async () => {
    coupons.findCodeCheck.mockResolvedValue({ verdict: "invalid" });
    autotest.sondaDoProduto.mockResolvedValue(null);
    coupons.couponsListForKeys.mockResolvedValue(new Map([["k1", [{ code: "CASAMELI", kind: "percent", value: 10 }]]]));
    const comLink = item({ link: "https://produto.mercadolivre.com.br/MLB-1" });
    expect(await scheduler.aguardandoCupom(REPASSE, comLink, AGORA)).toBe(false);
    expect(await scheduler.estadoCupomDoItem(comLink, AGORA)).toBe("valido");
  });

  it("não espera com 0 minutos, com o teste automático desligado ou bloqueado", async () => {
    cfg.esperaCupomMin = 0;
    expect(await scheduler.aguardandoCupom(REPASSE, item(), AGORA)).toBe(false);
    cfg.esperaCupomMin = 15; cfg.checkoutAuto = false;
    expect(await scheduler.aguardandoCupom(REPASSE, item(), AGORA)).toBe(false);
    cfg.checkoutAuto = true;
    autotest.status.mockReturnValue({ bloqueadoAte: new Date(AGORA + MIN).toISOString() });
    expect(await scheduler.aguardandoCupom(REPASSE, item(), AGORA)).toBe(false);
  });

  it("só vale pra repasse do ML com palavra, fora do modo mensagem original", async () => {
    expect(await scheduler.aguardandoCupom({ scraping: { kind: "busca" } }, item(), AGORA)).toBe(false);
    expect(await scheduler.aguardandoCupom(REPASSE, item({ store: "Amazon" }), AGORA)).toBe(false);
    expect(await scheduler.aguardandoCupom(REPASSE, item({ coupon: "" }), AGORA)).toBe(false);
    expect(await scheduler.aguardandoCupom(REPASSE, item({ originalText: "texto" }), AGORA)).toBe(false);
    expect(await scheduler.aguardandoCupom(REPASSE, item({ source: undefined }), AGORA)).toBe(false);
  });
});

describe("primeiroProntoParaEnvio — quem espera não trava a fila", () => {
  it("pula o item que espera e pega o próximo", async () => {
    const fila = [item(), item({ key: "k2", coupon: "" })];
    expect(await scheduler.primeiroProntoParaEnvio(REPASSE, fila, AGORA)).toBe(1);
  });

  it("todos esperando → -1 (tenta no próximo tick)", async () => {
    expect(await scheduler.primeiroProntoParaEnvio(REPASSE, [item(), item({ key: "k2" })], AGORA)).toBe(-1);
  });

  it("sem nada esperando, é o primeiro da fila de sempre", async () => {
    expect(await scheduler.primeiroProntoParaEnvio({ scraping: { kind: "busca" } }, [item(), item()], AGORA)).toBe(0);
  });
});

// "Só enviar com cupom válido" (scraping.repasse.soCupomValido): produto com cupom
// que não vale fica parado na fila, sem prazo; produto sem cupom sai normal.
describe("só enviar com cupom válido", () => {
  const SO_VALIDO = { id: 2, scraping: { kind: "repasse", autoSend: true, repasse: { soCupomValido: true } } };
  const valido = { code: "SEMPREPROMO", kind: "percent", value: 10, expiresAt: new Date(AGORA + 3600_000) };

  it("estadoCupomDoItem nos quatro casos", async () => {
    expect(await scheduler.estadoCupomDoItem(item({ coupon: "" }), AGORA)).toBe("sem_cupom");
    expect(await scheduler.estadoCupomDoItem(item({ store: "Amazon" }), AGORA)).toBe("sem_cupom");
    expect(await scheduler.estadoCupomDoItem(item({ originalText: "oi" }), AGORA)).toBe("sem_cupom");
    expect(await scheduler.estadoCupomDoItem(item(), AGORA)).toBe("testando");
    coupons.findCodeCheck.mockResolvedValue({ verdict: "invalid" });
    expect(await scheduler.estadoCupomDoItem(item(), AGORA)).toBe("invalido");
    coupons.findCouponByCode.mockResolvedValue(valido);
    expect(await scheduler.estadoCupomDoItem(item(), AGORA)).toBe("valido");
  });

  // Aprovada no checkout de outro produto, campanha ainda fora do sistema.
  it("palavra aprovada vale mesmo sem a campanha no sistema", async () => {
    const aprovada = (over) => ({ verdict: "valid", checkedAt: new Date(AGORA - 3600_000), raw: {}, ...over });
    coupons.findCodeCheck.mockResolvedValue(aprovada({ raw: { vencimento: "2026-11-03" } }));
    expect(await scheduler.estadoCupomDoItem(item(), AGORA)).toBe("valido");
    expect(await scheduler.primeiroProntoParaEnvio(SO_VALIDO, [item({ addedAt: new Date(AGORA - 60 * MIN).toISOString() })], AGORA)).toBe(0);
    // Vencida pelo cartão do teste.
    coupons.findCodeCheck.mockResolvedValue(aprovada({ raw: { vencimento: "2026-11-02" } }));
    expect(await scheduler.estadoCupomDoItem(item(), AGORA)).toBe("testando");
    // Sem vencimento: só uma aprovação de menos de 24h.
    coupons.findCodeCheck.mockResolvedValue(aprovada());
    expect(await scheduler.estadoCupomDoItem(item(), AGORA)).toBe("valido");
    coupons.findCodeCheck.mockResolvedValue(aprovada({ checkedAt: new Date(AGORA - 48 * 3600_000) }));
    expect(await scheduler.estadoCupomDoItem(item(), AGORA)).toBe("testando");
  });

  it("cupom vencido não conta como válido", async () => {
    coupons.findCouponByCode.mockResolvedValue({ ...valido, expiresAt: new Date(AGORA - 1000) });
    expect(await scheduler.estadoCupomDoItem(item(), AGORA)).toBe("testando");
  });

  it("pula inválido e em teste — mesmo depois da espera — e manda o sem cupom", async () => {
    coupons.findCodeCheck.mockImplementation(async (p) => (p === "RUIM" ? { verdict: "invalid" } : null));
    const velho = new Date(AGORA - 60 * MIN).toISOString();
    const fila = [
      item({ key: "a", coupon: "RUIM", addedAt: velho }),
      item({ key: "b", coupon: "NOVO", addedAt: velho }),
      item({ key: "c", coupon: "" }),
    ];
    expect(await scheduler.primeiroProntoParaEnvio(SO_VALIDO, fila, AGORA)).toBe(2);
    expect(await scheduler.primeiroProntoParaEnvio(SO_VALIDO, fila.slice(0, 2), AGORA)).toBe(-1);
  });

  it("cupom válido sai", async () => {
    coupons.findCouponByCode.mockResolvedValue(valido);
    expect(await scheduler.primeiroProntoParaEnvio(SO_VALIDO, [item()], AGORA)).toBe(0);
  });

  it("opção desligada: inválido sai como antes", async () => {
    coupons.findCodeCheck.mockResolvedValue({ verdict: "invalid" });
    expect(await scheduler.primeiroProntoParaEnvio(REPASSE, [item()], AGORA)).toBe(0);
  });

  it("estadosCupomDaFila: só calcula com a opção ligada", async () => {
    expect(await scheduler.estadosCupomDaFila({ ...REPASSE, queue: [item()] }, AGORA)).toMatchObject({ ativo: false, estados: {} });
    coupons.findCodeCheck.mockResolvedValue({ verdict: "invalid" });
    const r = await scheduler.estadosCupomDaFila({ ...SO_VALIDO, queue: [item({ id: 7 }), item({ key: "x", coupon: "" })] }, AGORA);
    expect(r).toMatchObject({ ativo: true, estados: { 7: "invalido", x: "sem_cupom" } });
  });
});

// TODOSITE0411 no Repasse Mulheres (04/11): o teste no checkout voltou
// "indeterminado", o item ficou em "testando" sem prazo e a sonda — que acharia o
// DESCONTOS — nunca rodou, porque só valia pra palavra "invalid" e dentro da
// janela de 15 min.
describe("palavra que não serviu: sonda do checkout", () => {
  const SO_VALIDO = { id: 2, scraping: { kind: "repasse", autoSend: true, repasse: { soCupomValido: true } } };
  const preso = (over = {}) => item({
    coupon: "TODOSITE0411", link: "https://produto.mercadolivre.com.br/MLB-1",
    addedAt: new Date(AGORA - 6 * 3600_000).toISOString(), ...over,
  });
  const indeterminado = async (p, o) => (o?.comIndeterminado ? { verdict: "indeterminado" } : null);

  it("indeterminado conta como palavra recusada; sem teste, não", async () => {
    expect(await scheduler.palavraRecusada(preso())).toBe(false);
    coupons.findCodeCheck.mockImplementation(indeterminado);
    expect(await scheduler.palavraRecusada(preso())).toBe(true);
    // O estado na fila segue "testando" (o reteste ainda pode aprovar).
    expect(await scheduler.estadoCupomDoItem(preso(), AGORA)).toBe("testando");
  });

  it("indeterminada dentro da janela: espera a sonda", async () => {
    coupons.findCodeCheck.mockImplementation(indeterminado);
    autotest.sondaDoProduto.mockResolvedValue(null);
    const novo = preso({ addedAt: new Date(AGORA - 2 * MIN).toISOString() });
    expect(await scheduler.aguardandoCupom(REPASSE, novo, AGORA)).toBe(true);
  });

  it("barrado fora da janela: pede a sonda até ela voltar", async () => {
    coupons.findCodeCheck.mockImplementation(indeterminado);
    autotest.sondaDoProduto.mockResolvedValue(null);
    expect(await scheduler.aguardandoCupom(SO_VALIDO, preso(), AGORA)).toBe(false);
    expect(await scheduler.precisaSondaBarrado(SO_VALIDO, preso(), AGORA)).toBe(true);
    // Sonda voltou depois de ele entrar: não repete.
    autotest.sondaDoProduto.mockResolvedValue({ probedAt: new Date(AGORA - MIN), ok: false });
    expect(await scheduler.precisaSondaBarrado(SO_VALIDO, preso(), AGORA)).toBe(false);
  });

  it("recusada também; sem a opção, ou palavra não testada, ou freio armado: não", async () => {
    autotest.sondaDoProduto.mockResolvedValue(null);
    expect(await scheduler.precisaSondaBarrado(SO_VALIDO, preso(), AGORA)).toBe(false);
    coupons.findCodeCheck.mockResolvedValue({ verdict: "invalid" });
    expect(await scheduler.precisaSondaBarrado(SO_VALIDO, preso(), AGORA)).toBe(true);
    expect(await scheduler.precisaSondaBarrado(REPASSE, preso(), AGORA)).toBe(false);
    autotest.status.mockReturnValue({ bloqueadoAte: new Date(AGORA + 60 * MIN).toISOString() });
    expect(await scheduler.precisaSondaBarrado(SO_VALIDO, preso(), AGORA)).toBe(false);
  });

  it("depois que a sonda liga um cupom do sistema, o item fica válido", async () => {
    coupons.findCodeCheck.mockImplementation(indeterminado);
    coupons.couponsListForKeys.mockResolvedValue(new Map([["k1", [{ code: "DESCONTOS", kind: "percent", value: 10, expiresAt: new Date(AGORA + 3600_000) }]]]));
    expect(await scheduler.estadoCupomDoItem(preso(), AGORA)).toBe("valido");
    expect(await scheduler.precisaSondaBarrado(SO_VALIDO, preso(), AGORA)).toBe(false);
  });
});

// Produto do repasse SEM palavra: espera a sonda do checkout dizer se algum cupom
// do sistema vale nele (o CASAMELI que valia no meli.la/1KUKHgA e não foi).
describe("sem cupom: espera a sonda do checkout", () => {
  const semPalavra = (over = {}) => item({ coupon: "", link: "https://produto.mercadolivre.com.br/MLB-1", ...over });

  it("segura enquanto o produto não foi sondado", async () => {
    autotest.sondaDoProduto.mockResolvedValue(null);
    expect(await scheduler.aguardandoCupom(REPASSE, semPalavra(), AGORA)).toBe(true);
  });

  it("solta quando a sonda voltou depois de ele entrar, achando ou não", async () => {
    autotest.sondaDoProduto.mockResolvedValue({ probedAt: new Date(AGORA - MIN), ok: false });
    expect(await scheduler.aguardandoCupom(REPASSE, semPalavra(), AGORA)).toBe(false);
  });

  it("sonda antiga: só conta se leu a lista nas últimas 12h", async () => {
    autotest.sondaDoProduto.mockResolvedValue({ probedAt: new Date(AGORA - 3 * 3600_000), ok: true });
    expect(await scheduler.aguardandoCupom(REPASSE, semPalavra(), AGORA)).toBe(false);
    autotest.sondaDoProduto.mockResolvedValue({ probedAt: new Date(AGORA - 3 * 3600_000), ok: false });
    expect(await scheduler.aguardandoCupom(REPASSE, semPalavra(), AGORA)).toBe(true);
    autotest.sondaDoProduto.mockResolvedValue({ probedAt: new Date(AGORA - 13 * 3600_000), ok: true });
    expect(await scheduler.aguardandoCupom(REPASSE, semPalavra(), AGORA)).toBe(true);
  });

  it("já tem cupom ligado ao produto: não espera", async () => {
    autotest.sondaDoProduto.mockResolvedValue(null);
    coupons.couponsListForKeys.mockResolvedValue(new Map([["k1", [{ code: "CASAMELI", kind: "percent", value: 10 }]]]));
    expect(await scheduler.aguardandoCupom(REPASSE, semPalavra(), AGORA)).toBe(false);
  });

  it("solta com a espera estourada, automático desligado, bloqueio ou banco fora", async () => {
    autotest.sondaDoProduto.mockResolvedValue(null);
    expect(await scheduler.aguardandoCupom(REPASSE, semPalavra({ addedAt: new Date(AGORA - 16 * MIN).toISOString() }), AGORA)).toBe(false);
    cfg.checkoutAuto = false;
    expect(await scheduler.aguardandoCupom(REPASSE, semPalavra(), AGORA)).toBe(false);
    cfg.checkoutAuto = true;
    autotest.status.mockReturnValue({ bloqueadoAte: new Date(AGORA + MIN).toISOString() });
    expect(await scheduler.aguardandoCupom(REPASSE, semPalavra(), AGORA)).toBe(false);
    autotest.status.mockReturnValue({ bloqueadoAte: null });
    autotest.sondaDoProduto.mockRejectedValue(new Error("db fora"));
    expect(await scheduler.aguardandoCupom(REPASSE, semPalavra(), AGORA)).toBe(false);
  });

  it("outra loja, campanha de catálogo ou item sem link não esperam", async () => {
    autotest.sondaDoProduto.mockResolvedValue(null);
    expect(await scheduler.aguardandoCupom(REPASSE, semPalavra({ store: "Amazon" }), AGORA)).toBe(false);
    expect(await scheduler.aguardandoCupom({ scraping: { kind: "busca" } }, semPalavra(), AGORA)).toBe(false);
    expect(await scheduler.aguardandoCupom(REPASSE, semPalavra({ link: "" }), AGORA)).toBe(false);
  });

  it("'só cupom válido' não barra o produto sem cupom depois da sonda", async () => {
    const SO_VALIDO = { id: 2, scraping: { kind: "repasse", autoSend: true, repasse: { soCupomValido: true } } };
    expect(await scheduler.primeiroProntoParaEnvio(SO_VALIDO, [semPalavra()], AGORA)).toBe(0);
  });
});

describe("opção 'procurar cupom em produto sem cupom'", () => {
  it("desligada: o sem palavra sai na hora; o com palavra continua esperando", async () => {
    autotest.sondaDoProduto.mockResolvedValue(null);
    cfg.sondaSemCupom = false;
    const semPalavra = item({ coupon: "", link: "https://produto.mercadolivre.com.br/MLB-1" });
    expect(await scheduler.aguardandoCupom(REPASSE, semPalavra, AGORA)).toBe(false);
    expect(await scheduler.aguardandoCupom(REPASSE, item(), AGORA)).toBe(true);
    cfg.sondaSemCupom = true;
    expect(await scheduler.aguardandoCupom(REPASSE, semPalavra, AGORA)).toBe(true);
  });
});

describe("sondaRespondeu (pura)", () => {
  const it0 = { addedAt: new Date(AGORA - 2 * MIN).toISOString() };
  it("sem sonda ou data ruim: não respondeu", () => {
    expect(autotest.sondaRespondeu(null, it0, AGORA)).toBe(false);
    expect(autotest.sondaRespondeu({ probedAt: "x", ok: true }, it0, AGORA)).toBe(false);
  });
  it("depois da entrada responde mesmo falha; antes só se leu e é recente", () => {
    expect(autotest.sondaRespondeu({ probedAt: new Date(AGORA - MIN), ok: false }, it0, AGORA)).toBe(true);
    expect(autotest.sondaRespondeu({ probedAt: new Date(AGORA - 3600_000), ok: true }, it0, AGORA)).toBe(true);
    expect(autotest.sondaRespondeu({ probedAt: new Date(AGORA - 3600_000), ok: false }, it0, AGORA)).toBe(false);
  });
});
