// Os cupons que o repasse pescou nas legendas dos grupos líderes, agregados por
// código — o que a aba Admin › Cupom › Repasse mostra.
//
// Até aqui esse cupom morria em dois lugares mudos: a coluna `coupon` do
// `repasse_capture_log` (uma linha por LINK, então o mesmo código aparece
// dezenas de vezes) e o payload do item na fila. Ninguém nunca perguntava ao ML
// se o código existe, de que campanha ele é, nem se os produtos dessa campanha
// já foram raspados. Este módulo é o lado da LEITURA que junta as duas metades:
// o que o repasse viu (log de captura) e o que o sistema sabe da palavra
// (`ml_coupon_codes` + `ml_coupons`, o dicionário da aba "Descobrir palavra").
//
// Só lê. Testar a palavra e trazer a campanha é trabalho do coupons/sync.js,
// disparado pelo botão da tela ou pelo job de coupon-autotest.js — cada teste abre
// um Chrome com a sessão do ML, e isso não pode acontecer a cada mensagem recebida.
// Por isso o job roda em rodadas espaçadas e usa o `aggregate` daqui como fila de
// trabalho, em vez de uma consulta própria: a fila dele e a lista da tela têm que
// ser a mesma coisa, senão "nunca testados: 12" na aba não explica o que o robô fez.
const { prisma } = require("../db");
const { Prisma } = require("@prisma/client");

const PAGE_SIZE_MAX = 200;

// Os desfechos em que o link virou produto de verdade. Serve pra tela dizer
// "esse cupom rendeu N produtos" e não só "apareceu N vezes" — cupom que só
// aparece em link descartado não vale o teste.
const OUTCOMES_APROVEITADOS = ["queued", "pending"];

// Os desfechos que fazem o código CONTAR como cupom: o link passou pela loja, pelo
// afiliado e pelo scrape, e virou produto. `cooldown` e `duplicate` entram porque
// são produto válido que só não foi pra fila agora. Fica de fora o `discarded` —
// loja desconhecida (o TUDOPOR59 veio com um link da Centauro), CAPTCHA, link que
// não é produto — e o `error`. A loja não precisa de condição própria: nenhum
// destes desfechos acontece sem loja suportada.
const OUTCOMES_CUPOM = ["queued", "pending", "cooldown", "duplicate"];

// Estados que a tela filtra. `nao-testado` é o mais comum e o mais importante:
// é a fila de trabalho de quem abre a aba. `sem-campanha` é o passo seguinte —
// o ML confirmou a palavra, mas a campanha nunca foi raspada pra cá. `sem-id` é o
// aprovado no checkout sem a campanha identificada (o cupom entrou no resumo, mas
// o cartão não foi lido) — não há campanha a trazer, só a retestar. `outra-loja`
// é o código que só veio com link de Amazon/Shopee: o teste é no checkout do ML,
// então ele nunca sai de "nunca testado" e não pode ficar misturado à fila.
const STATUS = ["todos", "nao-testado", "valid", "invalid", "indeterminado", "sem-campanha", "sem-id", "outra-loja"];

function sanitizeDays(v) {
  if (v == null || v === "" || v === "tudo") return null;
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(3650, n);
}

// Filtra a LINHA já montada (código + o que se sabe dele). Fica em JS, e não no
// SQL, porque o veredito não mora na mesma tabela da agregação: cruzar as duas no
// SQL exigiria um LEFT JOIN com `ml_coupon_codes` só pra repetir esta regra.
function matchStatus(linha, status) {
  switch (status) {
    case "nao-testado":   return linha.verdict == null && !linha.soOutraLoja;
    case "valid":         return linha.verdict === "valid";
    case "invalid":       return linha.verdict === "invalid";
    case "indeterminado": return linha.verdict === "indeterminado";
    case "sem-campanha":  return linha.verdict === "valid" && !!linha.campaignId && !linha.inSystem;
    case "sem-id":        return linha.verdict === "valid" && !linha.campaignId;
    case "outra-loja":    return linha.verdict == null && linha.soOutraLoja;
    default:              return true;
  }
}

// Monta as linhas: a agregação do log de captura cruzada com o que o sistema
// sabe de cada palavra. Fica separada do `listCapturedCoupons` porque a limpeza
// da lista (`forgetFiltered`) precisa passar exatamente pelo mesmo caminho — se
// ela repetisse a consulta por conta própria, "limpar o que o filtro mostra"
// poderia deixar de ser o que a tela está mostrando.
async function aggregate({ days = 90, q = "" } = {}) {
  const dias = sanitizeDays(days);
  const desde = dias ? new Date(Date.now() - dias * 86400000) : new Date(0);
  const termo = String(q || "").trim().toUpperCase();

  // O termo entra como fragmento OPCIONAL em vez de um `$1 = '' OR ...`: com o
  // parâmetro solto o Postgres não consegue inferir o tipo dele e recusa a query.
  const filtroTermo = termo
    ? Prisma.sql`AND l."coupon" LIKE ${`%${termo}%`}`
    : Prisma.empty;

  const linhas = await prisma().$queryRaw`
    SELECT l."coupon"                                      AS code,
           COUNT(*)                                        AS capturas,
           MIN(l."createdAt")                              AS primeira,
           MAX(l."createdAt")                              AS ultima,
           COUNT(DISTINCT l."groupId")                     AS campanhas,
           COUNT(DISTINCT l."userId")                      AS usuarios,
           COUNT(*) FILTER (WHERE l."outcome" = ANY(${OUTCOMES_APROVEITADOS})) AS aproveitados,
           -- O link de produto do ML que chegou com o cupom: é nele que o teste no
           -- checkout (repasse/checkout-cupom.js) aplica o código. O de um link que
           -- virou produto vale mais que o de um descartado; entre iguais, o recente.
           (ARRAY_AGG(COALESCE(l."resolvedUrl", l."rawUrl")
                      ORDER BY (l."outcome" = ANY(${OUTCOMES_APROVEITADOS})) DESC, l."createdAt" DESC)
              FILTER (WHERE l."store" = 'Mercado Livre'))[1]  AS link,
           COUNT(DISTINCT COALESCE(l."resolvedUrl", l."rawUrl"))
              FILTER (WHERE l."store" = 'Mercado Livre')    AS links,
           ARRAY_AGG(DISTINCT l."store")
              FILTER (WHERE l."outcome" = ANY(${OUTCOMES_CUPOM}) AND l."store" IS NOT NULL) AS lojas
      FROM "repasse_capture_log" l
     WHERE l."coupon" IS NOT NULL
       AND l."createdAt" >= ${desde}
       ${filtroTermo}
     GROUP BY l."coupon"
    -- HAVING, e não WHERE: o código que vale continua contando todas as capturas,
    -- inclusive as descartadas; só o código que NUNCA virou produto some.
    HAVING COUNT(*) FILTER (WHERE l."outcome" = ANY(${OUTCOMES_CUPOM})) > 0
     ORDER BY MAX(l."createdAt") DESC
  `;

  const codes = linhas.map(r => r.code);
  if (!codes.length) return [];

  // O que o sistema já sabe de cada palavra. Mesmo trio de consultas do
  // coupons/pg.js:listCodeChecks — palavra → campanha → cupom raspado; aqui entra
  // também a contagem de produtos, que é o que diz se a campanha foi de fato
  // integrada ou só cadastrada.
  const checks = await prisma().mlCouponCode.findMany({ where: { code: { in: codes } } });
  const checkByCode = new Map(checks.map(c => [c.code, c]));

  const campaignIds = [...new Set(checks.map(c => c.campaignId).filter(Boolean))];
  const [cupons, produtos, daVitrine] = await Promise.all([
    campaignIds.length
      ? prisma().mlCoupon.findMany({
          where: { campaignId: { in: campaignIds } },
          select: { campaignId: true, title: true, expiresAt: true, containerUrl: true },
        })
      : [],
    campaignIds.length
      ? prisma().mlCouponProduct.groupBy({
          by: ["campaignId"],
          where: { campaignId: { in: campaignIds } },
          _count: { _all: true },
        })
      : [],
    // Só os que vieram da vitrine: o vínculo do teste no checkout é UM produto e
    // não diz que a vitrine foi lida (repasse/coupon-autotest.js:selecionar).
    campaignIds.length
      ? prisma().mlCouponProduct.groupBy({
          by: ["campaignId"],
          where: { campaignId: { in: campaignIds }, origem: { in: ["vitrine", "parcial"] } },
          _count: { _all: true },
        })
      : [],
  ]);
  const cupomById = new Map(cupons.map(c => [c.campaignId, c]));
  const produtosById = new Map(produtos.map(p => [p.campaignId, p._count._all]));
  const daVitrineById = new Map(daVitrine.map(p => [p.campaignId, p._count._all]));

  return linhas.map(r => {
    const chk = checkByCode.get(r.code) || null;
    const cupom = chk?.campaignId ? cupomById.get(chk.campaignId) || null : null;
    return {
      code: r.code,
      // COUNT do Postgres chega como BigInt pelo $queryRaw — JSON.stringify
      // explode em cima dele ("Do not know how to serialize a BigInt").
      capturas: Number(r.capturas),
      primeira: r.primeira,
      ultima: r.ultima,
      campanhas: Number(r.campanhas),
      usuarios: Number(r.usuarios),
      aproveitados: Number(r.aproveitados),
      link: r.link || null,
      // Quantos produtos do ML diferentes chegaram com o cupom (linksDoCupom).
      links: Number(r.links || 0),
      // As lojas dos links que viraram produto com o código. Sem link do ML, não há
      // onde testar: a tela mostra a loja em vez de "nunca testado".
      lojas: r.lojas || [],
      soOutraLoja: !r.link && (r.lojas || []).length > 0,
      // null = nunca testado. É diferente de "invalid" (o ML não reconheceu) e de
      // "indeterminado" (o ML não respondeu), e a tela não pode passar um pelo outro.
      verdict: chk?.verdict ?? null,
      campaignId: chk?.campaignId ?? null,
      message: chk?.message ?? null,
      source: chk?.source ?? null,
      checkedAt: chk?.checkedAt ?? null,
      checkCount: chk?.checkCount ?? 0,
      // A campanha existe aqui dentro? Sem isso a tela não tem como oferecer o
      // "trazer campanha" — não há FK entre `ml_coupon_codes` e `ml_coupons`.
      inSystem: chk?.campaignId ? cupomById.has(chk.campaignId) : null,
      couponTitle: cupom?.title ?? null,
      expiresAt: cupom?.expiresAt ?? null,
      produtos: chk?.campaignId ? (produtosById.get(chk.campaignId) || 0) : 0,
      produtosVitrine: chk?.campaignId ? (daVitrineById.get(chk.campaignId) || 0) : 0,
      // null = a campanha não está aqui (nem se sabe).
      temVitrine: cupom ? !!cupom.containerUrl : null,
    };
  });
}

// Um cupom por linha: quantas vezes o repasse o viu, desde quando, em quantas
// campanhas/contas, e o que o sistema sabe da palavra.
//
// A paginação é feita sobre o resultado FILTRADO, e por isso a agregação vem
// inteira do banco antes do corte. É aceitável porque o universo aqui é o número
// de códigos DISTINTOS vistos no período (dezenas/centenas), não o de linhas do
// log (que é o que cresce).
async function listCapturedCoupons({ page = 1, pageSize = 50, days = 90, status = "todos", q = "" } = {}) {
  const pg = Math.max(1, parseInt(page, 10) || 1);
  const size = Math.min(PAGE_SIZE_MAX, Math.max(1, parseInt(pageSize, 10) || 50));
  const st = STATUS.includes(status) ? status : "todos";

  const montadas = await aggregate({ days, q });
  if (!montadas.length) {
    return { items: [], total: 0, page: pg, pageSize: size, totalCapturados: 0 };
  }

  const filtradas = montadas.filter(l => matchStatus(l, st));
  return {
    items: filtradas.slice((pg - 1) * size, pg * size),
    total: filtradas.length,
    // Quantos códigos distintos existem no período ANTES do filtro — é o que dá
    // sentido ao "3 de 47" na tela quando um filtro está ligado.
    totalCapturados: montadas.length,
    page: pg,
    pageSize: size,
  };
}

// Os produtos do ML que chegaram com o cupom, um por link, cada um com o último
// teste no checkout feito NELE (a URL mora no diário, coupon-autotest-log.js). É o
// que a linha aberta da aba lista pra escolher em que produto testar.
//
// Sem recorte de período, pela mesma regra do forgetCoupons: o cupom que está na
// lista tem que mostrar todos os links que o puseram lá.
const LINKS_MAX = 100;

async function linksDoCupom(code) {
  const c = String(code ?? "").trim().toUpperCase();
  if (!c) return [];

  const linhas = await prisma().$queryRaw`
    SELECT COALESCE(l."resolvedUrl", l."rawUrl")          AS url,
           COUNT(*)                                     AS capturas,
           MAX(l."createdAt")                           AS ultima,
           BOOL_OR(l."outcome" = ANY(${OUTCOMES_APROVEITADOS})) AS aproveitado,
           (ARRAY_AGG(l."productName" ORDER BY l."createdAt" DESC) FILTER (WHERE l."productName" IS NOT NULL))[1] AS "productName",
           (ARRAY_AGG(l."productImg"  ORDER BY l."createdAt" DESC) FILTER (WHERE l."productImg"  IS NOT NULL))[1] AS "productImg",
           (ARRAY_AGG(l."price"       ORDER BY l."createdAt" DESC) FILTER (WHERE l."price"       IS NOT NULL))[1] AS price
      FROM "repasse_capture_log" l
     WHERE l."coupon" = ${c}
       AND l."store" = 'Mercado Livre'
     GROUP BY 1
     ORDER BY BOOL_OR(l."outcome" = ANY(${OUTCOMES_APROVEITADOS})) DESC, MAX(l."createdAt") DESC
     LIMIT ${LINKS_MAX}
  `;
  if (!linhas.length) return [];

  const urls = linhas.map(r => r.url);
  const testes = await prisma().$queryRaw`
    SELECT DISTINCT ON (t."url") t."url", t."verdict", t."message", t."created_at" AS em
      FROM "repasse_coupon_autotest" t
     WHERE t."code" = ${c}
       AND t."action" = 'test'
       AND t."url" = ANY(${urls})
     ORDER BY t."url", t."created_at" DESC
  `;
  const testePorUrl = new Map(testes.map(t => [t.url, t]));
  const vinculoPorUrl = await vinculosDosLinks(c, urls);

  return linhas.map(r => {
    const t = testePorUrl.get(r.url) || null;
    return {
      url: r.url,
      productName: r.productName ?? null,
      productImg: r.productImg ?? null,
      price: r.price ?? null,
      capturas: Number(r.capturas),
      ultima: r.ultima,
      aproveitado: !!r.aproveitado,
      ultimoTeste: t ? { verdict: t.verdict ?? null, message: t.message ?? null, em: t.em } : null,
      // A origem do vínculo deste produto com a campanha do código, ou null.
      vinculo: vinculoPorUrl.get(r.url) || null,
    };
  });
}

// O link em que RETESTAR cada código. O `link` do aggregate é sempre o mesmo (o
// aproveitado mais recente), e quando o teste falhou por culpa DELE — landing de
// afiliado, variação obrigatória, página que não é produto — retestar ali só
// queimava as tentativas do código. Aqui a vez é do link ainda não testado; entre
// os já testados, do que foi testado há mais tempo. Uma consulta de cada lado
// para todos os códigos da fila.
async function proximosLinks(codes, { days = 90 } = {}) {
  const alvo = [...new Set((codes || []).map(c => String(c ?? "").trim().toUpperCase()).filter(Boolean))];
  const resposta = new Map();
  if (!alvo.length) return resposta;
  const dias = sanitizeDays(days);
  const desde = dias ? new Date(Date.now() - dias * 86400000) : new Date(0);

  const [links, testes] = await Promise.all([
    prisma().$queryRaw`
      SELECT l."coupon" AS code,
             COALESCE(l."resolvedUrl", l."rawUrl") AS url,
             BOOL_OR(l."outcome" = ANY(${OUTCOMES_APROVEITADOS})) AS aproveitado,
             MAX(l."createdAt") AS ultima
        FROM "repasse_capture_log" l
       WHERE l."coupon" = ANY(${alvo})
         AND l."store" = 'Mercado Livre'
         AND l."createdAt" >= ${desde}
       GROUP BY 1, 2
    `,
    prisma().$queryRaw`
      SELECT t."code", t."url", MAX(t."created_at") AS em
        FROM "repasse_coupon_autotest" t
       WHERE t."code" = ANY(${alvo})
         AND t."action" = 'test'
         AND t."url" IS NOT NULL
       GROUP BY 1, 2
    `,
  ]);
  const testadoEm = new Map(testes.map(t => [`${t.code}\n${t.url}`, new Date(t.em).getTime()]));
  const porCodigo = new Map();
  for (const l of links) {
    if (!l.url) continue;
    if (!porCodigo.has(l.code)) porCodigo.set(l.code, []);
    porCodigo.get(l.code).push({ ...l, testado: testadoEm.get(`${l.code}\n${l.url}`) ?? null });
  }
  for (const [code, ls] of porCodigo) {
    ls.sort((a, b) =>
      (a.testado ?? -Infinity) - (b.testado ?? -Infinity) ||
      Number(!!b.aproveitado) - Number(!!a.aproveitado) ||
      new Date(b.ultima) - new Date(a.ultima));
    resposta.set(code, ls[0].url);
  }
  return resposta;
}

// Qual vínculo cada link tem com a campanha do código. Pelas chaves candidatas do
// link mais a canônica do catálogo — a mesma conta de quem gravou
// (coupons/pg.js:vincularDoRepasse e vincularPorCheckout). Havendo mais de uma,
// fica a mais forte.
const PESO_ORIGEM = { checkout: 4, vitrine: 3, parcial: 2, repasse: 1 };

async function vinculosDosLinks(code, urls) {
  const resposta = new Map();
  const chk = await prisma().mlCouponCode.findUnique({ where: { code }, select: { campaignId: true } });
  if (!chk?.campaignId || !urls.length) return resposta;

  const { chavesCandidatas } = require("../coupons/quick-check");
  const porUrl = new Map(urls.map(u => [u, chavesCandidatas(u)]));
  const canonica = await require("../catalog/pg").resolveKeys(
    [...porUrl].flatMap(([u, ks]) => ks.map(key => ({ key, link: u }))),
  );
  for (const [u, ks] of porUrl) porUrl.set(u, [...new Set([...ks, ...ks.map(k => canonica.get(k)).filter(Boolean)])]);

  const todas = [...new Set([...porUrl.values()].flat())];
  if (!todas.length) return resposta;
  const vinculos = await prisma().mlCouponProduct.findMany({
    where: { campaignId: chk.campaignId, productKey: { in: todas } },
    select: { productKey: true, origem: true },
  });
  const origemPorChave = new Map(vinculos.map(v => [v.productKey, v.origem || "vitrine"]));
  for (const [u, ks] of porUrl) {
    let melhor = null;
    for (const k of ks) {
      const o = origemPorChave.get(k);
      if (o && (!melhor || (PESO_ORIGEM[o] || 0) > (PESO_ORIGEM[melhor] || 0))) melhor = o;
    }
    if (melhor) resposta.set(u, melhor);
  }
  return resposta;
}

// ── Faxina ───────────────────────────────────────────────────────────────
// "Excluir o cupom" aqui é ESQUECER o código, não apagar a captura: a coluna
// `coupon` das linhas daquele código vai a null e todo o resto da linha (grupo,
// link, produto, desfecho, erro) continua no log de Admin › Repasse. Apagar as
// linhas mudaria as estatísticas do repasse/summary.js — taxa de sucesso e
// contagem de desfechos — por causa de uma faxina de cupom, que não tem nada a
// ver com isso.
//
// O que também NÃO some: a palavra em `ml_coupon_codes`. Mesma regra que o
// couponsStore.clearAll já documenta — cada palavra testada custou um Chrome
// aberto com a conta do ML, e ela segue valendo pra aba "Descobrir palavra".
//
// Efeito colateral aceito: se o mesmo código for capturado de novo amanhã, ele
// volta pra lista. Isto é uma limpeza, não uma lista de bloqueio — quem barra
// palavra que nunca é cupom é a lista `ignore` do coupon-words.js.
async function forgetCoupons(codes) {
  const alvo = [...new Set(
    (Array.isArray(codes) ? codes : [codes])
      .map(c => String(c ?? "").trim().toUpperCase())
      .filter(Boolean),
  )];
  if (!alvo.length) return { cupons: 0, capturas: 0 };

  // Sem recorte de período de propósito: zerar só as linhas dos últimos 90 dias
  // deixaria a linha na tela, remontada pelas capturas mais antigas, e o botão
  // pareceria não ter funcionado.
  const { count } = await prisma().repasseCaptureLog.updateMany({
    where: { coupon: { in: alvo } },
    data: { coupon: null },
  });
  return { cupons: alvo.length, capturas: count };
}

// O "limpar lista" da aba: os códigos saem do MESMO filtro que a tela usa pra
// listar, então o que some é exatamente o que estava à vista.
async function forgetFiltered({ days = 90, status = "todos", q = "" } = {}) {
  const st = STATUS.includes(status) ? status : "todos";
  const montadas = await aggregate({ days, q });
  return forgetCoupons(montadas.filter(l => matchStatus(l, st)).map(l => l.code));
}

module.exports = {
  listCapturedCoupons,
  forgetCoupons,
  forgetFiltered,
  linksDoCupom,
  proximosLinks,
  // A fila de trabalho do coupon-autotest.js. Exportado (e não recriado lá) pra
  // tela e job lerem exatamente o mesmo cruzamento log × ml_coupon_codes.
  aggregate,
  STATUS,
  OUTCOMES_APROVEITADOS,
  OUTCOMES_CUPOM,
};
