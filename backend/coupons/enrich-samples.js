// As AMOSTRAS dos cupons viram produto de catálogo.
//
// A amostra são as 4 miniaturas do card do cupom (ml-cupons.js:sampleIdsFromTracking):
// produtos que o ML diz que o cupom cobre, de graça, para TODO cupom — inclusive o
// não ativado, que não tem vitrine nenhuma. Só que elas chegam só com o MLB, sem
// nome nem preço, e por isso nunca entraram no catálogo (coupons/pg.js:
// replaceCouponSamples). Resultado medido em 19/09/2026: 2.632 vínculos de amostra
// e UM casando com produto do catálogo. O cupom sabia de quem era; o sistema não
// tinha o produto pra mostrar.
//
// O que resolve é o mesmo truque do repasse (scraping/ml-social.js): a URL do
// anúncio passa pela API de link curto com a conta do SISTEMA e a landing de
// afiliado que sai é lida por fetch cru, sem navegador (~1,5 s).
//
// Duas armadilhas medidas na sonda de 19/09:
//
//   - O MLB da amostra é número de ANÚNCIO. Com a URL de catálogo (`/p/MLB<id>`,
//     que é a sintética guardada no vínculo) o ML recusa o link ("nao-e-produto");
//     com `produto.mercadolivre.com.br/MLB-<id>` ele aceita.
//   - A landing devolve o permalink `/up/MLBU…`, cuja chave de catálogo NÃO é a da
//     amostra (o productKey só reconhece `/p/MLB` e `MLB-…`). Gravar com ele criaria
//     um produto que nenhum vínculo acha. O produto entra com a URL do anúncio — a
//     mesma chave da amostra, e um link que a API de afiliado aceita no envio.
//
// E a conferência que não pode faltar: o card da landing tem que ser o MESMO
// anúncio pedido (`mlItemId`). Landing que devolve outro item é descartada — senão
// o selo "cupom" iria parar num produto que o cupom não cobre.
const coupons = require("./pg");
const { productKey, mlItemIdFromUrl } = require("../catalog/product-key");

// Muro: parar a leva inteira. O próximo MLB levaria a mesma parede, e cada
// tentativa é mais uma requisição na conta do sistema.
const MUROS = new Set(["captcha", "login", "login-wall", "verificacao", "desafio", "afiliado-ausente"]);

const SLEEP_REAL = process.env.NODE_ENV !== "test";
const sleep = (ms) => new Promise(r => setTimeout(r, SLEEP_REAL ? ms : 0));

// A URL que o ML aceita para o número de anúncio. Devolve null para o que não é MLB.
function urlDoAnuncio(mlId) {
  const n = (String(mlId || "").match(/MLB-?(\d{6,})/i) || [])[1];
  return n ? `https://produto.mercadolivre.com.br/MLB-${n}` : null;
}

// Pura: o que a landing leu vira linha de catálogo — ou null, quando ela não é a
// prova de que se trata do mesmo anúncio. Testável sem rede.
function produtoDaAmostra(mlId, lido) {
  const pedido = mlItemIdFromUrl(urlDoAnuncio(mlId));
  const p = lido?.ok ? lido.product : null;
  if (!pedido || !p || !p.name || p.price == null) return null;
  if (String(p.mlItemId || "").toUpperCase() !== pedido) return null;
  const link = urlDoAnuncio(mlId);
  const produto = {
    ...p,
    link,
    finalUrl: link,
    store: "Mercado Livre",
    // O permalink que a landing deu (`/up/MLBU…`), guardado só como referência:
    // o `link` fica o do anúncio pela chave, explicado lá em cima.
    pdpLink: p.link || null,
    viaAmostraDeCupom: true,
  };
  return { ...produto, key: productKey(produto) };
}

// Uma leva. `deveParar` é o freio de quem chama (breaker, rodada do admin que
// começou no meio). Devolve { tentadas, trazidas, descartadas, muro, mensagem }.
async function enriquecerLote({ limit = 60, refazerDias = 7, pausaMs = 2000, deveParar = () => false } = {}) {
  const affiliate = require("../scraping/affiliate");
  const mlSocial = require("../scraping/ml-social");
  const catalog = require("../catalog");

  const alvos = await coupons.amostrasSemCatalogo({ limit, refazerDias });
  const r = { tentadas: 0, trazidas: 0, descartadas: 0, muro: null, mensagem: null };
  const tentadas = [];

  for (let i = 0; i < alvos.length; i++) {
    if (deveParar()) break;
    if (i > 0) await sleep(pausaMs + Math.random() * pausaMs);

    const { productKey: chave, productUrl } = alvos[i];
    const mlId = mlItemIdFromUrl(productUrl);
    const url = urlDoAnuncio(mlId);
    if (!url) { tentadas.push(chave); continue; }

    r.tentadas += 1;
    const link = await affiliate.criarLinkAfiliadoMLSistema(url);
    if (!link.shortUrl) {
      if (MUROS.has(link.kind)) { r.muro = link.kind; r.mensagem = link.reason; break; }
      // Link recusado (anúncio encerrado, fora do programa): resposta do ML sobre
      // ESTE produto. Carimba e segue.
      tentadas.push(chave);
      r.descartadas += 1;
      continue;
    }

    let lido;
    try {
      lido = await mlSocial.fetchSocialLanding(link.shortUrl);
    } catch (err) {
      // Soluço de rede: não carimba, a próxima leva tenta de novo.
      r.descartadas += 1;
      continue;
    }
    if (!lido.ok && MUROS.has(lido.kind)) { r.muro = lido.kind; r.mensagem = lido.reason; break; }

    tentadas.push(chave);
    const produto = produtoDaAmostra(mlId, lido);
    if (!produto) { r.descartadas += 1; continue; }
    await catalog.upsertProducts([produto]);
    r.trazidas += 1;
  }

  await coupons.marcarEnriquecimento(tentadas);
  return r;
}

module.exports = { enriquecerLote, produtoDaAmostra, urlDoAnuncio, MUROS };
