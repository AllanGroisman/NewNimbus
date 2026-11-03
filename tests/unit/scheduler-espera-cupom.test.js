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

  it("palavra que o ML recusou não espera", async () => {
    coupons.findCodeCheck.mockResolvedValue({ verdict: "invalid" });
    expect(await scheduler.aguardandoCupom(REPASSE, item(), AGORA)).toBe(false);
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
    expect(await scheduler.estadosCupomDaFila({ ...REPASSE, queue: [item()] }, AGORA)).toEqual({ ativo: false, estados: {} });
    coupons.findCodeCheck.mockResolvedValue({ verdict: "invalid" });
    const r = await scheduler.estadosCupomDaFila({ ...SO_VALIDO, queue: [item({ id: 7 }), item({ key: "x", coupon: "" })] }, AGORA);
    expect(r).toEqual({ ativo: true, estados: { 7: "invalido", x: "sem_cupom" } });
  });
});
