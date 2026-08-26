// Aviso de bloqueio de scraping (repasse, Hub, cupons).
//
// A regra que importa é a mesma do cookie de afiliado: NUNCA um aviso por link. Aqui
// são duas travas — N falhas seguidas do mesmo tipo E X minutos contínuos sem sucesso —
// e é isso que estes casos exercitam: rajada curta cala, falha isolada cala, sequência
// longa avisa UMA vez, e a volta ao normal avisa de novo.
import "../helpers/env.js";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const backend = (...p) => path.resolve(__dirname, "..", "..", "backend", ...p);

// Carência curta só pro teste: o módulo lê o env no require, e adiantar 15 minutos de
// timer falso a cada caso deixaria a suíte lenta à toa.
process.env.BLOCK_ALERT_GRACE_MS = "5000";

const blockAlert = require(backend("notifications", "block-alert.js"));
const adminNotifier = require(backend("notifications", "admin-notifier.js"));
const userNotifier = require(backend("notifications", "user-notifier.js"));
const affiliate = require(backend("scraping", "affiliate.js"));
const { KIND } = require(backend("repasse", "error-kinds.js"));

const N = blockAlert.MIN_FAILS;
const GRACE = blockAlert.GRACE_MS;

let detected, recovered;

// Uma falha de scrape de produto no repasse.
function falha(store = "Mercado Livre", kind = KIND.CAPTCHA, userId) {
  blockAlert.repasseScrapeResult({ store, ok: false, kind, reason: `${store}: ${kind}`, userId });
}
function sucesso(store = "Mercado Livre") {
  blockAlert.repasseScrapeResult({ store, ok: true });
}
// Avança a carência inteira e deixa o stateAlert disparar.
async function passaCarencia() {
  await vi.advanceTimersByTimeAsync(GRACE + 1000);
  await flush();
}

// O onDown consulta o banco pra trocar id por nome de cliente, e isso é I/O de verdade:
// microtask não basta. Espera curta e fixa dava flake quando o banco estava ocupado, e
// esperar sempre o pior caso deixaria a suíte lenta — então espera ATÉ ter resposta.
async function flush(ate) {
  vi.useRealTimers();
  const limite = Date.now() + 5000;
  do {
    await new Promise(r => setTimeout(r, 20));
  } while (ate && !ate() && Date.now() < limite);
  vi.useFakeTimers();
}

// Espera o aviso sair. Quem espera "nenhum aviso" usa o flush pelado: ali não há o que
// aguardar, e um poll longo só atrasaria o teste.
const ateAvisar = (spy) => () => spy.mock.calls.length > 0;

beforeEach(() => {
  vi.useFakeTimers();
  userNotifier.__clearAlertState();
  blockAlert.__clearStreaks();
  detected = vi.spyOn(adminNotifier, "notifyBlockDetected").mockResolvedValue();
  recovered = vi.spyOn(adminNotifier, "notifyBlockRecovered").mockResolvedValue();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("bloqueio no repasse", () => {
  it("menos de N falhas seguidas nunca vira aviso", async () => {
    for (let i = 0; i < N - 1; i++) falha();
    await passaCarencia();

    expect(detected).not.toHaveBeenCalled();
  });

  it("N falhas seguidas + carência inteira avisam UMA vez", async () => {
    for (let i = 0; i < N + 3; i++) falha();
    await vi.advanceTimersByTimeAsync(GRACE + 1000);
    await flush(ateAvisar(detected));

    expect(detected).toHaveBeenCalledTimes(1);
    const vars = detected.mock.calls[0][0];
    expect(vars.alvo).toBe("Repasse · Mercado Livre");
    expect(vars.motivo).toBe("CAPTCHA");
    expect(vars.falhas).toBe(N + 3);
    // O "o que fazer" sai do catálogo do painel, não de um texto paralelo.
    expect(vars.o_que_fazer).toMatch(/passageiro/i);
  });

  it("sucesso no meio zera o contador", async () => {
    for (let i = 0; i < N - 1; i++) falha();
    sucesso();
    for (let i = 0; i < N - 1; i++) falha();
    await passaCarencia();

    expect(detected).not.toHaveBeenCalled();
  });

  it("recuperar dentro da carência não avisa nada", async () => {
    for (let i = 0; i < N; i++) falha();
    await vi.advanceTimersByTimeAsync(GRACE - 1000);
    sucesso();
    await passaCarencia();

    expect(detected).not.toHaveBeenCalled();
    expect(recovered).not.toHaveBeenCalled();
  });

  it("depois do aviso, o primeiro sucesso manda o 'voltou ao normal'", async () => {
    for (let i = 0; i < N; i++) falha();
    await passaCarencia();
    expect(detected).toHaveBeenCalledTimes(1);

    sucesso();
    await flush(ateAvisar(recovered));

    expect(recovered).toHaveBeenCalledTimes(1);
    expect(recovered.mock.calls[0][0].alvo).toBe("Repasse · Mercado Livre");
  });

  it("CAPTCHA e muro de login na mesma loja são sequências separadas", async () => {
    for (let i = 0; i < N - 1; i++) falha("Mercado Livre", KIND.CAPTCHA);
    for (let i = 0; i < N - 1; i++) falha("Mercado Livre", KIND.LOGIN_WALL);
    await passaCarencia();

    // Nenhuma das duas chegou a N sozinha: somar as duas seria o alarme falso.
    expect(detected).not.toHaveBeenCalled();
  });

  it("lojas diferentes não somam", async () => {
    for (let i = 0; i < N - 1; i++) falha("Mercado Livre");
    for (let i = 0; i < N - 1; i++) falha("Amazon");
    await passaCarencia();

    expect(detected).not.toHaveBeenCalled();
  });

  it("link ruim (não é produto) nunca arma alerta", async () => {
    for (let i = 0; i < N * 3; i++) {
      blockAlert.repasseScrapeResult({ store: "Mercado Livre", ok: false, kind: KIND.NAO_E_PRODUTO });
    }
    await passaCarencia();

    expect(detected).not.toHaveBeenCalled();
  });

  it("os clientes atingidos vão na mensagem, sem repetir", async () => {
    for (let i = 0; i < N; i++) falha("Mercado Livre", KIND.CAPTCHA, i % 2 ? "u1" : "u2");
    await vi.advanceTimersByTimeAsync(GRACE + 1000);
    await flush(ateAvisar(detected));

    const clientes = detected.mock.calls[0][0].clientes;
    expect(clientes).toMatch(/Clientes atingidos:/);
    // Sem banco no teste, o id é o próprio nome — o que importa é não duplicar.
    expect(clientes.match(/u2/g)).toHaveLength(1);
  });
});

describe("bloqueio do Hub e dos cupons", () => {
  it("traduz o vocabulário do Hub ('login') para o motivo do catálogo", () => {
    expect(blockAlert.normalizeKind("login")).toBe(KIND.LOGIN_WALL);
    expect(blockAlert.normalizeKind("verificacao")).toBe(KIND.LOGIN_WALL);
    expect(blockAlert.normalizeKind("captcha")).toBe(KIND.CAPTCHA);
    // "vitrine vazia" e "sem modelo de cupom" não são parede nenhuma.
    expect(blockAlert.normalizeKind("empty")).toBeNull();
    expect(blockAlert.normalizeKind("sem-modelo")).toBeNull();
  });

  it("N rodadas bloqueadas avisam uma vez, citando a conta do sistema", async () => {
    for (let i = 0; i < N; i++) {
      affiliate.recordMLHubCheck({ ok: false, reason: "O ML pediu login", kind: "login" });
    }
    await vi.advanceTimersByTimeAsync(GRACE + 1000);
    await flush(ateAvisar(detected));

    expect(detected).toHaveBeenCalledTimes(1);
    expect(detected.mock.calls[0][0].alvo).toMatch(/conta do sistema/);
    expect(detected.mock.calls[0][0].motivo).toBe("Muro de login");
    // É a conta do sistema, não a de um cliente: nada de "clientes atingidos".
    expect(detected.mock.calls[0][0].clientes).toBe("");
  });

  it('o "Testar acesso" do Admin (manual) não mexe no estado', async () => {
    for (let i = 0; i < N * 2; i++) {
      affiliate.recordMLHubCheck({ ok: false, reason: "cookie ruim", kind: "login", manual: true });
    }
    await passaCarencia();

    expect(detected).not.toHaveBeenCalled();
  });

  it("uma rodada boa depois do aviso normaliza", async () => {
    for (let i = 0; i < N; i++) affiliate.recordMLHubCheck({ ok: false, reason: "captcha", kind: "captcha" });
    await passaCarencia();
    expect(detected).toHaveBeenCalledTimes(1);

    affiliate.recordMLHubCheck({ ok: true, reason: "Última rodada de cupons: 12 cupons." });
    await flush(ateAvisar(recovered));

    expect(recovered).toHaveBeenCalledTimes(1);
  });
});
