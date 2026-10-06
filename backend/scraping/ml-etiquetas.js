// Etiquetas de afiliado do Mercado Livre de um usuário. O usuário cola só o
// cookie na aba dele; daqui sai a lista de etiquetas da conta, que cada campanha
// usa pra escolher com qual etiqueta os links saem (`scraping.mlTag`).
//
// É a chamada que a própria página "Administrador de etiquetas" do ML
// (/afiliados/adminlabel) faz, lida no bundle dela em 01/10/2026:
//   GET  /affiliate-program/api/v2/affiliates/getTags
//        → [{ tag, in_use, generated_date }]
// O getTags aceita um fetch cru só com o cookie, igual ao createLink (testado na
// mesma data); cookie vencido responde 302 pro login. Por isso ele é também o
// teste do cookie: salvar o cookie passa por aqui, e cookie que não lista não
// é gravado.
//
// A etiqueta PADRÃO (a da campanha que não escolheu nenhuma) é a "em uso" no ML.
//
// O cookie é o que o usuário colou na aba dele (affiliate_config.ml). Nunca o da
// conta do sistema.
const affiliate = require("./affiliate");
const { UA } = require("./scraper");
const { AppError } = require("../infra/httpErrors");

const BASE = "https://www.mercadolivre.com.br/affiliate-program/api/v2/affiliates";
const REFERER = "https://www.mercadolivre.com.br/afiliados/adminlabel";
const TIMEOUT_MS = 20000;

const KIND = affiliate.ML_LINK_KIND;

// Resposta do getTags → [{ tag, inUse, createdAt }], na ordem do ML. Aceita a
// lista solta ou dentro de `data`, e ignora item sem etiqueta.
function normalizaListaEtiquetas(json) {
  const lista = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : [];
  return lista
    .filter(it => it && typeof it.tag === "string" && it.tag.trim())
    .map(it => ({
      tag: it.tag.trim(),
      inUse: it.in_use === true,
      createdAt: it.generated_date ? String(it.generated_date) : null,
    }));
}

const COOKIE_VENCIDO = "O Mercado Livre não aceitou este cookie (sessão vencida) — copie um novo pela extensão e cole nesta aba.";

async function chamaML(caminho, cookie) {
  let res;
  try {
    res = await fetch(`${BASE}/${caminho}`, {
      headers: {
        "Cookie": cookie,
        "User-Agent": UA,
        "Accept": "application/json, text/plain, */*",
        "Referer": REFERER,
      },
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new AppError(`O Mercado Livre não respondeu (${err.name === "TimeoutError" ? "tempo esgotado" : err.message}).`, { status: 502, code: KIND.ERRO });
  }
  const location = res.headers.get("location") || "";
  // 401/403 é sessão, como no createLink; 302 pro login, idem.
  const loginWall = res.status === 401 || res.status === 403
    || (res.status >= 300 && res.status < 400 && /login/i.test(location));
  if (loginWall) throw new AppError(COOKIE_VENCIDO, { status: 409, code: KIND.COOKIE });
  if (!res.ok) {
    throw new AppError(`O Mercado Livre recusou listar as etiquetas (HTTP ${res.status}).`, { status: 502, code: KIND.ERRO });
  }
  return res.json().catch(() => null);
}

// A padrão: a "em uso" no ML, ou a primeira se nenhuma vier marcada. Pura.
function escolhePadrao(tags) {
  return (tags.find(t => t.inUse) || tags[0])?.tag || null;
}

// Busca as etiquetas da conta e grava junto com o cookie. `cookie` novo = o que
// o usuário acabou de colar (só é gravado se o ML listar com ele); sem `cookie`
// = rebusca com o salvo. Qualquer erro antes do fim deixa a config como estava.
async function sincronizarEtiquetas(userId, { cookie = undefined } = {}) {
  const atual = affiliate.readMLConfig(userId);
  // writeMLConfig recusa config vinda de env — melhor saber antes de chamar o ML.
  if (atual.source === "env") {
    throw new AppError("A configuração do Mercado Livre vem de variável de ambiente — troque por lá.", { status: 409 });
  }
  const novo = typeof cookie === "string" ? cookie.trim() : "";
  const usado = novo || atual.cookie;
  if (!usado) {
    throw new AppError("Cole o cookie de afiliado do Mercado Livre nesta aba primeiro.", { status: 409, code: KIND.SEM_CONFIG });
  }

  const json = await chamaML("getTags", usado);
  if (!Array.isArray(json) && !Array.isArray(json?.data)) {
    throw new AppError("O Mercado Livre devolveu uma lista de etiquetas em formato inesperado.", { status: 502, code: KIND.ERRO });
  }
  const tags = normalizaListaEtiquetas(json);
  if (!tags.length) {
    throw new AppError("Esta conta do Mercado Livre não tem etiquetas — crie uma no Administrador de etiquetas do ML.", { status: 409 });
  }

  affiliate.writeMLConfig(userId, {
    ...(novo ? { cookie: novo } : {}),
    tag: escolhePadrao(tags),
    tags,
    tagsFetchedAt: new Date().toISOString(),
  });
  return { tags, current: escolhePadrao(tags) };
}

module.exports = {
  sincronizarEtiquetas,
  // puras, exportadas pros testes
  normalizaListaEtiquetas,
  escolhePadrao,
};
