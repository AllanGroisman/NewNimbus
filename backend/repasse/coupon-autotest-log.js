// Escrita e leitura do diário do teste automático de cupom — uma linha por
// TENTATIVA do job de coupon-autotest.js.
//
// Módulo à parte pelo mesmo motivo do capture-log.js: a única dependência é o db,
// e quem loga não precisa arrastar sync/scraper/puppeteer pro próprio grafo.
//
// Tabela própria (`repasse_coupon_autotest`) e não o `repasse_capture_log`: lá as
// colunas de captura são NOT NULL e um teste de palavra não tem grupo nem link, e
// a aba agrega aquele log por cupom com COUNT(*) — cada teste apareceria como uma
// "captura" na coluna que o admin lê.
const { prisma } = require("../db");

// Os passos que o job registra. `skip` é o que dá voz à rodada que não fez nada:
// sem ele a tela mostraria "última rodada 14h32" sem dizer que ela desistiu por
// causa de uma rodada do admin em curso.
const ACTION = {
  TEST: "test",
  IMPORT: "import",
  VITRINE: "vitrine",
  SKIP: "skip",
};

const PAGE_SIZE_MAX = 200;

// Best-effort, igual ao capture-log: o diário é observabilidade e não pode derrubar
// nem atrasar a rodada. Se o insert falhar, o que se perde é a linha da tela — não
// o teste, que já foi gravado em `ml_coupon_codes` pelo recordCodeCheck.
async function logAutotest(fields) {
  try {
    await prisma().repasseCouponAutotest.create({
      data: {
        code: String(fields.code ?? "").toUpperCase(),
        action: fields.action,
        ok: !!fields.ok,
        verdict: fields.verdict || null,
        campaignId: fields.campaignId != null ? String(fields.campaignId) : null,
        produtos: fields.produtos ?? null,
        errorKind: fields.errorKind || null,
        // O texto vem do ML (ou de um err.message) e a coluna não tem teto: corta
        // aqui pra uma mensagem de erro gigante do Puppeteer não virar a linha.
        message: fields.message ? String(fields.message).slice(0, 500) : null,
        durationMs: fields.durationMs != null ? Math.round(fields.durationMs) : null,
        url: fields.url ? String(fields.url).slice(0, 1000) : null,
      },
    });
  } catch (err) {
    console.error(`[repasse] falha ao gravar log do teste automático: ${err.message}`);
  }
}

// O que a tela mostra. `code` opcional = o histórico de UM cupom (a linha
// expandida da aba); sem ele, o diário inteiro do mais recente pro mais antigo.
async function listAutotestLog({ page = 1, pageSize = 20, code = "" } = {}) {
  const pg = Math.max(1, parseInt(page, 10) || 1);
  const size = Math.min(PAGE_SIZE_MAX, Math.max(1, parseInt(pageSize, 10) || 20));
  const alvo = String(code || "").trim().toUpperCase();
  const where = alvo ? { code: alvo } : {};

  const [total, rows] = await Promise.all([
    prisma().repasseCouponAutotest.count({ where }),
    prisma().repasseCouponAutotest.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (pg - 1) * size,
      take: size,
    }),
  ]);

  return {
    page: pg,
    pageSize: size,
    total,
    // `id` é BigInt e JSON.stringify explode em cima dele.
    items: rows.map(r => ({ ...r, id: String(r.id) })),
  };
}

module.exports = { logAutotest, listAutotestLog, ACTION };
