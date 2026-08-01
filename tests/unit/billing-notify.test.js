// Decisão de quando um e-mail de cobrança sai.
//
// A regra que estes testes travam: e-mail sai por TRANSIÇÃO de estado, não por
// evento recebido. O Stripe manda `customer.subscription.updated` para quase
// tudo e reentrega eventos — sem isso o cliente receberia "falha no pagamento"
// várias vezes pela mesma falha.

import { describe, it, expect } from "vitest";
import "../helpers/env.js";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const backendDir = path.resolve(__dirname, "..", "..", "backend");

const notify = require(path.join(backendDir, "billing", "notify.js"));

const user = { id: "u-1", email: "cliente@test.local", name: "Ana", role: "user", suspended: false };
const emDia = { planId: "pro", status: "active", cancelAtPeriodEnd: false, currentPeriodEnd: new Date("2026-09-01") };

function decidir(before, after) {
  return notify.decidirAviso({ before, after, user });
}

describe("billing/notify — falha e recuperação de pagamento", () => {
  it("active → past_due manda payment_failed com a data limite da carência", () => {
    const pastDueSince = new Date("2026-08-01T10:00:00Z");
    const aviso = decidir(emDia, { ...emDia, status: "past_due", pastDueSince });
    expect(aviso.kind).toBe("payment_failed");
    // Carência de 3 dias contada de pastDueSince (billing/limits.js).
    expect(aviso.payload.deadline.toISOString()).toBe("2026-08-04T10:00:00.000Z");
    // A chave é ancorada no início do atraso: reentrega do mesmo evento não repete.
    expect(aviso.dedupeKey).toContain(pastDueSince.toISOString());
  });

  it("past_due → past_due (reentrega) não manda nada", () => {
    const atrasado = { ...emDia, status: "past_due", pastDueSince: new Date("2026-08-01") };
    expect(decidir(atrasado, atrasado)).toBeNull();
  });

  it("past_due → active manda payment_recovered", () => {
    const atrasado = { ...emDia, status: "past_due", pastDueSince: new Date("2026-08-01") };
    expect(decidir(atrasado, emDia).kind).toBe("payment_recovered");
  });

  it("nada mudou = nenhum e-mail", () => {
    expect(decidir(emDia, emDia)).toBeNull();
  });

  it("assinatura nova (sem estado anterior) não manda aviso de cobrança", () => {
    // Quem acabou de assinar já recebeu o e-mail de boas-vindas.
    expect(decidir(null, emDia)).toBeNull();
  });
});

describe("billing/notify — troca de plano", () => {
  it("basic → business manda plan_changed com os dois rótulos", () => {
    const aviso = decidir({ ...emDia, planId: "basic" }, { ...emDia, planId: "business" });
    expect(aviso.kind).toBe("plan_changed");
    expect(aviso.payload.fromPlanLabel).toBe("Básico");
    expect(aviso.payload.toPlanLabel).toBe("Business");
  });

  it("pro → free não vira plan_changed (é cancelamento, tem e-mail próprio)", () => {
    expect(decidir(emDia, { ...emDia, planId: "free", status: "canceled" })).toBeNull();
  });

  it("falha de pagamento ganha da troca de plano no mesmo evento", () => {
    const aviso = decidir(
      { ...emDia, planId: "basic" },
      { ...emDia, planId: "pro", status: "past_due", pastDueSince: new Date("2026-08-01") },
    );
    expect(aviso.kind).toBe("payment_failed");
  });
});

describe("billing/notify — cancelamento agendado", () => {
  it("marcar cancelAtPeriodEnd manda cancel_scheduled com a data de fim", () => {
    const aviso = decidir(emDia, { ...emDia, cancelAtPeriodEnd: true });
    expect(aviso.kind).toBe("cancel_scheduled");
    expect(aviso.payload.periodEnd).toEqual(emDia.currentPeriodEnd);
  });

  it("desmarcar manda cancel_reverted", () => {
    expect(decidir({ ...emDia, cancelAtPeriodEnd: true }, emDia).kind).toBe("cancel_reverted");
  });
});

describe("billing/notify — quem não recebe", () => {
  it("admin não recebe (tem Business por bypass, o aviso seria falso)", () => {
    expect(notify.podeReceber({ ...user, role: "admin" })).toBe(false);
  });

  it("conta suspensa não recebe (já foi avisada da suspensão)", () => {
    expect(notify.podeReceber({ ...user, suspended: true })).toBe(false);
  });

  it("conta sem e-mail não recebe", () => {
    expect(notify.podeReceber({ ...user, email: null })).toBe(false);
  });

  it("usuário comum recebe", () => {
    expect(notify.podeReceber(user)).toBe(true);
  });
});

describe("billing/notify — guarda de modo do Stripe", () => {
  it("evento do modo live não manda e-mail com o sistema em modo teste", async () => {
    // O webhook aceita os dois modos de propósito; sem esta guarda um teste do
    // Stripe mandaria e-mail para cliente de verdade.
    const kind = await notify.onSubscriptionChanged({
      userId: user.id, user,
      before: emDia, after: { ...emDia, status: "past_due", pastDueSince: new Date() },
      livemode: true,
    });
    expect(kind).toBeNull();
  });
});
