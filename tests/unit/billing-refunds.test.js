// Mapeamento fatura ↔ estorno. O ponto todo: o Stripe deixa a fatura como
// "paid" pra sempre depois de um reembolso, e a única ligação entre as duas
// pontas nesta versão da API é o payment_intent.
import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const requireCjs = createRequire(import.meta.url);
const { refundsFromCharges } = requireCjs("../../backend/billing/stripe.js");

function fatura(id, ...pis) {
  return { id, payments: { data: pis.map(pi => ({ payment: { payment_intent: pi } })) } };
}

describe("refundsFromCharges", () => {
  it("casa a fatura com a cobrança pelo payment_intent", () => {
    const r = refundsFromCharges(
      [fatura("in_1", "pi_1"), fatura("in_2", "pi_2")],
      [
        { payment_intent: "pi_1", amount: 6990, amount_refunded: 6990 },
        { payment_intent: "pi_2", amount: 6990, amount_refunded: 0 },
      ],
    );
    expect(r.get("in_1")).toBe(6990);
    expect(r.get("in_2")).toBe(0);
  });

  it("soma quando a fatura foi paga por mais de um payment_intent", () => {
    const r = refundsFromCharges(
      [fatura("in_multi", "pi_a", "pi_b")],
      [
        { payment_intent: "pi_a", amount_refunded: 1000 },
        { payment_intent: "pi_b", amount_refunded: 500 },
      ],
    );
    expect(r.get("in_multi")).toBe(1500);
  });

  it("fatura sem pagamento registrado e cobrança sem payment_intent não quebram", () => {
    const r = refundsFromCharges(
      [{ id: "in_vazia" }, fatura("in_orfa", "pi_x")],
      [{ amount_refunded: 9999 }],
    );
    expect(r.get("in_vazia")).toBe(0);
    expect(r.get("in_orfa")).toBe(0);
  });
});
