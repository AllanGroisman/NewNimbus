// A sonda do checkout em LOTE: os produtos do scraping, um por um, no Chrome do
// admin (task 13). Quem anda é a tela (frontend/src/data/sondaLote.js); aqui fica
// a fila e o que acontece quando cada resultado volta.
//
// Uma sonda lê TODOS os cupons que o checkout oferece para aquele carrinho, então
// não existe a conta "produto × cupom": o custo é uma sonda por produto — 40 a 90 s
// e um risco de CAPTCHA na conta. Toda a otimização está em QUAIS produtos e em
// que ORDEM:
//
//   - só ML vindo do scraping (`category` preenchida — a vitrine do cupom põe
//     produto no catálogo sem categoria) e visto há pouco (ainda está no ar);
//   - quem já foi sondado há menos de `pularDias` fica de fora; quem falhou (não
//     chegou na lista de cupons) volta no dia seguinte;
//   - rodízio entre as categorias, os mais vendidos primeiro, e as categorias que
//     RENDERAM cupom nas sondas anteriores ganham mais vagas por rodada.
//
// A ordem só prioriza, nunca exclui: "a categoria X nunca teve cupom" continua não
// sendo resposta — a mesma regra de product-coupons.js sobre a ausência.
const { prisma } = require("../db");
const { Prisma } = require("@prisma/client");
const { lerEVincular } = require("./product-coupons");

const PAUSA_MS = 5000;
const LIMITE_MAX = 200;
// Produto que não aparece no scraping há mais que isso provavelmente saiu do ar.
const VISTO_HA_DIAS = 7;
// Quem falhou (muro, seguro, botão desabilitado) volta depois deste tempo — não
// antes, pra um produto quebrado não entrar em todo lote.
const FALHA_VOLTA_HORAS = 24;

// Rendimento de uma categoria, suavizado: sem histórico dá 0,5 (vale explorar), e
// cada sonda puxa o número para o que a categoria mostrou.
function rendimento({ sondados = 0, comCupom = 0 } = {}) {
  return (comCupom + 1) / (sondados + 2);
}

// Pura. `linhas` já vem ordenada DENTRO de cada categoria (a melhor primeiro);
// `historico` é { [categoria]: { sondados, comCupom } }. Devolve até `limite`
// linhas intercaladas: a 1ª rodada dá uma vaga a cada categoria (todas são
// exploradas), as seguintes dão de 1 a 3 vagas conforme o rendimento — e em toda
// rodada a categoria que mais rende vem antes.
function ordemPorCategoria(linhas, historico = {}, limite = 20) {
  const filas = new Map();
  for (const l of linhas || []) {
    const cat = l.category || "_";
    if (!filas.has(cat)) filas.set(cat, []);
    filas.get(cat).push(l);
  }
  const nota = (cat) => rendimento(historico[cat]);
  const cats = [...filas.keys()].sort((a, b) => nota(b) - nota(a) || a.localeCompare(b));

  const saida = [];
  for (let rodada = 0; saida.length < limite; rodada++) {
    let pegou = false;
    for (const cat of cats) {
      const fila = filas.get(cat);
      const vagas = rodada === 0 ? 1 : Math.max(1, Math.round(nota(cat) * 3));
      for (let i = 0; i < vagas && fila.length && saida.length < limite; i++) {
        saida.push(fila.shift());
        pegou = true;
      }
    }
    if (!pegou) break;
  }
  return saida;
}

function filtros({ pularDias = 7, soSemCupom = false } = {}) {
  const corteOk = new Date(Date.now() - Math.max(0, Number(pularDias) || 0) * 864e5);
  const corteFalha = new Date(Date.now() - FALHA_VOLTA_HORAS * 36e5);
  const visto = new Date(Date.now() - VISTO_HA_DIAS * 864e5);
  const cond = [
    Prisma.sql`cp."store" = 'Mercado Livre'`,
    Prisma.sql`cp."category" IS NOT NULL`,
    Prisma.sql`cp."lastSeenAt" >= ${visto}`,
    Prisma.sql`NOT EXISTS (
      SELECT 1 FROM "ml_checkout_probes" s
       WHERE s."productKey" = cp."key"
         AND ((s."ok" AND s."probedAt" >= ${corteOk}) OR (NOT s."ok" AND s."probedAt" >= ${corteFalha})))`,
  ];
  if (soSemCupom) {
    cond.push(Prisma.sql`cp."couponCampaignId" IS NULL`);
    cond.push(Prisma.sql`NOT EXISTS (SELECT 1 FROM "ml_coupon_products" v WHERE v."productKey" = cp."key")`);
  }
  return cond;
}

async function historicoPorCategoria() {
  const rows = await prisma().$queryRaw`
    SELECT "category", COUNT(*)::int AS sondados, COUNT(*) FILTER (WHERE "cupons" > 0)::int AS "comCupom"
      FROM "ml_checkout_probes"
     WHERE "ok" AND "category" IS NOT NULL
     GROUP BY 1`;
  return Object.fromEntries(rows.map(r => [r.category, { sondados: r.sondados, comCupom: r.comCupom }]));
}

// A fila do lote. `porCategoria` ignora o filtro de categoria de propósito: é o
// que a tela mostra nas caixinhas, e desmarcar uma não pode sumir com ela.
async function alvos({ categorias = null, limite = 20, pularDias = 7, soSemCupom = false } = {}) {
  const n = Math.min(LIMITE_MAX, Math.max(1, Number(limite) || 20));
  const cond = filtros({ pularDias, soSemCupom });
  const whereSemCat = Prisma.join(cond, " AND ");
  const lista = Array.isArray(categorias) ? categorias.filter(Boolean).map(String) : [];
  const where = lista.length ? Prisma.join([...cond, Prisma.sql`cp."category" = ANY(${lista})`], " AND ") : whereSemCat;

  // Um por anúncio (a mesma fusão do upsert, por garantia) e no máximo `n` por
  // categoria — mais que isso nenhuma categoria usaria num lote de `n`.
  const linhas = await prisma().$queryRaw`
    SELECT "key", "name", "link", "price", "category" FROM (
      SELECT u.*, ROW_NUMBER() OVER (PARTITION BY u."category"
               ORDER BY u."soldCount" DESC NULLS LAST, u."discount" DESC NULLS LAST, u."lastSeenAt" DESC) AS rn
        FROM (
          SELECT DISTINCT ON (COALESCE(cp."mlAnuncioId", cp."key")) cp.*
            FROM "catalog_products" cp
           WHERE ${where}
           ORDER BY COALESCE(cp."mlAnuncioId", cp."key"), cp."soldCount" DESC NULLS LAST
        ) u
    ) t
    WHERE rn <= ${n}
    ORDER BY "category", rn`;

  const [contagem, historico] = await Promise.all([
    prisma().$queryRaw`
      SELECT cp."category", COUNT(DISTINCT COALESCE(cp."mlAnuncioId", cp."key"))::int AS n
        FROM "catalog_products" cp
       WHERE ${whereSemCat}
       GROUP BY 1`,
    historicoPorCategoria(),
  ]);

  const elegiveis = Object.fromEntries(contagem.map(r => [r.category, r.n]));
  const cats = new Set([...Object.keys(elegiveis), ...Object.keys(historico)]);
  const porCategoria = [...cats].map(category => ({
    category,
    elegiveis: elegiveis[category] || 0,
    sondados: historico[category]?.sondados || 0,
    comCupom: historico[category]?.comCupom || 0,
  })).sort((a, b) => b.elegiveis - a.elegiveis || a.category.localeCompare(b.category));

  const total = lista.length
    ? lista.reduce((s, c) => s + (elegiveis[c] || 0), 0)
    : Object.values(elegiveis).reduce((s, v) => s + v, 0);

  return {
    produtos: ordemPorCategoria(linhas, historico, n).map(l => ({
      key: l.key, name: l.name, link: l.link, price: l.price, category: l.category,
    })),
    total,
    porCategoria,
    cfg: { pausaMs: PAUSA_MS },
  };
}

// O resultado de uma sonda do lote: vincula o que vale (a mesma leitura da sonda
// manual, sem o dump em disco) e anota que o produto foi sondado. `erro` é quando
// a extensão nem devolveu material — conta como falha, volta amanhã.
async function gravarResultado({ key, url = null, material = null, erro = null } = {}) {
  if (!key) throw new Error("Falta o produto.");
  const produto = await prisma().catalogProduct.findUnique({ where: { key: String(key) } });
  if (!produto) throw new Error("Esse produto não está no catálogo.");
  const link = url || produto.link;

  const leitura = material && typeof material === "object"
    ? await lerEVincular({ url: link, material, productKeys: [produto.key] })
    : { ok: false, motivo: erro || "A extensão não devolveu nada.", cupons: [], valem: [], gravado: null };

  const motivo = leitura.ok ? null : String(material?.motivo || material?.checkout?.blockedReason || leitura.motivo || erro || "").slice(0, 500) || null;
  const dados = {
    productUrl: link,
    category: produto.category,
    probedAt: new Date(),
    ok: !!leitura.ok,
    cupons: leitura.valem.length,
    campaignIds: leitura.valem,
    motivo,
  };
  await prisma().mlCheckoutProbe.upsert({
    where: { productKey: produto.key },
    create: { productKey: produto.key, ...dados },
    update: dados,
  });

  return {
    key: produto.key,
    ok: !!leitura.ok,
    motivo,
    cupons: leitura.ok ? leitura.cupons.filter(c => leitura.valem.includes(c.campaignId)).map(c => ({
      campaignId: c.campaignId, titulo: c.titulo, aplicado: c.aplicado, descontoNoCarrinho: c.descontoNoCarrinho,
    })) : [],
    listados: leitura.ok ? leitura.cupons.length : 0,
    cuponsNovos: leitura.gravado?.cuponsNovos || 0,
  };
}

module.exports = { alvos, gravarResultado, ordemPorCategoria, rendimento, PAUSA_MS };
