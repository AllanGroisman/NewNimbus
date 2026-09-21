// "Quais cupons valem NESTE produto?" — a pergunta pelo lado do produto (task 12, D).
//
// Duas metades, e só a primeira dá resposta hoje:
//
//   1. SEM NAVEGADOR (`paraProduto`): junta o que o sistema já sabe — os vínculos de
//      `ml_coupon_products` por qualquer chave que o link possa ter, com a origem de
//      cada um e a conta do desconto neste preço. É a mesma leitura que o selo do
//      card faz, mas dizendo DE ONDE vem cada vínculo e o que falta saber.
//
//   2. A SONDA NO CHECKOUT (`gravarSonda`): a extensão leva o produto até o
//      checkout no Chrome do admin, recusa o seguro se ele aparecer e lê a página
//      de cupons daquele carrinho. A sonda de 19/09/2026 confirmou a hipótese: com
//      os cupons ativados na conta, o ML já chega com o melhor aplicado, e essa
//      página (`/cupons/cho?context_id=…`) traz o modelo de todos os que ele oferece
//      — com o desconto calculado (`given_discount`). `checkout-list.js` lê isso, e
//      os que valem viram vínculo `origem: "checkout"`.
//
//      Ela chega ali por dois caminhos, e o segundo é o que sempre responde: o popup
//      "Cupons (n/m em uso)", quando o clique o abre, e a busca direta do deeplink
//      que o modelo do checkout carrega. O clique sozinho não bastava — sem cupom em
//      uso a linha do resumo diz "Inserir código do cupom" e nenhum popup monta.
//
// Ainda NÃO feito, de propósito: usar a ausência como resposta ("o checkout não
// listou o cupom X, então X não vale aqui"). Com uma sonda só não dá pra saber se
// a lista do popup é completa — e a regra de "fora" errada descarta cupom bom.
const fs = require("fs");
const path = require("path");
const { prisma } = require("../db");
const { detalheDoCupom } = require("./price");
const { chavesCandidatas } = require("./quick-check");
const { parseCheckoutCupons, cuponsQueValem } = require("./checkout-list");

const SONDA_DIR = path.join(__dirname, "..", "logs", "ml-checkout-cupons");

// O peso de cada origem, na ordem em que a tela mostra. Só `vitrine` é lista fechada.
const ORIGEM_ROTULO = {
  checkout: "checkout do ML (testado neste produto)",
  vitrine: "vitrine completa do cupom",
  landing: "prévia da vitrine (landing de afiliado)",
  amostra: "miniatura do card do cupom",
};

// Pura: as linhas do banco viram a resposta da tela. Um cupom pode aparecer por mais
// de uma chave do mesmo produto; fica a origem mais forte.
function montarResposta(linhas, produto) {
  const peso = { checkout: 4, vitrine: 3, landing: 2, amostra: 1 };
  const porCampanha = new Map();
  for (const l of linhas || []) {
    const atual = porCampanha.get(l.campaignId);
    if (!atual || (peso[l.origem] || 0) > (peso[atual.origem] || 0)) porCampanha.set(l.campaignId, l);
  }
  const preco = Number(produto?.price);
  const cupons = [...porCampanha.values()].map(c => {
    const d = Number.isFinite(preco) && preco > 0 ? detalheDoCupom(preco, c) : null;
    return {
      campaignId: c.campaignId, title: c.title, code: c.code || null,
      kind: c.kind, value: c.value, minPurchase: c.minPurchase, maxDiscount: c.maxDiscount,
      expiresAt: c.expiresAt, scope: c.scope, sellerName: c.sellerName,
      origem: c.origem, origemRotulo: ORIGEM_ROTULO[c.origem] || c.origem,
      // Nulos quando o cupom não vale NESTE preço (compra mínima, teto) ou não há preço.
      priceWithCoupon: d ? d.final : null,
      economia: d ? d.economia : null,
      rotulo: d ? d.rotulo : null,
    };
  }).sort((a, b) => (b.economia || 0) - (a.economia || 0));
  return {
    produto: produto ? { key: produto.key, name: produto.name, price: produto.price, img: produto.img, link: produto.link } : null,
    cupons,
    // "Nenhum cupom" aqui NÃO quer dizer "nenhum cupom vale": quer dizer que nenhuma
    // vitrine lida até agora trouxe este produto. A tela diz isso com todas as letras.
    semVinculo: cupons.length === 0,
  };
}

async function paraProduto({ url = null, key = null } = {}) {
  const chaves = key ? [String(key)] : chavesCandidatas(url);
  if (!chaves.length) throw new Error("Não reconheci esse link como um produto.");

  const produto = await prisma().catalogProduct.findFirst({ where: { key: { in: chaves } } });
  const linhas = await prisma().$queryRaw`
    SELECT p."campaign_id" AS "campaignId", p."origem", c."title", c."code", c."kind", c."value",
           c."minPurchase", c."maxDiscount", c."startsAt", c."expiresAt", c."scope", c."sellerName"
      FROM "ml_coupon_products" p
      JOIN "ml_coupons" c ON c."campaign_id" = p."campaign_id"
     WHERE p."productKey" = ANY(${chaves})
       AND (c."expiresAt" IS NULL OR c."expiresAt" > NOW())`;
  return { ...montarResposta(linhas, produto), chaves };
}

// A sonda: guarda em disco o que a extensão fotografou, para alguém olhar. Devolve
// um resumo curto — a tela mostra onde ficou e se a caminhada chegou na tela dos cupons.
// A linha do resumo do checkout de página única (sonda de 19/09/2026): o ML já chega
// com o melhor cupom ativo aplicado — "Cupons (1/1 em uso)" seguido do desconto.
// Pura. Devolve { emUso, disponiveis, desconto } ou null quando a linha não está lá.
function cupomNoResumo(texto) {
  const t = String(texto || "").replace(/\s+/g, " ");
  const m = t.match(/Cupons?\s*\(\s*(\d+)\s*\/\s*(\d+)\s*em uso\s*\)\s*-?\s*(?:R\$\s*([\d.]+)\s*,\s*(\d{2}))?/i);
  if (!m) return null;
  const desconto = m[3] ? Number(`${m[3].replace(/\./g, "")}.${m[4]}`) : null;
  return { emUso: Number(m[1]), disponiveis: Number(m[2]), desconto };
}

// O motivo por que a caminhada parou, na última pegada da trilha.
const PAROU = {
  "sem-botao-continuar": "não achou a linha do cupom nem um “Continuar” (checkout de página única?)",
  "cupom-nao-abriu": "clicou na linha do cupom e o popup não abriu",
  "opcao-nao-marcada": "não conseguiu marcar a opção de entrega/pagamento",
  "tela-nao-mudou": "clicou em Continuar e a tela não mudou",
  "checkout-quebrou": "o checkout do ML deu erro duas vezes",
};

function resumoDaSonda(material) {
  const m = material || {};
  const ck = m.checkout || {};
  const parou = (ck.trail || []).at(-1)?.parou || null;
  return {
    chegouNoCheckout: !!ck.reached,
    chegouNosCupons: !!m.capturaDosCupons,
    abriuPopup: !!m.capturaDosCupons?.popupAberto,
    // O popup é um iframe; se ele não era legível (ou não tinha carregado), a
    // captura tem só a casca.
    leuIframe: (m.capturaDosCupons?.iframes || []).some(f => f.legivel && (f.texto || "").trim().length > 20),
    // A oferta de seguro no caminho: `como` é "recusou" | "callback" | null (não saiu
    // dela). Sem sair, os rótulos que a tela tinha explicam por quê.
    seguro: m.checkout?.seguro ? {
      como: m.checkout.seguro.como || null,
      clicou: m.checkout.seguro.clicou || null,
      voltouProSeguro: !!m.checkout.seguro.voltouProSeguro,
      rotulos: m.checkout.seguro.como ? null : (m.checkout.seguro.rotulos || []),
    } : null,
    // A busca direta de `/cupons/cho` — o caminho que não depende do popup abrir.
    leuPaginaDosCupons: !!(m.paginaDosCupons?.ok && String(m.paginaDosCupons.html || "").length > 500),
    viuAtivos: !!m.capturaDosAtivos,
    // O que já dá pra ler sem parser nenhum: o cupom que o ML aplicou sozinho.
    // Onde parou, quando não chegou no checkout — a página inteira vai em parada.html.
    paradaEm: m.checkout?.reached ? null : (m.capturaNaParada?.url || m.checkout?.url || null),
    cupomAplicado: cupomNoResumo(m.capturaAoEntrar?.texto || m.bodyTextAoEntrar),
    passos: ck.steps || 0,
    muro: m.muro || null,
    motivo: m.motivo || ck.blockedReason || (m.notProductPage ? "o link não abriu uma página de produto" : null)
      // Parar antes do popup deixou de ser um problema quando a página dos cupons veio.
      || (!m.capturaDosCupons && !m.paginaDosCupons?.ok && parou ? (PAROU[parou] || parou) : null),
    cuponsNaPaginaDoProduto: (m.clippedTexts || []).length,
    respostasDeApi: (m.capturaDosAtivos?.respostas || m.capturaDosCupons?.respostas || []).length,
    carrinhoLimpo: ck.via === "carrinho" ? !!ck.cartCleaned : null,
  };
}

// O checkout mostra CPF, endereço e final de cartão. Nada disso interessa à sonda,
// e o arquivo fica em disco — sai mascarado.
function mascarar(texto) {
  return String(texto ?? "")
    .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, "***.***.***-**")
    .replace(/(terminad[oa] em|\*{4})(\s|&nbsp;)*\d{4}/gi, "$1 ****")
    .replace(/CEP\s*\d{5}-?\d{3}/gi, "CEP *****-***")
    // O mesmo dado dentro do JSON que o checkout embute no HTML.
    .replace(/("(?:last_four_digits|first_six_digits|cp|zip_code|zipcode|postal_code|doc_number|identification_number|cpf)"\s*:\s*")[^"]*"/gi, '$1***"');
}

async function gravarSonda({ url, material, dir = SONDA_DIR } = {}) {
  if (!material || typeof material !== "object") throw new Error("A extensão não mandou nada.");
  const pasta = path.join(dir, new Date().toISOString().replace(/[:.]/g, "-"));
  await fs.promises.mkdir(pasta, { recursive: true });

  const escreve = (nome, conteudo) => fs.promises.writeFile(path.join(pasta, nome), mascarar(conteudo));
  const { capturaDosCupons, capturaAoEntrar, capturaDosAtivos, capturaNaParada, paginaDosCupons, ...resto } = material;
  resto.paginaDosCupons = paginaDosCupons ? { ...paginaDosCupons, html: undefined } : null;
  const resumo = resumoDaSonda(material);

  await escreve("resumo.json", JSON.stringify({ url, quando: new Date().toISOString(), ...resumo }, null, 2));
  await escreve("material.json", JSON.stringify(resto, null, 2));
  // `parada`: a página onde a caminhada parou antes do checkout (seguro, aviso novo…).
  for (const [nome, cap] of [["parada", capturaNaParada], ["ao-entrar", capturaAoEntrar], ["cupons", capturaDosCupons], ["ativos", capturaDosAtivos]]) {
    if (!cap) continue;
    if (cap.html) await escreve(`${nome}.html`, String(cap.html));
    await escreve(`${nome}.txt`, String(cap.texto || ""));
    if (cap.textoDoPopup) await escreve(`${nome}-popup.txt`, String(cap.textoDoPopup));
    // O conteúdo de verdade do popup de cupons: o iframe `/cupons/cho`.
    for (const [i, f] of (cap.iframes || []).entries()) {
      await escreve(`${nome}-iframe-${i}.txt`, `${f.src || ""}\n\n${f.texto || ""}`);
      if (f.html) await escreve(`${nome}-iframe-${i}.html`, String(f.html));
    }
    await escreve(`${nome}-respostas.json`, JSON.stringify(cap.respostas || [], null, 2));
  }
  if (paginaDosCupons?.html) await escreve("pagina-cupons.html", String(paginaDosCupons.html));
  // O que o checkout disse, lido do HTML do iframe do popup. A lista dos ativos
  // (se a sonda chegou a abrir) tem o mesmo formato e vem primeiro.
  const final = { ...resumo, checkout: await lerEVincular({ url, material }) };
  await escreve("leitura.json", JSON.stringify(final.checkout, null, 2));
  return { pasta, resumo: final };
}

// O que a sonda serve de verdade: ler a lista do checkout e gravar como vínculo
// `checkout` os cupons que valem. Compartilhado pela sonda manual (acima) e pelo
// lote (coupons/checkout-lote.js). `productKeys` extra: a chave da linha do
// catálogo, quando quem chama já a conhece.
async function lerEVincular({ url, material, productKeys = [] }) {
  const leitura = lerCuponsDaSonda(material);
  const valem = leitura.ok ? cuponsQueValem(leitura.cupons) : [];
  let gravado = null;
  if (valem.length && url) {
    const chaves = [...new Set([...productKeys, ...chavesCandidatas(url)].filter(Boolean))];
    gravado = await require("./pg").vincularPorCheckout({ productKeys: chaves, productUrl: url, cupons: valem });
  }
  return { ...leitura, valem: valem.map(c => c.campaignId), gravado };
}

// O HTML de `/cupons/cho` que a sonda trouxe. Três fontes, e todas são a MESMA
// página: a lista dos ativos (se o popup chegou a abrir nela), o iframe do popup e a
// busca direta que a extensão faz sem clicar em nada. A última é a que sempre
// responde — o clique só monta o popup quando já existe cupom em uso.
function lerCuponsDaSonda(material) {
  for (const cap of [material?.capturaDosAtivos, material?.capturaDosCupons]) {
    for (const f of cap?.iframes || []) {
      if (!f?.html) continue;
      const r = parseCheckoutCupons(f.html);
      if (r.ok) return r;
    }
  }
  if (material?.paginaDosCupons?.html) {
    const r = parseCheckoutCupons(material.paginaDosCupons.html);
    if (r.ok) return r;
  }
  return { ok: false, motivo: "A sonda não trouxe o HTML da página de cupons do checkout.", economia: null, cupons: [] };
}

module.exports = { paraProduto, montarResposta, gravarSonda, lerEVincular, lerCuponsDaSonda, resumoDaSonda, cupomNoResumo, mascarar, ORIGEM_ROTULO, SONDA_DIR };
