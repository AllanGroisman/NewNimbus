// Job de lembretes de cobrança + dedupe REAL da tabela email_log.
//
// Este é o único teste que roda o módulo notifications/email de verdade (os
// outros usam helpers/email-mock.js). Por isso ele NÃO importa helpers/app.js:
// o mock é instalado no require.cache global de lá, e aqui a graça é justamente
// exercitar a dedupe que impede o cliente de receber o mesmo aviso 4x por dia
// (o job roda de 6 em 6 horas).
//
// O transporte SMTP se recusa a enviar em NODE_ENV=test (a suíte carrega o .env
// do backend, que aponta pro SMTP de produção), então o envio termina em
// "skipped_test_env". O que importa aqui é a linha em email_log — é ela que
// garante o não-repeat.

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import "../helpers/env.js";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { truncateAll } from "../helpers/pg-helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const backendDir = path.resolve(__dirname, "..", "..", "backend");

const { prisma } = require(path.join(backendDir, "db.js"));

// A integração roda com isolate: false, então outro arquivo do mesmo worker pode
// já ter instalado o mock do e-mail no require.cache (e carregado o reminders
// com ele). Tiramos os dois do cache pra carregar os de verdade, e devolvemos o
// cache como estava no fim — quem vier depois continua vendo o mock.
const emailPath = require.resolve(path.join(backendDir, "notifications", "email"));
const remindersPath = require.resolve(path.join(backendDir, "billing", "reminders.js"));
const savedCache = { [emailPath]: require.cache[emailPath], [remindersPath]: require.cache[remindersPath] };
delete require.cache[emailPath];
delete require.cache[remindersPath];
const reminders = require(remindersPath);

afterAll(() => {
  for (const [p, entry] of Object.entries(savedCache)) {
    if (entry) require.cache[p] = entry;
    else delete require.cache[p];
  }
});

const DIA = 24 * 60 * 60 * 1000;

async function criarAssinante({ status, planId = "pro", currentPeriodEnd = null, pastDueSince = null, role = "user", suspended = false }) {
  const sufixo = crypto.randomBytes(4).toString("hex");
  const user = await prisma().user.create({
    data: {
      email: `lembrete-${sufixo}@test.local`,
      name: "Cliente Teste",
      passwordHash: "x",
      emailVerified: true,
      role,
      suspended,
    },
  });
  await prisma().subscription.create({
    data: { userId: user.id, planId, status, currentPeriodEnd, pastDueSince },
  });
  return user;
}

function logsDe(userId) {
  return prisma().emailLog.findMany({ where: { userId }, orderBy: { createdAt: "asc" } });
}

describe("Lembretes de cobrança — quem é avisado", () => {
  beforeEach(() => truncateAll());

  it("avisa quem está a 2 dias do fim do teste", async () => {
    const user = await criarAssinante({
      status: "trialing", currentPeriodEnd: new Date(Date.now() + 2 * DIA),
    });

    await reminders.runOnce();

    const logs = await logsDe(user.id);
    expect(logs).toHaveLength(1);
    expect(logs[0].kind).toBe("trial_ending");
    expect(logs[0].to).toBe(user.email);
    // O transporte se recusa a enviar em NODE_ENV=test — mas a linha existe,
    // que é o que impede a repetição.
    expect(logs[0].status).toBe("skipped_test_env");
  });

  it("não avisa quem ainda tem 10 dias de teste", async () => {
    const user = await criarAssinante({
      status: "trialing", currentPeriodEnd: new Date(Date.now() + 10 * DIA),
    });
    await reminders.runOnce();
    expect(await logsDe(user.id)).toHaveLength(0);
  });

  it("avisa quem está nas últimas 24h da carência", async () => {
    // Carência é de 3 dias: 2,5 dias de atraso = falta meio dia.
    const user = await criarAssinante({
      status: "past_due", pastDueSince: new Date(Date.now() - 2.5 * DIA),
    });

    await reminders.runOnce();

    const logs = await logsDe(user.id);
    expect(logs).toHaveLength(1);
    expect(logs[0].kind).toBe("grace_ending");
  });

  it("avisa que o acesso foi pausado quando a carência estourou", async () => {
    const user = await criarAssinante({
      status: "past_due", pastDueSince: new Date(Date.now() - 5 * DIA),
    });

    await reminders.runOnce();

    const logs = await logsDe(user.id);
    expect(logs).toHaveLength(1);
    expect(logs[0].kind).toBe("access_paused");
  });

  it("não avisa quem acabou de entrar em atraso (ainda tem 3 dias)", async () => {
    const user = await criarAssinante({
      status: "past_due", pastDueSince: new Date(Date.now() - 1 * 60 * 60 * 1000),
    });
    await reminders.runOnce();
    expect(await logsDe(user.id)).toHaveLength(0);
  });

  it("avisa admin igual a qualquer cliente, mas pula conta suspensa", async () => {
    const admin = await criarAssinante({
      status: "trialing", currentPeriodEnd: new Date(Date.now() + 1 * DIA), role: "admin",
    });
    const suspenso = await criarAssinante({
      status: "trialing", currentPeriodEnd: new Date(Date.now() + 1 * DIA), suspended: true,
    });

    await reminders.runOnce();

    // Admin tem Business por bypass, mas se assinou de verdade os prazos valem
    // pra ele igual — e sem isso não dá pra conferir cobrança na prática.
    expect(await logsDe(admin.id)).toHaveLength(1);
    // Conta suspensa já recebeu o aviso de suspensão.
    expect(await logsDe(suspenso.id)).toHaveLength(0);
  });

  it("assinatura ativa e em dia não é nem lida pelo job", async () => {
    const user = await criarAssinante({
      status: "active", currentPeriodEnd: new Date(Date.now() + 2 * DIA),
    });
    const stats = await reminders.runOnce();
    expect(stats.checked).toBe(0);
    expect(await logsDe(user.id)).toHaveLength(0);
  });
});

describe("Lembretes de cobrança — dedupe", () => {
  beforeEach(() => truncateAll());

  it("rodar o job de novo não repete o mesmo aviso", async () => {
    const user = await criarAssinante({
      status: "trialing", currentPeriodEnd: new Date(Date.now() + 2 * DIA),
    });

    await reminders.runOnce();
    await reminders.runOnce();
    await reminders.runOnce();

    // O job roda 4x por dia: sem a dedupeKey ancorada na data-alvo, o cliente
    // receberia o mesmo "seu teste está acabando" a cada 6 horas.
    expect(await logsDe(user.id)).toHaveLength(1);
  });

  it("cada usuário recebe o seu, independentemente dos outros", async () => {
    const a = await criarAssinante({ status: "trialing", currentPeriodEnd: new Date(Date.now() + 1 * DIA) });
    const b = await criarAssinante({ status: "past_due", pastDueSince: new Date(Date.now() - 5 * DIA) });

    const stats = await reminders.runOnce();

    expect(stats.checked).toBe(2);
    expect((await logsDe(a.id))[0].kind).toBe("trial_ending");
    expect((await logsDe(b.id))[0].kind).toBe("access_paused");
  });
});
