// O teste de cupom SEM navegador — o caminho rápido do Admin › Cupom.
//
// A pergunta é sempre a mesma: "este CÓDIGO dá desconto NESTE produto?". Até aqui
// a única resposta vinha de levar o item ao checkout do ML com um Chrome logado
// (scraping/ml-coupon.js), e esse caminho leva de 40 a 90 segundos quando dá
// certo — e desde 25/08/2026 quase sempre nem chega lá: o ML barra o navegador
// automatizado com CAPTCHA já na página do produto (ver scraping/ml-social.js).
//
// Mas o sistema quase sempre JÁ SABE a resposta, em três pedaços que existem há
// tempo e nunca tinham sido costurados:
//
//   1. `coupons/sync.checkWord` diz o que o ML acha da palavra (campanha, vencido,
//      esgotado, não existe). É a aba /cupons, não o checkout — e ela responde.
//   2. `ml_coupon_products` diz quais produtos a vitrine daquele cupom cobre.
//   3. `coupons/price.precoComCupom` faz a conta do desconto com as regras do cupom.
//
// Este arquivo só costura os três. Ele NUNCA abre navegador: quando não dá pra
// concluir, devolve `conclui: false` e quem chamou decide se vale o checkout.
//
// A separação decide()/quickCheck() é de propósito: `decide` é puro e é onde mora
// a regra que erra caro (ver "sem-vitrine" abaixo), então ela é testável sem banco
// e sem rede.
const { productKey, mlItemIdFromUrl, mlAnuncioIdFromUrl } = require("../catalog/product-key");
const coupons = require("./pg");
const { precoComCupom } = require("./price");

// Quanto tempo uma palavra testada continua valendo sem perguntar de novo ao ML.
// Mesmo número do `checkWord`, e pelo mesmo motivo: cada teste novo é um Chrome
// aberto na conta do sistema.
const MAX_AGE_HORAS = 12;

// Onde o produto está em relação à vitrine do cupom. Os três casos são
// DIFERENTES e confundir os dois últimos é o erro caro deste módulo:
//
//   na-vitrine     — o vínculo existe: o cupom cobre este produto.
//   fora-da-vitrine— a vitrine foi raspada e este produto não está nela.
//   sem-vitrine    — a vitrine nunca foi raspada (zero vínculos pra campanha).
//
// "sem-vitrine" é FALTA DE DADO, não resposta. Tratá-lo como "fora" diria "esse
// cupom não vale aqui" para um cupom que talvez valha — e cupom bom descartado é
// exatamente o prejuízo que a ferramenta existe pra evitar.
const NA_VITRINE = "na-vitrine";
const FORA_DA_VITRINE = "fora-da-vitrine";
const SEM_VITRINE = "sem-vitrine";

function venceu(v) {
  if (!v) return false;
  const t = new Date(v).getTime();
  return Number.isFinite(t) && t <= Date.now();
}

// A decisão, pura. Recebe o que o ML disse da palavra (`check`), a linha do cupom
// no banco (`cupom`, ou null), onde o produto está (`cobertura`) e o preço do
// produto (ou null quando não deu pra saber).
//
// Devolve { conclui, status, reason, discount, priceBefore, priceAfter }. `status`
// usa os mesmos nomes que a tela do admin já pinta (frontend/src/pages/AdminCupom.jsx).
// `conclui: false` significa "não sei" — e aí quem chamou é que decide o próximo passo.
function decide({ check = null, cupom = null, cobertura = SEM_VITRINE, preco = null } = {}) {
  const naoSei = (motivo) => ({ conclui: false, status: "indeterminado", reason: motivo, discount: null, priceBefore: preco, priceAfter: null });

  if (!check) return naoSei("Não deu pra perguntar ao Mercado Livre sobre essa palavra.");

  // O ML avaliou a palavra e ela não existe. Resposta fechada — não há checkout
  // que mude isso, e mandar o Chrome atrás seria só queimar a conta à toa.
  if (check.verdict === "invalid") {
    return { conclui: true, status: "invalido", discount: null, priceBefore: preco, priceAfter: null,
      reason: check.message || "O Mercado Livre não reconheceu essa palavra." };
  }

  // Engasgo do ML: ele não chegou a avaliar. Diferente de "não existe".
  if (check.verdict !== "valid") {
    return naoSei(check.message
      ? `O Mercado Livre respondeu "${check.message}" — ele não chegou a avaliar a palavra.`
      : "O Mercado Livre não respondeu nada reconhecível sobre essa palavra.");
  }

  // Daqui pra baixo a palavra é uma campanha de verdade. O `response_code` do ML
  // vale MAIS que a data guardada aqui: ele é de agora, a linha do banco é da
  // última rodada de cupons.
  const codigo = String(check.responseCode || "").toUpperCase();
  if (/EXPIRED/.test(codigo) || venceu(cupom?.expiresAt)) {
    return { conclui: true, status: "expirado", discount: null, priceBefore: preco, priceAfter: null,
      reason: check.message || "Esse cupom já venceu." };
  }
  if (/SOLD_OUT|USED|REDEEMED/.test(codigo)) {
    return { conclui: true, status: "usado", discount: null, priceBefore: preco, priceAfter: null,
      reason: check.message || "Esse cupom esgotou." };
  }

  // Campanha viva, mas o sistema nunca a raspou: sem a linha não há regra de
  // desconto pra aplicar nem vitrine pra conferir.
  if (!cupom) {
    return naoSei("O Mercado Livre reconheceu a palavra, mas essa campanha ainda não está no sistema — puxe os cupons (ou busque só ela) e teste de novo.");
  }

  if (cobertura === SEM_VITRINE) {
    return naoSei(`O cupom "${cupom.title || cupom.campaignId}" existe e está valendo, mas a vitrine dele nunca foi raspada — não dá pra dizer daqui se ele cobre este produto.`);
  }

  if (cobertura === FORA_DA_VITRINE) {
    return { conclui: true, status: "nao-aplicavel", discount: null, priceBefore: preco, priceAfter: null,
      reason: `Este produto não está entre os que o cupom "${cupom.title || cupom.campaignId}" cobre.` };
  }

  // O produto está na vitrine de um cupom que está valendo. Isso JÁ É o veredito:
  // a pergunta é "esse cupom vale neste produto?", e a resposta é sim. O preço
  // entra só pra dizer QUANTO — e não tê-lo não pode virar "não sei", senão a
  // ferramenta cala justamente sobre o caso que ela existe pra responder.
  const nome = cupom.title || cupom.campaignId;
  const min = Number(cupom.minPurchase);
  const temMinimo = Number.isFinite(min) && min > 0;
  const temPreco = Number.isFinite(preco) && preco > 0;

  // A única exceção: com compra mínima o preço deixa de ser detalhe e vira parte
  // da regra. Sem ele não dá pra saber se o cupom pega.
  if (temMinimo && !temPreco) {
    return naoSei(`O cupom "${nome}" cobre este produto, mas só pega em compras a partir de ${brl(min)} — e não deu pra ler o preço do produto pra conferir.`);
  }
  if (temMinimo && preco < min) {
    return { conclui: true, status: "minimo-nao-atingido", discount: null, priceBefore: preco, priceAfter: null,
      reason: `O cupom só pega em compras a partir de ${brl(min)} e este produto custa ${brl(preco)}.` };
  }

  const final = temPreco ? precoComCupom(preco, cupom) : null;
  if (final === null) {
    // Cobre o produto, mas o quanto não dá pra dizer: ou o preço não veio, ou as
    // regras guardadas aqui não permitem a conta (`kind` desconhecido).
    return {
      conclui: true, status: "valido", discount: null, priceBefore: temPreco ? preco : null, priceAfter: null,
      reason: temPreco
        ? `O cupom "${nome}" cobre este produto, mas as regras dele guardadas aqui não permitem calcular o desconto.`
        : `O cupom "${nome}" cobre este produto. Não deu pra ler o preço, então não sei dizer quanto fica.`,
    };
  }

  return {
    conclui: true, status: "valido", discount: Math.round((preco - final) * 100) / 100,
    priceBefore: preco, priceAfter: final,
    reason: `O cupom "${nome}" cobre este produto: ${brl(preco)} → ${brl(final)}.`,
  };
}

function brl(v) {
  return Number.isFinite(v) ? `R$ ${v.toFixed(2).replace(".", ",")}` : "—";
}

// Todas as chaves de catálogo por que ESTE link pode responder.
//
// Um mesmo produto do ML tem várias numerações e o `productKey` não funde elas:
// `/p/MLB123` (catálogo), `/up/MLBU456` (agrupamento de variações) e
// `MLB-789` (anúncio) dão hashes diferentes. A vitrine do cupom é raspada em
// `/p/MLB…`, então um link `/up/MLBU…` — que é o que sai do perfil de afiliado —
// NUNCA casava: a cobertura dava "sem vitrine" mesmo com o produto listado.
//
// O `/up/` costuma trazer o anúncio de verdade na query (`pdp_filters=item_id:MLB…`,
// `wid=MLB…`). Aqui essas pistas viram chaves candidatas. `productKey` continua
// intocado — ele é a PK do catálogo e mudá-lo obrigaria a regerar tudo.
function chavesCandidatas(url) {
  const chaves = [];
  const junta = (link) => {
    if (!link) return;
    const k = productKey({ link });
    if (k && !chaves.includes(k)) chaves.push(k);
  };

  junta(url);

  // O anúncio que a query aponta (`wid`, `pdp_filters=item_id:`, `item_id`) —
  // catalog/product-key.js:mlAnuncioIdFromUrl, a mesma leitura que junta vitrine
  // e scraping numa linha só do catálogo. Uma URL de catálogo sintética só pra
  // reaproveitar o `productKey` — é ele que define a chave, e o hash tem que sair
  // da mesma função.
  const anuncio = mlAnuncioIdFromUrl(String(url || ""));
  if (anuncio) junta(`https://www.mercadolivre.com.br/x/p/${anuncio}`);
  return chaves;
}

// Onde o produto está em relação à vitrine da campanha. Duas perguntas ao banco
// porque elas respondem coisas diferentes: a primeira diz se ESTE produto tem
// vínculo com ESTA campanha, e a segunda diz se a vitrine foi raspada alguma vez —
// e é essa segunda que separa "não está" de "não sei".
//
// Devolve `{ cobertura, origem }`: `origem` é de onde veio o vínculo que casou
// ("vitrine" | "parcial" | "checkout" | "repasse" | null), e serve só para a tela qualificar a resposta.
async function coberturaDoProduto(campaignId, chaves) {
  const lista = (Array.isArray(chaves) ? chaves : [chaves]).filter(Boolean);
  if (!campaignId || !lista.length) return { cobertura: SEM_VITRINE, origem: null };

  // Um vínculo que bate responde a pergunta, venha ele da vitrine inteira ou de um
  // pedaço dela: nos dois casos foi o ML que disse que aquele produto está
  // coberto por aquela campanha.
  //
  // O do repasse é a exceção: quem disse foi o grupo, não o ML. Ele só responde
  // se nenhuma outra chave der um vínculo mais forte e a vitrine inteira não
  // tiver sido raspada — se foi, e o produto não está nela, vale a vitrine.
  let doRepasse = false;
  for (const chave of lista) {
    const origem = await coupons.couponProductOrigem(campaignId, chave);
    if (origem === "repasse") { doRepasse = true; continue; }
    if (origem) return { cobertura: NA_VITRINE, origem };
  }
  const vitrineInteira = await coupons.hasVitrine(campaignId);
  if (doRepasse && !vitrineInteira) return { cobertura: NA_VITRINE, origem: "repasse" };

  // Nenhuma chave bateu — e aqui a origem do que está guardado passa a importar.
  // Só a VITRINE raspada autoriza dizer "não está": ela é a lista completa. Com a
  // parcial é o contrário — são alguns produtos de uma vitrine que pode ter 50, e
  // um produto fora deles não está fora de nada. Contar a parcial aqui transformaria
  // "não sei" em "não vale", que é exatamente o erro que descarta cupom bom.
  const cobertura = vitrineInteira ? FORA_DA_VITRINE : SEM_VITRINE;
  return { cobertura, origem: null };
}

// O preço do produto, e SÓ do catálogo local.
//
// Nada de rede aqui, de propósito. O `scrapeSingleProduct` precisaria da tag de
// afiliado de um usuário (isto é diagnóstico do admin, não tem dono) e, sem ela,
// termina caindo no navegador — que é justamente o que o caminho rápido existe
// pra evitar: desde 25/08/2026 o ML barra o Chrome com CAPTCHA já na PDP.
//
// Sem cutoff de idade porque o preço aqui é informativo ("quanto fica"), não é o
// veredito: quem decide se o cupom vale é a vitrine. Um preço de ontem explica
// melhor que nenhum preço — e a tela diz que ele veio do catálogo.
async function precoDoProduto(url) {
  try {
    const catalog = require("../catalog");
    const p = await catalog.getByLink(url, { maxAgeMs: null });
    if (p && Number.isFinite(p.price)) {
      return { preco: p.price, fonte: "catalogo", produto: p };
    }
  } catch { /* catálogo indisponível não derruba o teste */ }
  return { preco: null, fonte: null, produto: null };
}

// O caminho rápido inteiro. Devolve sempre — `conclui: false` é resposta legítima
// e quer dizer "vale tentar o checkout".
async function quickCheck({ url, code, maxAgeHours = MAX_AGE_HORAS, force = false } = {}) {
  const palavra = String(code || "").trim().toUpperCase().slice(0, 40);
  if (!palavra) throw new Error("Escreva o código do cupom.");

  const chaves = chavesCandidatas(url);
  const chave = chaves[0] || null;
  const mlId = mlItemIdFromUrl(url);

  // O que o ML acha da palavra. O cache de `ml_coupon_codes` responde na hora
  // quando a palavra é conhecida; só o que não está lá vira Chrome aberto.
  const sync = require("./sync");
  const check = await sync.checkWord(palavra, { source: "admin", maxAgeHours, force });

  const campaignId = check.campaignId || null;
  const cupom = campaignId ? await coupons.getCoupon(campaignId) : null;
  const { cobertura, origem: coberturaOrigem } = cupom
    ? await coberturaDoProduto(campaignId, chaves)
    : { cobertura: SEM_VITRINE, origem: null };

  // O preço só interessa quando o cupom cobre o produto — buscar antes disso é
  // uma ida ao ML por nada nos casos que já se resolvem sem ela.
  let preco = null;
  let precoFonte = null;
  let produto = null;
  if (cobertura === NA_VITRINE) {
    const r = await precoDoProduto(url);
    preco = r.preco;
    precoFonte = r.fonte;
    produto = r.produto;
  }

  const veredito = decide({ check, cupom, cobertura, preco });

  return {
    ...veredito,
    fonte: "rapido",
    word: palavra,
    productKey: chave,
    productKeys: chaves,
    mlItemId: mlId,
    campaignId,
    coupon: cupom,
    cobertura,
    coberturaOrigem,
    cached: !!check.cached,
    checkedAt: check.checkedAt || null,
    knownLocally: !!check.knownLocally,
    mlMessage: check.message || null,
    responseCode: check.responseCode || null,
    price: preco,
    priceSource: precoFonte,
    product: produto ? { name: produto.name, price: produto.price, img: produto.img, link: produto.link } : null,
  };
}

module.exports = {
  quickCheck,
  decide,
  coberturaDoProduto,
  chavesCandidatas,
  precoDoProduto,
  NA_VITRINE,
  FORA_DA_VITRINE,
  SEM_VITRINE,
  MAX_AGE_HORAS,
};
