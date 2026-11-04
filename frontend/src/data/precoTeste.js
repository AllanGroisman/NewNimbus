// O laço da aba Admin › Scraping Cupons › Cupons Teste: para cada envio recente
// com cupom, a extensão abre o link que foi pro grupo, vai ao checkout, digita o
// cupom e devolve o que viu. O servidor compara com o que a mensagem prometeu
// (backend/coupons/preco-teste.js) e grava.
//
// Uma aba por vez, com pausa entre os produtos: é a conta do ML do admin, e rajada
// é o que acorda o anti-robô. Verificação do ML não resolvida para a rodada toda —
// ela vale para a CONTA, não para aquele produto.
//
// O "Parar" não interrompe o produto aberto (a extensão não tem como cancelar no
// meio): ele termina e a rodada fecha como "cancelada".
import { cupomNoCheckout, coletorEntende } from "./coletor";
import {
  adminCuponsTesteAlvos, adminCuponsTesteAbrirRun, adminCuponsTesteItem, adminCuponsTesteFecharRun,
} from "./api";

export const COMANDO = "cupom-no-checkout";

export function extensaoConfere() {
  return coletorEntende(COMANDO);
}

// O passo da extensão em português. Os eventos são os do cupom-no-checkout
// (extension/cupom-checkout.js) e do caminho até o checkout (extension/checkout.js).
export function descreverPasso(ev) {
  if (!ev) return null;
  switch (ev.tipo) {
    case "muro": return "o Mercado Livre pediu verificação — resolva na aba que abriu (a rodada espera)";
    case "variacao": return `escolhendo a variação do produto (${(ev.escolhas || []).join(", ") || "?"})`;
    case "checkout": return "indo ao checkout (sem comprar nada)…";
    case "passo": return `checkout · passo ${ev.passo}${ev.titulo ? `: ${ev.titulo}` : ""}`;
    case "seguro": return ev.como ? "recusou a oferta de seguro (“Agora não”)" : "apareceu oferta de seguro";
    case "cupons-modal": return "abrindo o quadro “Cupons” do checkout";
    case "aplicado": return `digitando o cupom ${ev.code || ""} e clicando em Inserir`;
    case "capturado": return "lendo o desconto que o ML deu — mandando pro servidor…";
    default: return null;
  }
}

const esperar = (ms, parou) => new Promise(resolve => {
  // A pausa acaba antes se o Parar for apertado: ninguém quer esperar 15s à toa.
  const fim = Date.now() + ms;
  const tick = () => (parou() || Date.now() >= fim ? resolve() : setTimeout(tick, Math.min(250, fim - Date.now())));
  tick();
});

// Eventos (`onProgresso`):
//   inicio  { total, runId, alvos }    — a fila montada e a rodada aberta
//   produto { i, de, alvo }            — começou o i de n
//   passo   { texto, alvo }            — o passo da extensão
//   feito   { i, de, item }            — o resultado gravado pelo servidor
//   pausa   { ms }                     — antes do próximo
//   muro    {}                         — o ML pediu verificação
// Devolve { runId, itens, status, motivo }.
export async function conferirPrecos({ parou = () => false, onProgresso = () => {} } = {}) {
  const fila = await adminCuponsTesteAlvos();
  const alvos = fila.alvos || [];
  const pausa = Number(fila.config?.pausaEntreMs) || 0;
  if (!alvos.length) return { runId: null, itens: [], status: "vazia", motivo: "Nenhum envio com cupom nesse período." };

  const { run } = await adminCuponsTesteAbrirRun(alvos.length);
  onProgresso({ tipo: "inicio", total: alvos.length, runId: run.id, alvos, fila });

  const itens = [];
  let status = "concluida";
  let motivo = null;
  try {
    for (let i = 0; i < alvos.length; i++) {
      if (parou()) { status = "cancelada"; motivo = "Parado por você."; break; }
      const alvo = alvos[i];
      onProgresso({ tipo: "produto", i: i + 1, de: alvos.length, alvo });
      const t0 = Date.now();
      let material = null;
      let erro = null;
      try {
        material = await cupomNoCheckout({ url: alvo.link, code: alvo.coupon }, {
          onProgresso: (ev) => {
            if (ev?.tipo === "muro") onProgresso({ tipo: "muro", alvo });
            const texto = descreverPasso(ev);
            if (texto) onProgresso({ tipo: "passo", texto, alvo });
          },
        });
      } catch (err) {
        erro = err?.message || String(err || "a extensão não respondeu");
      }
      const r = await adminCuponsTesteItem(run.id, { alvo, material, erro, durationMs: Date.now() - t0 });
      itens.push(r.item);
      onProgresso({ tipo: "feito", i: i + 1, de: alvos.length, item: r.item });
      if (r.muro) {
        status = "interrompida";
        motivo = "O Mercado Livre pediu verificação e ela não foi resolvida — parei de propósito pra não queimar a conta.";
        break;
      }
      if (i < alvos.length - 1 && pausa > 0 && !parou()) {
        onProgresso({ tipo: "pausa", ms: pausa });
        await esperar(pausa, parou);
      }
    }
    if (status === "concluida" && parou() && itens.length < alvos.length) { status = "cancelada"; motivo = "Parado por você."; }
  } catch (err) {
    status = "interrompida";
    motivo = err?.message || "A rodada não terminou.";
    throw err;
  } finally {
    await adminCuponsTesteFecharRun(run.id, { status, motivo }).catch(() => {});
  }
  return { runId: run.id, itens, status, motivo };
}
