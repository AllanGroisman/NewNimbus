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

// Estados que a tela filtra. `nao-testado` é o mais comum e o mais importante:
// é a fila de trabalho de quem abre a aba. `sem-campanha` é o passo seguinte —
// o ML confirmou a palavra, mas a campanha nunca foi raspada pra cá.
const STATUS = ["todos", "nao-testado", "valid", "invalid", "indeterminado", "sem-campanha"];

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
    case "nao-testado":   return linha.verdict == null;
    case "valid":         return linha.verdict === "valid";
    case "invalid":       return linha.verdict === "invalid";
    case "indeterminado": return linha.verdict === "indeterminado";
    case "sem-campanha":  return linha.verdict === "valid" && !linha.inSystem;
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
              FILTER (WHERE l."store" = 'Mercado Livre'))[1]  AS link
      FROM "repasse_capture_log" l
     WHERE l."coupon" IS NOT NULL
       AND l."createdAt" >= ${desde}
       ${filtroTermo}
     GROUP BY l."coupon"
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
  const [cupons, produtos] = await Promise.all([
    campaignIds.length
      ? prisma().mlCoupon.findMany({
          where: { campaignId: { in: campaignIds } },
          select: { campaignId: true, title: true, expiresAt: true },
        })
      : [],
    campaignIds.length
      ? prisma().mlCouponProduct.groupBy({
          by: ["campaignId"],
          where: { campaignId: { in: campaignIds } },
          _count: { _all: true },
        })
      : [],
  ]);
  const cupomById = new Map(cupons.map(c => [c.campaignId, c]));
  const produtosById = new Map(produtos.map(p => [p.campaignId, p._count._all]));

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
  // A fila de trabalho do coupon-autotest.js. Exportado (e não recriado lá) pra
  // tela e job lerem exatamente o mesmo cruzamento log × ml_coupon_codes.
  aggregate,
  STATUS,
  OUTCOMES_APROVEITADOS,
};
