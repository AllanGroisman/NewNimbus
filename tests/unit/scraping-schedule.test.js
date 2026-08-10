// Agendamento dos scrapers globais: intervalo em minutos ou horários fixos do
// dia (backend/scraping/schedule.js). Backend puro — sem servidor.

import { describe, it, expect } from "vitest";
import "../helpers/env.js";
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const schedule = require(path.resolve(__dirname, "..", "..", "backend", "scraping", "schedule.js"));

// Tudo no agendamento é hora LOCAL do servidor, então o teste também é.
function at(hhmm, dayOffset = 0) {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(h, m, 0, 0);
  return d;
}

describe("schedule.normalizeTimes", () => {
  it("aceita só HH:MM válido, sem repetidos e em ordem", () => {
    expect(schedule.normalizeTimes(["20:00", "08:00", "20:00"])).toEqual(["08:00", "20:00"]);
    expect(schedule.normalizeTimes([" 09:30 "])).toEqual(["09:30"]);
  });

  it("descarta lixo", () => {
    expect(schedule.normalizeTimes(["24:00", "9:00", "12:60", "abc", "", null, 12])).toEqual([]);
    expect(schedule.normalizeTimes(null)).toEqual([]);
    expect(schedule.normalizeTimes("08:00")).toEqual([]);
  });

  it("corta no máximo de horários", () => {
    const muitos = Array.from({ length: 20 }, (_, i) => `${String(i).padStart(2, "0")}:00`);
    expect(schedule.normalizeTimes(muitos)).toHaveLength(schedule.MAX_TIMES);
  });
});

describe("schedule.nextRun — modo intervalo", () => {
  it("conta a partir do último run", () => {
    const now = at("14:00");
    const plan = schedule.nextRun({ intervalMinutes: 60 }, at("13:30").toISOString(), now);
    expect(plan.at.getTime()).toBe(at("14:30").getTime());
    expect(plan.slot).toBeNull();
  });

  it("sem último run, conta a partir de agora", () => {
    const now = at("14:00");
    const plan = schedule.nextRun({ intervalMinutes: 30 }, null, now);
    expect(plan.at.getTime()).toBe(at("14:30").getTime());
  });

  it("já passou da hora (backend ficou off) — roda agora, nunca no passado", () => {
    const now = at("14:00");
    const plan = schedule.nextRun({ intervalMinutes: 60 }, at("09:00").toISOString(), now);
    expect(plan.at.getTime()).toBe(now.getTime());
  });
});

describe("schedule.nextRun — modo horários", () => {
  const cfg = { scheduleMode: "times", intervalMinutes: 60, times: ["08:00", "12:00", "20:00"] };

  it("agenda o próximo horário do dia", () => {
    const plan = schedule.nextRun(cfg, null, at("13:00"));
    expect(plan.at.getTime()).toBe(at("20:00").getTime());
    expect(plan.slot).toBe("20:00");
  });

  it("depois do último horário, vira para o primeiro de amanhã", () => {
    const plan = schedule.nextRun(cfg, null, at("22:00"));
    expect(plan.at.getTime()).toBe(at("08:00", 1).getTime());
    expect(plan.slot).toBe("08:00");
  });

  it("horário perdido dentro da janela de graça roda agora", () => {
    const now = at("12:10");
    const plan = schedule.nextRun(cfg, at("08:05").toISOString(), now);
    expect(plan.at.getTime()).toBe(now.getTime());
    expect(plan.slot).toBe("12:00");
  });

  it("passou da graça — espera o próximo horário em vez de correr atrás", () => {
    const plan = schedule.nextRun(cfg, null, at("12:30"));
    expect(plan.at.getTime()).toBe(at("20:00").getTime());
  });

  it("não repete um horário que o último run já cobriu", () => {
    const plan = schedule.nextRun(cfg, at("12:02").toISOString(), at("12:10"));
    expect(plan.at.getTime()).toBe(at("20:00").getTime());
  });

  it("sem nenhum horário não agenda nada", () => {
    expect(schedule.nextRun({ scheduleMode: "times", times: [] }, null, at("10:00"))).toBeNull();
    expect(schedule.nextRun({ scheduleMode: "times", times: ["25:00"] }, null, at("10:00"))).toBeNull();
  });

  it("config sem scheduleMode continua no intervalo (compat com config antiga)", () => {
    const plan = schedule.nextRun({ intervalMinutes: 60, times: ["08:00"] }, null, at("14:00"));
    expect(plan.at.getTime()).toBe(at("15:00").getTime());
  });
});
