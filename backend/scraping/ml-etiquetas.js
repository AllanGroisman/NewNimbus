// Etiquetas de afiliado do Mercado Livre de um usuário: listar as da conta e
// trocar a "em uso". Só o admin usa (Configurações › Mercado Livre).
//
// São as chamadas que a própria página "Administrador de etiquetas" do ML
// (/afiliados/adminlabel) faz, lidas no bundle dela em 01/10/2026:
//   GET  /affiliate-program/api/v2/affiliates/getTags
//        → [{ tag, in_use, generated_date }]
//   PUT  /affiliate-program/api/v2/affiliates/setTagInUse  { tag }
// O getTags aceita um fetch cru só com o cookie, igual ao createLink (testado na
// mesma data); cookie vencido responde 302 pro login.
//
// Trocar mexe nos DOIS lados: primeiro a "em uso" da conta no ML (vale também
// para o link gerado no app e na barra do ML), depois a TAG salva aqui, que é a
// que vai no corpo de todo createLink. Se o ML recusar, nada muda aqui.
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

// Resposta do getTags (e do setTagInUse, que devolve a lista já trocada) →
// [{ tag, inUse, createdAt }], na ordem do ML. Aceita a lista solta ou dentro
// de `data`, e ignora item sem etiqueta.
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

const COOKIE_VENCIDO = "O cookie do Mercado Livre venceu — cole um novo nesta aba.";

async function chamaML(caminho, cookie, { method = "GET", body = undefined } = {}) {
  let res;
  try {
    res = await fetch(`${BASE}/${caminho}`, {
      method,
      headers: {
        "Cookie": cookie,
        "User-Agent": UA,
        "Accept": "application/json, text/plain, */*",
        "Referer": REFERER,
        ...(body ? { "Content-Type": "application/json", "Origin": "https://www.mercadolivre.com.br" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new AppError(`O Mercado Livre não respondeu (${err.name === "TimeoutError" ? "tempo esgotado" : err.message}).`, { status: 502, code: KIND.ERRO });
  }
  const location = res.headers.get("location") || "";
  // Na leitura, 403 também é sessão (como no createLink). Na troca, um 403 pode
  // ser o ML pedindo CSRF — aí o texto mostra o status em vez de culpar o cookie.
  const loginWall = res.status === 401
    || (method === "GET" && res.status === 403)
    || (res.status >= 300 && res.status < 400 && /login/i.test(location));
  if (loginWall) throw new AppError(COOKIE_VENCIDO, { status: 409, code: KIND.COOKIE });
  if (!res.ok) {
    const acao = method === "GET" ? "listar as etiquetas" : "trocar a etiqueta";
    throw new AppError(`O Mercado Livre recusou ${acao} (HTTP ${res.status}).`, { status: 502, code: KIND.ERRO });
  }
  return res.json().catch(() => null);
}

function cookieDoUsuario(userId) {
  const { cookie, source } = affiliate.readMLConfig(userId);
  if (!cookie) {
    throw new AppError("Cole o cookie de afiliado do Mercado Livre nesta aba primeiro.", { status: 409, code: KIND.SEM_CONFIG });
  }
  return { cookie, source };
}

// { tags, current } — `current` é a TAG salva aqui, que pode não estar na lista
// (digitada errada, ou de outra conta). A tela avisa quando isso acontece.
async function listarEtiquetas(userId) {
  const { cookie } = cookieDoUsuario(userId);
  const json = await chamaML("getTags", cookie);
  if (!Array.isArray(json) && !Array.isArray(json?.data)) {
    throw new AppError("O Mercado Livre devolveu uma lista de etiquetas em formato inesperado.", { status: 502, code: KIND.ERRO });
  }
  return { tags: normalizaListaEtiquetas(json), current: affiliate.readMLConfig(userId).tag || null };
}

async function trocarEtiqueta(userId, tag) {
  const nova = typeof tag === "string" ? tag.trim() : "";
  if (!nova) throw new AppError("Escolha uma etiqueta.", { status: 400 });

  const { cookie, source } = cookieDoUsuario(userId);
  // writeMLConfig recusa config vinda de env — melhor saber antes de mexer no ML.
  if (source === "env") {
    throw new AppError("A configuração do Mercado Livre vem de variável de ambiente — troque a etiqueta por lá.", { status: 409 });
  }

  // Só etiqueta que a conta tem: uma TAG que não é dela gera link sem comissão.
  const { tags } = await listarEtiquetas(userId);
  if (!tags.some(t => t.tag === nova)) {
    throw new AppError(`A etiqueta "${nova}" não existe nesta conta do Mercado Livre.`, { status: 400 });
  }

  const resposta = await chamaML("setTagInUse", cookie, { method: "PUT", body: { tag: nova } });
  affiliate.writeMLConfig(userId, { tag: nova });

  // O setTagInUse devolve a lista já trocada; se vier em outro formato, a lista
  // de antes com a marca movida serve.
  const depois = normalizaListaEtiquetas(resposta);
  return {
    tags: depois.length ? depois : tags.map(t => ({ ...t, inUse: t.tag === nova })),
    current: nova,
  };
}

module.exports = {
  listarEtiquetas,
  trocarEtiqueta,
  // pura, exportada pros testes
  normalizaListaEtiquetas,
};
