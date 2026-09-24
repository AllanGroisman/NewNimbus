// O cupom do repasse testado NO CHECKOUT do produto que chegou com ele (task 7).
//
// A extensão abre o produto, vai ao checkout, digita o código no modal "Cupons" e
// devolve o que viu; o servidor lê e grava (backend/repasse/checkout-cupom.js).
// Serve o botão "Testar" e a fila automática da aba Repasse — o mesmo caminho
// nos dois, para o mesmo cupom não responder coisas diferentes conforme quem pediu.
import { coletorEntende, cupomNoCheckout } from "./coletor";
import { adminRepasseCupomCheckoutResultado } from "./api";

export const COMANDO_CHECKOUT = "cupom-no-checkout";

export function extensaoTestaNoCheckout() {
  return coletorEntende(COMANDO_CHECKOUT);
}

// Devolve { verdict, message, campaignId, checkedAt, checkCount, source, resultado }.
export async function testarNoCheckout(code, url, { source = "repasse-checkout", manualId = null, onProgresso } = {}) {
  const c = String(code || "").trim().toUpperCase();
  if (!c || !url) throw new Error("Faltou o código ou o link do produto.");
  const t0 = Date.now();
  const material = await cupomNoCheckout({ url, code: c }, { onProgresso });
  return adminRepasseCupomCheckoutResultado({ code: c, url, material, source, manualId, durationMs: Date.now() - t0 });
}
