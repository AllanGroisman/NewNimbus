// A sonda do checkout em LOTE (task 13): os produtos do scraping, um de cada vez,
// no Chrome do admin — a mesma sonda do botão "Sondar o checkout deste produto".
//
// Uma sonda já lê TODOS os cupons que o checkout oferece para o produto, então o
// lote não cruza produto × cupom: é uma sonda por produto. A escolha e a ordem dos
// produtos são do servidor (backend/coupons/checkout-lote.js); aqui só se anda a
// fila e se devolve o que veio.
//
// Uma aba por vez é o padrão, pelo mesmo motivo das vitrines (produtosNoChrome.js):
// várias abas batendo no ML com a mesma conta é o que acorda o anti-robô. Mais abas
// é opt-in, pelo ritmo que o servidor devolve. E o muro para o lote inteiro — ele
// vale para a CONTA, não para aquele produto.
import { sondarCuponsNoCheckout, coletorEntende } from "./coletor";
import { adminSondaLoteAlvos, adminSondaLoteResultado, adminSondaLoteRegistrarRun } from "./api";

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

// O mesmo teto da faixa do servidor (backend/coupons/checkout-lote-config.js). O
// servidor já manda o valor saneado; o corte aqui é só a rede de segurança.
const MAX_ABAS = 8;

// Os tempos que viajam até a extensão (extension/checkout.js: `lerTempos`).
function temposDaSonda(cfg) {
  return {
    settleMs: cfg.settleMs,
    esperaCheckoutMs: cfg.esperaCheckoutMs,
    esperaNavMs: cfg.esperaNavMs,
  };
}

// Devolve { feitos, parado, muro, paralelo }. `feitos`: uma linha por produto
// tentado, na ordem da fila — { key, name, link, category, ok, cupons[], motivo }.
//
// O ritmo vem do servidor (`cfg` da fila, backend/coupons/checkout-lote-config.js):
// `paralelo` abas ao mesmo tempo, cada uma com `pausaMs` entre os produtos dela, no
// mesmo esquema das vitrines (produtosNoChrome.js:colherVitrines) — entrada
// escalonada, e o primeiro muro fecha a porta para todas: quem já está sondando
// termina, ninguém começa outro produto. Com mais de uma aba, o plano B do carrinho
// fica desligado na extensão (o carrinho da conta é um só).
//
// Extensão sem o "cupons-checkout-v2" não entende nada disso: anda como antes, uma
// aba e o caminho longo.
//
// Eventos (`onProgresso`): `fila` (o tamanho do serviço e o ritmo), `produto`
// (começou o i de n, na aba `aba`), `passo` (o passo da extensão, repassado),
// `produto-feito`, `pausa` (só com uma aba), `muro`.
export async function sondarLote({ filtros = {}, parou = () => false, onProgresso = () => {}, pausaMs = null } = {}) {
  const inicio = new Date();
  const fila = await adminSondaLoteAlvos(filtros);
  const produtos = fila.produtos || [];
  const cfg = fila.cfg || {};
  const pausa = pausaMs ?? cfg.pausaMs ?? 5000;
  const nova = await coletorEntende("cupons-checkout-v2").catch(() => false);
  const paralelo = nova ? Math.max(1, Math.min(MAX_ABAS, Number(cfg.paralelo) || 1)) : 1;
  const opcoesDaSonda = nova
    ? { rapido: cfg.modoRapido !== false, semCarrinho: paralelo > 1, tempos: temposDaSonda(cfg) }
    : {};
  onProgresso({ tipo: "fila", total: produtos.length, elegiveis: fila.total, paralelo, extensaoNova: nova });

  const feitos = new Array(produtos.length);
  const envios = [];
  let parado = null;
  let muro = false;
  let proximo = 0;

  const deveParar = () => {
    if (parado) return true;
    if (parou()) { parado = "Interrompido por você"; return true; }
    return false;
  };

  async function umProduto(p, i, aba) {
    onProgresso({ tipo: "produto", i: i + 1, de: produtos.length, produto: p, aba });
    const t0 = Date.now();

    // Basta o TIPO do evento, como nas vitrines: o rótulo do muro pode vir vazio.
    let viuMuro = false;
    let material = null;
    let erro = null;
    try {
      material = await sondarCuponsNoCheckout(p.link, {
        ...opcoesDaSonda,
        onProgresso: (ev) => {
          if (ev?.tipo === "muro") { viuMuro = true; onProgresso({ tipo: "muro", produto: p, aba }); }
          onProgresso({ tipo: "passo", passo: ev, produto: p, aba });
        },
      });
      if (material?.muro) viuMuro = true;
    } catch (err) {
      erro = err.message;
    }
    // O muro fecha a porta ANTES de o resultado ir pro servidor: a outra aba não
    // pode começar produto novo enquanto esta espera a resposta.
    if (viuMuro && !muro) {
      muro = true;
      parado = "O Mercado Livre pediu verificação — parei aqui de propósito";
    }

    // O resultado vai pro servidor sem segurar a aba: a próxima sonda já pode
    // começar. A linha do produto só fecha quando o servidor responde.
    const envio = (async () => {
      let linha;
      if (erro === null) {
        try {
          const r = await adminSondaLoteResultado({ key: p.key, url: p.link, material: materialEnxuto(material) });
          linha = { ...p, ok: r.ok, cupons: r.cupons || [], motivo: r.motivo || null, cuponsNovos: r.cuponsNovos || 0 };
        } catch (err) {
          linha = { ...p, ok: false, cupons: [], motivo: err.message };
        }
      } else {
        // A extensão falhou (timeout, aba fechada): o servidor anota como falha, e o
        // produto volta à fila amanhã. Se nem isso der, o lote segue mesmo assim.
        await adminSondaLoteResultado({ key: p.key, url: p.link, erro }).catch(() => {});
        linha = { ...p, ok: false, cupons: [], motivo: erro };
      }
      // Da aba abrindo até o servidor gravar: é o custo de UMA sonda.
      linha.duracaoMs = Date.now() - t0;
      feitos[i] = linha;
      onProgresso({ tipo: "produto-feito", i: i + 1, de: produtos.length, aba, ...linha });
    })();
    envios.push(envio);
    // Com uma aba só, o próximo espera o envio: o painel conta um produto de cada vez
    // e o muro de um resultado nunca cruza com o início do próximo.
    if (paralelo === 1) await envio;
  }

  async function trabalhador(aba) {
    // Escalonado: a segunda aba entra uma fração da pausa depois da primeira.
    if (aba > 0) await esperar(Math.round((aba * pausa) / paralelo));
    for (;;) {
      if (deveParar() || proximo >= produtos.length) return;
      const i = proximo++;
      await umProduto(produtos[i], i, aba);
      if (deveParar() || proximo >= produtos.length) return;
      // Com várias abas, uma "pausa" no painel mentiria: as outras estão andando.
      if (paralelo === 1) onProgresso({ tipo: "pausa", ms: pausa });
      await esperar(pausa);
    }
  }

  const n = Math.min(paralelo, produtos.length);
  await Promise.all(Array.from({ length: n }, (_, aba) => trabalhador(aba)));
  await Promise.all(envios);

  const lista = feitos.filter(Boolean);
  if (!parado && parou() && lista.length < produtos.length) parado = "Interrompido por você";

  // O resumo da execução vai pro histórico (Admin › Cupons do produto). Execução
  // sem produto nenhum não conta nada. Falhar aqui não pode derrubar o lote: os
  // resultados já foram gravados um a um.
  if (lista.length) {
    const tempos = lista.map(f => f.duracaoMs).filter(Number.isFinite);
    await adminSondaLoteRegistrarRun({
      inicio: inicio.toISOString(),
      fim: new Date().toISOString(),
      produtos: lista.length,
      naFila: produtos.length,
      ok: lista.filter(f => f.ok).length,
      comCupom: lista.filter(f => f.ok && f.cupons?.length).length,
      falhas: lista.filter(f => !f.ok).length,
      mediaSondaMs: tempos.length ? Math.round(tempos.reduce((a, b) => a + b, 0) / tempos.length) : null,
      ritmo: { paralelo, pausaMs: pausa, settleMs: cfg.settleMs ?? null, modoRapido: nova ? cfg.modoRapido !== false : false },
      parado,
      muro,
    }).catch(() => {});
  }
  return { feitos: lista, parado, muro, paralelo };
}
