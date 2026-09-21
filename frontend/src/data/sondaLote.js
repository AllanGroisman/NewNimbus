// A sonda do checkout em LOTE (task 13): os produtos do scraping, um de cada vez,
// no Chrome do admin — a mesma sonda do botão "Sondar o checkout deste produto".
//
// Uma sonda já lê TODOS os cupons que o checkout oferece para o produto, então o
// lote não cruza produto × cupom: é uma sonda por produto. A escolha e a ordem dos
// produtos são do servidor (backend/coupons/checkout-lote.js); aqui só se anda a
// fila e se devolve o que veio.
//
// Um de cada vez e com pausa, pelo mesmo motivo das vitrines (produtosNoChrome.js):
// em paralelo seriam várias abas batendo no ML com a mesma conta. E o muro para o
// lote inteiro — ele vale para a CONTA, não para aquele produto.
import { sondarCuponsNoCheckout } from "./coletor";
import { adminSondaLoteAlvos, adminSondaLoteResultado } from "./api";

// Só o que o servidor usa para ler a lista de cupons (product-coupons.js:
// lerCuponsDaSonda) e explicar a falha. A sonda inteira passa fácil dos 2 MB — o
// HTML das páginas, as respostas da API —, e no lote ninguém vai olhar o dump.
export function materialEnxuto(material) {
  const m = material || {};
  const soIframes = (cap) => (cap?.iframes?.length ? { iframes: cap.iframes.map(f => ({ html: f?.html || "" })) } : null);
  const ck = m.checkout || {};
  return {
    checkout: { reached: !!ck.reached, via: ck.via || null, blockedReason: ck.blockedReason || null, cartCleaned: ck.cartCleaned },
    paginaDosCupons: m.paginaDosCupons ? { ok: !!m.paginaDosCupons.ok, html: m.paginaDosCupons.html || "" } : null,
    capturaDosCupons: soIframes(m.capturaDosCupons),
    capturaDosAtivos: soIframes(m.capturaDosAtivos),
    muro: m.muro || null,
    motivo: m.motivo || (m.notProductPage ? "o link não abriu uma página de produto" : null),
  };
}

// O passo da extensão em uma linha — o mesmo texto na sonda de um produto e no lote.
export function descreverPasso(p) {
  if (!p) return null;
  if (p.tipo === "muro") return "o Mercado Livre pediu verificação — resolva na aba que abriu";
  if (p.tipo === "pdp") return "página do produto lida";
  if (p.tipo === "checkout") return `indo ao checkout (${p.via})…`;
  if (p.tipo === "passo") return `checkout · passo ${p.passo}${p.titulo ? `: ${p.titulo}` : ""}`;
  if (p.tipo === "seguro") return p.como ? "oferta de seguro recusada (“Agora não”)" : "apareceu a oferta de seguro e não deu pra recusar";
  if (p.tipo === "pagina-cupons") return p.ok ? "lista de cupons do checkout lida" : "não achei a lista de cupons na página do checkout";
  if (p.tipo === "capturado") return "tela dos cupons fotografada — mandando pro servidor…";
  return null;
}

const esperar = (ms) => new Promise(r => setTimeout(r, ms));

// Devolve { feitos, parado, muro }. `feitos`: uma linha por produto tentado —
// { key, name, link, category, ok, cupons[], motivo }.
//
// Eventos (`onProgresso`): `fila` (o tamanho do serviço), `produto` (começou o i de
// n), `passo` (o passo da extensão, repassado), `produto-feito`, `pausa`, `muro`.
export async function sondarLote({ filtros = {}, parou = () => false, onProgresso = () => {}, pausaMs = null } = {}) {
  const fila = await adminSondaLoteAlvos(filtros);
  const produtos = fila.produtos || [];
  const pausa = pausaMs ?? fila.cfg?.pausaMs ?? 5000;
  onProgresso({ tipo: "fila", total: produtos.length, elegiveis: fila.total });

  const feitos = [];
  let parado = null;
  let muro = false;

  for (let i = 0; i < produtos.length; i++) {
    if (parou()) { parado = "Interrompido por você"; break; }
    const p = produtos[i];
    onProgresso({ tipo: "produto", i: i + 1, de: produtos.length, produto: p });

    // Basta o TIPO do evento, como nas vitrines: o rótulo do muro pode vir vazio.
    let viuMuro = false;
    let linha;
    try {
      const material = await sondarCuponsNoCheckout(p.link, {
        onProgresso: (ev) => {
          if (ev?.tipo === "muro") { viuMuro = true; onProgresso({ tipo: "muro", produto: p }); }
          onProgresso({ tipo: "passo", passo: ev, produto: p });
        },
      });
      if (material?.muro) viuMuro = true;
      const r = await adminSondaLoteResultado({ key: p.key, url: p.link, material: materialEnxuto(material) });
      linha = { ...p, ok: r.ok, cupons: r.cupons || [], motivo: r.motivo || null, cuponsNovos: r.cuponsNovos || 0 };
    } catch (err) {
      // A extensão falhou (timeout, aba fechada): o servidor anota como falha, e o
      // produto volta à fila amanhã. Se nem isso der, o lote segue mesmo assim.
      await adminSondaLoteResultado({ key: p.key, url: p.link, erro: err.message }).catch(() => {});
      linha = { ...p, ok: false, cupons: [], motivo: err.message };
    }
    feitos.push(linha);
    onProgresso({ tipo: "produto-feito", i: i + 1, de: produtos.length, ...linha });

    if (viuMuro) {
      muro = true;
      parado = "O Mercado Livre pediu verificação — parei aqui de propósito";
      break;
    }
    if (i < produtos.length - 1 && !parou()) {
      onProgresso({ tipo: "pausa", ms: pausa });
      await esperar(pausa);
    }
  }

  if (!parado && parou() && feitos.length < produtos.length) parado = "Interrompido por você";
  return { feitos, parado, muro };
}
