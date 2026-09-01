// Testar UM cupom num produto, pelo caminho que estiver disponível.
//
// Dois caminhos, como no teste de palavra:
//
//   1. a extensão, numa aba do Chrome do admin. Desde 25/08/2026 o ML barra o
//      navegador automatizado com CAPTCHA já na página do produto — este é o
//      caminho que chega ao checkout;
//   2. o servidor (`POST /ml-coupon/test`), que abre o próprio Chrome. Continua
//      existindo para quando a extensão não está instalada.
//
// Nos dois, o veredito sai das mesmas funções puras do backend: a extensão CAMINHA
// e devolve o que a tela mostrava; ela não conclui nada.
//
// E nos dois valem os mesmos freios: o caminho rápido responde primeiro quando o
// sistema já sabe (sem abrir nada), e o checkout NUNCA finaliza compra.
import { coletorEntende, testarCupomNoChrome } from "./coletor";
import { adminCouponTest, adminCouponLocalStart, adminCouponLocalResult } from "./api";

export async function testarCupom({ url, code = null, mode = "leitura", onProgresso } = {}) {
  const limpo = { url: String(url || "").trim(), code: (code || "").trim() || null, mode };

  if (await coletorEntende("checkout")) {
    // O caminho rápido primeiro, no servidor: ele responde pelo que o sistema já
    // sabe, em segundos e sem abrir aba nenhuma.
    const inicio = await adminCouponLocalStart(limpo);
    if (inicio.conclui) return inicio.result;

    const material = await testarCupomNoChrome(
      { url: inicio.url, code: inicio.code, mode: inicio.mode },
      { onProgresso },
    );
    const r = await adminCouponLocalResult({
      url: inicio.url, code: inicio.code, mode: inicio.mode, material, quick: inicio.quick || null,
    });
    return r.result;
  }

  const r = await adminCouponTest(limpo);
  return r.result;
}
