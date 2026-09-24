// A agenda das etapas de cupons (task 3).
//
// O servidor não roda etapa nenhuma — elas moram no Chrome do admin. O que se testa
// aqui é a parte dele: marcar o horário vencido como pendente, entregar a pendência a
// UMA aba só, avisar o grupo quando ninguém a pega a tempo, e não repetir o horário
// que uma rodada (manual ou agendada) já cobriu.
import "../helpers/env.js";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const backend = (...p) => path.resolve(__dirname, "..", "..", "backend", ...p);

const sync = require(backend("coupons", "sync.js"));
const agenda = require(backend("coupons", "agenda.js"));
const adminNotifier = require(backend("notifications", "admin-notifier.js"));

let pulada, rodada;

// 07:59 de um dia qualquer, hora local — o agendamento é todo em hora local.
function relogio(h = 7, m = 59) {
  const d = new Date(2026, 8, 23, h, m, 0, 0);
  vi.setSystemTime(d);
  return d;
}

function agendaDaLista(parcial) {
  sync.writeConfig({ agenda: { lista: { enabled: true, scheduleMode: "times", times: ["08:00"], ...parcial } } });
}

beforeEach(() => {
  vi.useFakeTimers();
  relogio();
  agenda._reset();
  for (const k of Object.keys(sync.ultimas())) sync.ultimas()[k] = null;
  sync.writeConfig({ agenda: { lista: { enabled: false }, produtos: { enabled: false }, tudo: { enabled: false } } });
  pulada = vi.spyOn(adminNotifier, "notifyCuponsAgendaPulada").mockResolvedValue();
  rodada = vi.spyOn(adminNotifier, "notifyCuponsRodada").mockResolvedValue();
});

afterEach(() => {
  agenda._reset();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("config da agenda", () => {
  it("normaliza os horários e mescla por etapa — salvar uma não apaga a outra", () => {
    sync.writeConfig({ agenda: { lista: { enabled: "true", times: ["9:00", "08:00", "08:00", "25:00"] } } });
    sync.writeConfig({ agenda: { produtos: { enabled: true, scheduleMode: "interval", intervalMinutes: 5 } } });
    const { agenda: a } = sync.readConfig();
    expect(a.lista).toMatchObject({ enabled: true, scheduleMode: "times", times: ["08:00"] });
    // 30 min de piso: cada rodada é a conta do ML inteira.
    expect(a.produtos).toMatchObject({ enabled: true, scheduleMode: "interval", intervalMinutes: 30 });
    expect(a.tudo.enabled).toBe(false);
  });
});

describe("pendências", () => {
  it("o horário vencido vira pendência, com o horário dele", async () => {
    agendaDaLista();
    expect(agenda.status().proximo.lista).toBe(new Date(2026, 8, 23, 8, 0).toISOString());
    expect(agenda.pendentes()).toEqual([]);

    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(agenda.pendentes()).toEqual([expect.objectContaining({ botao: "lista", slot: "08:00" })]);
    // E não dispara de novo em laço: o próximo é o de amanhã.
    expect(agenda.status().proximo.lista).toBe(new Date(2026, 8, 24, 8, 0).toISOString());
  });

  it("só uma aba leva a pendência", async () => {
    agendaDaLista();
    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(agenda.reivindicar("lista")).toEqual({ ok: true, slot: "08:00" });
    expect(agenda.reivindicar("lista")).toEqual({ ok: false });
    expect(agenda.pendentes()).toEqual([]);
  });

  it("ninguém pegou dentro da graça → o horário é pulado e o grupo fica sabendo", async () => {
    agendaDaLista();
    await vi.advanceTimersByTimeAsync(60 * 1000);
    agenda.varrer(Date.now() + agenda.GRACE_MS - 1000);
    expect(pulada).not.toHaveBeenCalled();

    agenda.varrer(Date.now() + agenda.GRACE_MS + 1000);
    expect(pulada).toHaveBeenCalledWith("lista", "08:00", expect.stringMatching(/aba/));
    expect(agenda.pendentes()).toEqual([]);
  });

  it("a aba que não pode rodar avisa o motivo", async () => {
    agendaDaLista();
    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(agenda.falhou("lista", "sem extensão")).toEqual({ ok: true });
    expect(pulada).toHaveBeenCalledWith("lista", "08:00", "sem extensão");
    expect(agenda.falhou("lista", "de novo")).toEqual({ ok: false });
  });

  it("uma rodada manual depois do horário já cobre o slot", async () => {
    relogio(8, 5);
    sync.ultimas().lista = { at: new Date(2026, 8, 23, 8, 2).toISOString() };
    agendaDaLista();
    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(agenda.pendentes()).toEqual([]);
  });
});

describe("fim da etapa", () => {
  it("rodada agendada sai no grupo com o horário; a manual sai como manual", async () => {
    agendaDaLista();
    await vi.advanceTimersByTimeAsync(60 * 1000);
    agenda.reivindicar("lista");

    sync.registrarRodada("produtos", { duracaoMs: 1000, resultado: { produtos: 10 } });
    expect(rodada).toHaveBeenLastCalledWith("produtos", expect.objectContaining({ resultado: { produtos: 10 } }), { slot: null });

    // A lista fecha pelo `resumoDoFim`; o que importa aqui é o que a agenda devolve.
    expect(agenda.rodadaFechou("lista")).toBe("08:00");
    expect(agenda.rodadaFechou("lista")).toBe(null);
  });
});

describe("aviso no grupo", () => {
  const ultima = (extra = {}) => ({
    at: new Date().toISOString(), duracaoMs: 125000, erro: null, interrompida: false,
    resultado: { ativados: 3, colhidos: 9, tentados: 10, produtos: 1500, parciais: 1, vazias: 0, falharam: 1 },
    ...extra,
  });

  it("escolhe o modelo: da etapa quando terminou, o de interrompida quando parou", () => {
    expect(adminNotifier.templateDosCupons("produtos", ultima())).toBe("cuponsProdutosFim");
    expect(adminNotifier.templateDosCupons("tudo", ultima({ erro: "teto" }))).toBe("cuponsTudoFim");
    expect(adminNotifier.templateDosCupons("lista", ultima({ erro: "muro", interrompida: true }))).toBe("cuponsErro");
  });

  it("preenche as variáveis", () => {
    const v = adminNotifier.cuponsVars("produtos", ultima({ erro: "algo" }), { slot: "09:00" });
    expect(v).toMatchObject({
      origem: "⏰ Agendada (09:00)", etapa: "Etapa 2 · Produtos", duracao: "2m 5s",
      produtos: "1.500", colhidos: "9", bloco_aviso: "⚠️ algo",
    });
    expect(adminNotifier.cuponsVars("lista", ultima(), {}).origem).toBe("👆 Manual");
  });
});
