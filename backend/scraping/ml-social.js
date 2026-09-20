// Landing de afiliado do Mercado Livre (mercadolivre.com.br/social/...) lida por
// HTTP simples, SEM navegador.
//
// Por que isto existe: em 25/08/2026 o repasse do ML parou por completo — 10 de
// 10 links descartados por CAPTCHA. O diagnóstico na VPS mostrou que o IP do
// servidor NÃO está bloqueado: um fetch cru da mesma landing (só com um
// User-Agent de browser, sem cookie) responde 200 com o produto inteiro, enquanto
// o Chrome headless com o cookie de afiliado injetado leva CAPTCHA em ~6 s,
// sempre. O que o ML bloqueia é o navegador automatizado, não a máquina.
//
// A landing traz os dados num JSON embutido no HTML, no MESMO formato "polycard"
// que o Hub de Afiliados serve por XHR — então o parser continua sendo o
// `polycardToProduct` do ml-hub.js, sem alteração nenhuma.
//
// CUIDADO CENTRAL: a página tem DOIS blocos de polycards — o `card-featured` do
// topo, que é o produto compartilhado, e um carrossel "Quem viu este produto
// também comprou" com OUTROS produtos. Repassar o produto errado para o grupo de
// um cliente é pior do que não repassar nada, então aqui só o `card-featured`
// conta, e qualquer ambiguidade vira recusa.
const urlGuard = require("./urlGuard");

const FETCH_TIMEOUT_MS = 10000;
const MAX_HTML_BYTES = 3 * 1024 * 1024;   // landing real tem ~350 KB

// O HTML embute o estado da página como JS: `_n.ctx.r={...};_n.ctx.l={...}`.
// O `_n.ctx.l` usa `new Set([...])`, que não é JSON — por isso a leitura recorta
// só o objeto do `_n.ctx.r`, contando chaves, em vez de pegar o script inteiro.
const STATE_MARKER = "_n.ctx.r=";

// Recorta o primeiro objeto `{...}` balanceado depois do marcador, ignorando
// chaves dentro de string. Devolve o texto JSON, ou null.
function sliceBalancedJson(text, marker) {
  const at = text.indexOf(marker);
  if (at < 0) return null;
  const start = text.indexOf("{", at + marker.length);
  if (start < 0) return null;

  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;   // objeto não fechou (HTML truncado)
}

// O bloco do produto compartilhado. Fica no primeiro nível de `data.components`,
// com id "card-featured"; o carrossel de recomendações mora ANINHADO dentro de
// `tabs`, e é justamente por isso que a busca aqui NÃO é recursiva.
function featuredBlock(state) {
  const components = state?.appProps?.pageProps?.data?.components;
  if (!Array.isArray(components)) return null;
  const featured = components.find(c => c?.id === "card-featured");
  return featured?.recommendation_data?.recommendation_info || null;
}

// Muro do ML no HTML cru. Só é consultado DEPOIS de a extração do produto
// falhar — assim uma palavra solta na página (um produto chamado "captcha") não
// transforma uma leitura boa em bloqueio falso.
function wallKind(html, url) {
  const hay = `${url}\n${html}`;
  if (/\/captcha\/wall/i.test(url) || /seguridad|captcha|n[ãa]o sou um rob[ôo]|no soy un robot/i.test(html)) return "captcha";
  if (/\/gz\/account-verification/i.test(url) || /acesse sua conta|para continuar, acesse|informe seu e-mail ou telefone/i.test(hay)) return "login";
  return null;
}

// Os cabeçalhos de uma navegação de verdade — não só o User-Agent.
//
// Medido em 26/08/2026: em `lista.mercadolivre.com.br` (a vitrine do cupom), o
// fetch com só UA + Accept-Language é redirecionado para
// `/gz/account-verification`, enquanto o MESMO fetch com o jogo completo abaixo
// responde 200. A landing `/social/` abre dos dois jeitos, então isso nunca tinha
// aparecido — e é por isso que mora aqui, num lugar só: quem escrever o próximo
// leitor sem navegador não vai adivinhar quais desses seis cabeçalhos importam.
//
// Não é disfarce novo: é mandar o que o navegador manda numa navegação comum.
function browserHeaders() {
  const { UA } = require("./scraper");   // lazy: scraper requer este módulo
  return {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8",
    "sec-ch-ua": '"Chromium";v="124", "Not.A/Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "none",
    "sec-fetch-user": "?1",
    "upgrade-insecure-requests": "1",
  };
}

// É landing de PRODUTO de afiliado? (`/social/<id>` e variações com query)
function isSocialLandingUrl(url) {
  try { return /^\/social\//i.test(new URL(url).pathname); } catch { return false; }
}

// Encurtadores que o ML usa nos links de compartilhamento do afiliado. Quase
// sempre desembocam numa landing /social/, e a resolução acontece no próprio
// safeFetchFollow — por isso vale tentar o caminho sem navegador já neles.
const ML_SHORTENERS = ["meli.la", "merc.li", "mlb.li"];

// Vale tentar ler sem navegador? (landing /social/ ou encurtador do ML)
function isAffiliateShareUrl(url) {
  if (isSocialLandingUrl(url)) return true;
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
    return ML_SHORTENERS.some(d => host === d || host.endsWith(`.${d}`));
  } catch { return false; }
}

// É o PERFIL/LISTA do afiliado (`/social/<id>/lists`), que não é produto nenhum.
// Barrar isso cedo evita abrir um Chrome inteiro à toa.
function isAffiliateProfileUrl(url) {
  try { return /^\/social\/[^/]+\/lists?(\/|$)/i.test(new URL(url).pathname); } catch { return false; }
}

// Lê a landing a partir do HTML. Pura → testável sem rede e sem navegador.
// Devolve { ok, kind, reason, product }, com kind ∈ ok | captcha | login |
// nao-e-produto — mesmo espírito do classifyHubResult (ml-hub.js).
function parseSocialLanding(html, url = "") {
  const source = typeof html === "string" ? html : "";
  // lazy: ml-hub → scraper → ml-social fecharia ciclo de require no boot.
  const { polycardToProduct } = require("./ml-hub");

  const fail = (kind, reason) => ({ ok: false, kind, reason, product: null });

  let info = null;
  const raw = sliceBalancedJson(source, STATE_MARKER);
  if (raw) {
    try { info = featuredBlock(JSON.parse(raw)); } catch { info = null; }
  }

  if (!info) {
    const wall = wallKind(source, url);
    if (wall === "captcha") return fail("captcha", "Mercado Livre pediu verificação (CAPTCHA) — bloqueio passageiro, tente daqui a alguns minutos.");
    if (wall === "login") return fail("login", "Mercado Livre pediu login — verifique o cookie de afiliado nas Configurações.");
    return fail("nao-e-produto", "A landing de afiliado não trouxe o produto em destaque (pode ser perfil, lista ou link vencido).");
  }

  const cards = Array.isArray(info.polycards) ? info.polycards : [];
  // Um produto e um só. Zero é landing sem destaque; mais de um é ambiguidade —
  // e chutar qual deles é o certo mandaria o produto errado pro grupo do cliente.
  if (cards.length !== 1) {
    return fail("nao-e-produto", cards.length
      ? `A landing trouxe ${cards.length} produtos em destaque — sem saber qual é o compartilhado, é melhor não repassar.`
      : "A landing de afiliado não trouxe nenhum produto em destaque (link vencido ou perfil sem produto).");
  }

  const p = polycardToProduct(cards[0], info.polycard_context || {});
  if (!p || !p.name || p.price == null) {
    return fail("nao-e-produto", "O produto em destaque da landing veio sem nome ou sem preço.");
  }

  // Mesmo formato de scrapeSingleProduct (scraper.js) — o `link` é o permalink
  // canônico do ML (/p/MLB… ou /up/MLBU…), que é o que a API de afiliado aceita;
  // a URL da landing é de OUTRO afiliado e não serve pra reafiliar no envio.
  return {
    ok: true,
    kind: "ok",
    reason: `Produto lido da landing de afiliado sem navegador (${p.mlItemId || "sem id"}).`,
    product: {
      name: p.name,
      link: p.link,
      finalUrl: p.link,
      price: p.price,
      originalPrice: p.originalPrice,
      discount: p.discount,
      hasPromo: p.originalPrice != null || p.discount != null,
      sold: p.sold,
      rating: p.rating,
      reviewsCount: p.reviewsCount,
      img: p.img,
      store: "Mercado Livre",
      // O número do anúncio que o card diz ser. Quem pediu o produto por MLB
      // (coupons/enrich-samples.js) confere com ele que a landing não trouxe outro.
      mlItemId: p.mlItemId || null,
      scrapedAt: new Date().toISOString(),
    },
  };
}

// Erros do urlGuard que repetir não conserta: o link em si é inválido ou
// aponta pra onde não pode. Qualquer outra falha (DNS que não resolveu,
// timeout, conexão caída) é soluço de rede e merece uma segunda chance —
// em 25/08/2026 um `dns.lookup` que falhou por um instante derrubou um
// repasse inteiro, porque o plano B (navegador) está bloqueado por CAPTCHA.
const PERMANENT_FETCH_ERRORS = [
  "URL inválida",
  "URL aponta para um endereço interno",
  "Só aceito links http ou https",
  "Link não reconhecido",
  "Link com redirecionamentos demais",
];

function isTransientFetchError(err) {
  const msg = String(err?.message || "");
  if (!msg) return false;
  return !PERMANENT_FETCH_ERRORS.some((frag) => msg.includes(frag));
}

// Busca a landing e lê. `safeFetchFollow` é o único caminho de fetch do projeto
// que revalida CADA redirect contra o urlGuard — o link vem de mensagem de
// WhatsApp, e encurtador pode apontar pra qualquer lugar.
async function fetchSocialLanding(url, { timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const { res, finalUrl } = await urlGuard.safeFetchFollow(url, {
      headers: browserHeaders(),
      signal: controller.signal,
    });
    if (!res.ok) {
      try { await res.body?.cancel?.(); } catch { /* ignore */ }
      return { ok: false, kind: "nao-e-produto", reason: `A landing respondeu ${res.status}.`, product: null };
    }
    const html = (await res.text()).slice(0, MAX_HTML_BYTES);
    return parseSocialLanding(html, finalUrl);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  browserHeaders,
  parseSocialLanding,
  fetchSocialLanding,
  isTransientFetchError,
  isSocialLandingUrl,
  isAffiliateShareUrl,
  isAffiliateProfileUrl,
  sliceBalancedJson,
};
