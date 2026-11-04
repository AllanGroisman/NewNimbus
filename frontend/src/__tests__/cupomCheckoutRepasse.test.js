// O teste no checkout pela extensão: quando ela desiste no meio, o servidor tem
// que ficar sabendo — senão o cupom fica "testando" por meia hora (o MODAML).
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../data/api", () => ({ adminRepasseCupomCheckoutResultado: vi.fn() }));
vi.mock("../data/coletor", () => ({ coletorEntende: vi.fn(), cupomNoCheckout: vi.fn() }));

import { adminRepasseCupomCheckoutResultado } from "../data/api";
import { cupomNoCheckout } from "../data/coletor";
import { testarNoCheckout } from "../data/cupomCheckoutRepasse";

const URL = "https://www.mercadolivre.com.br/x/p/MLB1";

beforeEach(() => vi.clearAllMocks());

describe("testarNoCheckout", () => {
  it("manda o material da extensão pro servidor", async () => {
    cupomNoCheckout.mockResolvedValue({ html: "x" });
    adminRepasseCupomCheckoutResultado.mockResolvedValue({ verdict: "valid" });
    await expect(testarNoCheckout("modaml", URL)).resolves.toEqual({ verdict: "valid" });
    expect(adminRepasseCupomCheckoutResultado).toHaveBeenCalledWith(expect.objectContaining({ code: "MODAML", material: { html: "x" } }));
  });

  it("extensão que falha: avisa o servidor com o erro e repassa a falha", async () => {
    cupomNoCheckout.mockRejectedValue(new Error("tempo esgotado"));
    adminRepasseCupomCheckoutResultado.mockResolvedValue({ ok: false });
    await expect(testarNoCheckout("MODAML", URL, { source: "repasse-checkout-auto" })).rejects.toThrow("tempo esgotado");
    expect(adminRepasseCupomCheckoutResultado).toHaveBeenCalledWith(expect.objectContaining({
      code: "MODAML", url: URL, erro: "tempo esgotado", source: "repasse-checkout-auto",
    }));
    expect(adminRepasseCupomCheckoutResultado.mock.calls[0][0].material).toBeUndefined();
  });
});
