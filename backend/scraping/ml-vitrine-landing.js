// A vitrine de um cupom lida SEM NAVEGADOR, pela landing de afiliado.
//
// O problema: a vitrine do cupom mora em `lista.mercadolivre.com.br/_Container_…`
// e essa página está atrás do muro anti-bot do ML — o Chrome leva CAPTCHA e o
// fetch direto leva um desafio de JavaScript (ver o mapa no README). Sem ela,
// `ml_coupon_products` fica vazia e o teste de cupom responde "não sei".
//
// A saída é a mesma que destravou o repasse em 25/08/2026 (scraping/ml-social.js):
// não abrir navegador. Só que aqui o caminho tem um passo a mais — a URL da
// vitrine passa pela API de link curto do PRÓPRIO ML (com a conta do sistema), e o
// que volta é uma landing `/social/<tag>` que o ML entrega a um fetch cru, com os
// produtos num JSON embutido no formato "polycard".
//
// O QUE ESTE CAMINHO NÃO É (sonda de 26/08, três cupons): ele NÃO traz a vitrine
// inteira. O ML monta uma PRÉVIA — 3, 5 e 8 produtos nos três testes, com o
// `totalElements` batendo — e o "Mostrar mais" devolve pra página murada. Então o
// que sai daqui é prova POSITIVA de cobertura ("este produto está no cupom"),
// nunca a lista fechada. Desde a task 22 os fluxos de cupom não usam mais este
// caminho; ele fica para a sonda scripts/cupom-produtos-visual.js.
//
// A ARMADILHA CENTRAL, e é cara: a landing tem QUATRO blocos, e três deles são
// recomendação para o perfil do afiliado ("Para você", "Mais vendidos",
// "Ofertas") — 41 dos 46 MLBs da página. Esses produtos não têm nada a ver com o
// cupom. Só o `carousel-featured` é a vitrine, e ele se identifica sozinho: o
// `seeMoreLink` dele aponta de volta para a URL que foi pedida. Sem essa
// conferência, o sistema carimbaria "cobre este produto" em item aleatório e a
// fila do repasse anunciaria desconto que não existe.
const urlGuard = require("./urlGuard");
const mlSocial = require("./ml-social");

const FETCH_TIMEOUT_MS = 15000;
const MAX_HTML_BYTES = 3 * 1024 * 1024;   // a landing real tem ~350 KB

// O id da campanha é o que identifica a vitrine de um jeito estável: o ML devolve
// o `seeMoreLink` com o mesmo `coupon_campaign_id`, mas pode mexer em fragmento e
// em parâmetro de rastreio. Sem o id (vitrine de loja, por exemplo), sobra
// comparar o caminho — que é onde mora o `_Container_<slug>`.
function assinaturaDaVitrine(url) {
  try {
    const u = new URL(String(url));
    const id = u.searchParams.get("coupon_campaign_id");
    return id ? `campanha:${id}` : `caminho:${u.hostname}${u.pathname}`;
  } catch { return null; }
}

// O bloco da vitrine dentro do modelo da landing.
//
// A busca NÃO é recursiva, pelo mesmo motivo do ml-social.js: os carrosséis de
// recomendação moram aninhados em `tabs`, e uma varredura profunda acharia eles
// junto. Aqui só o primeiro nível de `components` conta.
function blocoDaVitrine(estado) {
  const componentes = estado?.appProps?.pageProps?.data?.components;
  if (!Array.isArray(componentes)) return null;
  const bloco = componentes.find(c => c?.id === "carousel-featured");
  return bloco?.recommendation_data?.recommendation_info || null;
}

// Muro do ML no HTML cru. Como no ml-social, só é consultado DEPOIS de a extração
// falhar — senão um produto chamado "captcha" viraria bloqueio falso.
function classificaMuro(html, url) {
  const hay = `${url}\n${html}`;
  if (/\/captcha\/wall/i.test(url) || /n[ãa]o sou um rob[ôo]|no soy un robot/i.test(html)) return "captcha";
  if (/\/gz\/account-verification/i.test(url)) return "verificacao";
  if (/micro-landing-container|security\/bot_challenge/i.test(hay)) return "desafio";
  if (/\/gz\/login/i.test(url) || /acesse sua conta/i.test(hay)) return "login";
  return null;
}

// Lê a landing a partir do HTML. Pura → testável sem rede e sem navegador.
// Devolve { ok, kind, reason, products, total }, com kind ∈
// ok | captcha | verificacao | desafio | login | outra-vitrine | sem-produtos.
function parseVitrineLanding(html, containerUrl, finalUrl = "") {
  const fonte = typeof html === "string" ? html : "";
  const { polycardToProduct } = require("./ml-hub");
  const falha = (kind, reason) => ({ ok: false, kind, reason, products: [], total: null });

  let estado = null;
  const cru = mlSocial.sliceBalancedJson(fonte, "_n.ctx.r=");
  if (cru) {
    try { estado = JSON.parse(cru); } catch { estado = null; }
  }

  const info = estado ? blocoDaVitrine(estado) : null;
  if (!info) {
    const muro = classificaMuro(fonte, finalUrl);
    if (muro === "captcha") return falha("captcha", "O Mercado Livre pediu verificação (CAPTCHA) na landing da vitrine.");
    if (muro === "verificacao") return falha("verificacao", "O Mercado Livre mandou a conta do sistema para a verificação de conta.");
    if (muro === "desafio") return falha("desafio", "O Mercado Livre serviu o desafio de JavaScript — essa página não abre sem navegador.");
    if (muro === "login") return falha("login", "O Mercado Livre pediu login — o cookie da conta do sistema venceu.");
    return falha("sem-produtos", "A landing abriu, mas sem o carrossel da vitrine (o link pode ter caído no perfil do afiliado).");
  }

  // A conferência que impede repassar produto de outro lugar como se fosse do
  // cupom. Se o ML mudar o `seeMoreLink`, o certo é PARAR — não adivinhar.
  const pedida = assinaturaDaVitrine(containerUrl);
  const veio = assinaturaDaVitrine(info.seeMoreLink);
  if (!veio || !pedida || veio !== pedida) {
    return falha("outra-vitrine",
      `O carrossel da landing aponta para outra listagem (${info.seeMoreLink || "sem link"}) — não dá pra dizer que são os produtos deste cupom.`);
  }

  const cards = Array.isArray(info.polycards) ? info.polycards : [];
  const contexto = info.polycard_context || {};
  const produtos = [];
  const vistos = new Set();
  for (const card of cards) {
    const p = polycardToProduct(card, contexto);
    if (!p || !p.name || p.price == null || !p.link || vistos.has(p.link)) continue;
    vistos.add(p.link);
    // `hub` é do Hub de Afiliados e vira campo do payload do catálogo — estes
    // produtos não vieram de lá, e carimbar isso mentiria na origem.
    delete p.hub;
    delete p.commission;
    delete p.extraCommission;
    produtos.push(p);
  }

  if (!produtos.length) {
    return falha("sem-produtos", "O carrossel da vitrine veio vazio (a campanha pode ter acabado).");
  }

  return {
    ok: true,
    kind: "ok",
    reason: `${produtos.length} produto(s) da vitrine lidos sem navegador (prévia do ML${
      Number.isFinite(info.totalElements) ? `, de ${info.totalElements}` : ""}).`,
    products: produtos,
    // Quantos o ML disse que a prévia tem. NÃO é o tamanho da vitrine.
    total: Number.isFinite(info.totalElements) ? info.totalElements : null,
  };
}

// O caminho inteiro: gera o link curto com a conta do sistema e lê a landing.
//
// Nenhum passo abre navegador, e falhar aqui nunca é motivo pra derrubar a rodada:
// quem chama trata como "essa vitrine não veio" e segue pro próximo cupom.
async function fetchVitrineLanding(containerUrl, { timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  if (!containerUrl) {
    return { ok: false, kind: "sem-url", reason: "Esse cupom não tem URL de vitrine.", products: [], total: null };
  }

  const affiliate = require("./affiliate");
  const link = await affiliate.criarLinkAfiliadoMLSistema(containerUrl);
  if (!link.shortUrl) {
    return { ok: false, kind: link.kind || "sem-link", reason: link.reason, products: [], total: null };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // `safeFetchFollow` revalida CADA redirect: o encurtador do ML pode, em tese,
    // apontar pra qualquer lugar, e é a mesma disciplina do ml-social.js.
    const { res, finalUrl } = await urlGuard.safeFetchFollow(link.shortUrl, {
      headers: mlSocial.browserHeaders(),
      signal: controller.signal,
    });
    if (!res.ok) {
      try { await res.body?.cancel?.(); } catch { /* ignore */ }
      return { ok: false, kind: "http", reason: `A landing da vitrine respondeu ${res.status}.`, products: [], total: null };
    }
    const html = (await res.text()).slice(0, MAX_HTML_BYTES);
    return { ...parseVitrineLanding(html, containerUrl, finalUrl), shortUrl: link.shortUrl, finalUrl };
  } catch (err) {
    return { ok: false, kind: "erro", reason: `Não deu pra ler a landing da vitrine: ${err.message}`, products: [], total: null };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  parseVitrineLanding,
  fetchVitrineLanding,
  assinaturaDaVitrine,
  blocoDaVitrine,
};
