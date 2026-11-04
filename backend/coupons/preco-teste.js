// Admin › Scraping Cupons › Cupons Teste — o preço com cupom que a MENSAGEM
// prometeu é o que o checkout do Mercado Livre cobra?
//
// O laço anda na aba do admin (frontend/src/data/precoTeste.js): para cada envio
// recente com cupom, a extensão abre o link enviado, vai ao checkout, digita o
// cupom (o mesmo comando `cupom-no-checkout` do teste do repasse) e devolve o que
// viu. Aqui ficam as três partes do servidor:
//
//   - `alvos`: quais envios conferir (group_history, com os filtros da config);
//   - `interpretarConferencia`: PURA — material da extensão + o que foi prometido
//     → ok / divergente / cupom-nao-pegou / prometeu-sem-desconto / falhou;
//   - as rodadas (`cupom_teste_runs` / `cupom_teste_itens`), pra tela mostrar o
//     andamento, o resultado e o histórico.
//
// SÓ LÊ o ML: nada daqui mexe no veredito do cupom (`ml_coupon_codes`) nem em
// vínculo cupom↔produto. A leitura do checkout é a do repasse
// (repasse/checkout-cupom.js:interpretar) e a da lista de cupons
// (coupons/checkout-list.js:parseCheckoutCupons) — regra duplicada diverge.
const { prisma } = require("../db");
const { interpretar, mensagemDe } = require("../repasse/checkout-cupom");
const { parseCheckoutCupons } = require("./checkout-list");

// Envios lidos do banco antes dos filtros que são em JS. Muito mais do que
// qualquer rodada usa (o teto da config é 200), e o bastante pra 30 dias.
const HISTORICO_MAX = 5000;

const num = (v) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const centavos = (v) => (v == null ? null : Math.round(v * 100) / 100);
const reais = (v) => (v == null ? "?" : `R$ ${Number(v).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

// ── Quais envios conferir ────────────────────────────────────────────────

// O que a mensagem prometeu num envio. Os envios de depois de 05/11/2026 gravaram
// cupom e preço com cupom (scheduler.js:deliverItem); os de antes, não — pra eles
// a conta é refeita com as regras de HOJE (`estimar`) e o alvo sai `estimado`.
async function prometido(h, estimar) {
  const gravou = h.coupon != null || h.sentPrice != null || h.priceWithCoupon != null;
  if (gravou) {
    return {
      estimado: false,
      coupon: h.coupon || null,
      preco: num(h.sentPrice) ?? num(h.price),
      comCupom: num(h.priceWithCoupon),
      rotulo: h.couponLabel || null,
    };
  }
  const e = await estimar(h).catch(() => null);
  return {
    estimado: true,
    coupon: e?.coupon || null,
    preco: num(h.price),
    comCupom: e?.comCupom ?? null,
    rotulo: e?.rotulo || null,
  };
}

// A conta de hoje para um envio antigo: o melhor cupom com palavra que o catálogo
// conhece para o produto — o mesmo caminho do envio.
async function estimarPadrao(h) {
  const { couponRuleForItem } = require("../scheduler");
  const { detalheDoCupom } = require("./price");
  const regra = await couponRuleForItem({ store: h.store, key: h.productKey, price: h.price, coupon: null });
  if (!regra?.code) return null;
  const d = detalheDoCupom(h.price, regra);
  return { coupon: regra.code, comCupom: d?.final ?? null, rotulo: d?.rotulo ?? null };
}

async function alvos(cfg, { agora = Date.now(), estimar = estimarPadrao } = {}) {
  const desde = new Date(agora - cfg.dias * 86400000);
  const grupos = await prisma().group.findMany({ select: { id: true, name: true, scraping: true } });
  const escolhidas = new Set(cfg.campanhas || []);
  const porId = new Map();
  for (const g of grupos) {
    const id = String(g.id);
    if (cfg.soRepasse && g.scraping?.kind !== "repasse") continue;
    if (escolhidas.size && !escolhidas.has(id)) continue;
    porId.set(id, g);
  }
  if (!porId.size) return { alvos: [], total: 0, campanhas: 0, envios: 0, semCupom: 0, estimados: 0 };

  const linhas = await prisma().groupHistory.findMany({
    where: {
      sentAt: { gte: desde },
      store: "Mercado Livre",
      groupId: { in: [...porId.keys()].map(id => BigInt(id)) },
    },
    orderBy: { sentAt: "desc" },
    take: HISTORICO_MAX,
  });

  const lista = [];
  const vistos = new Set();
  let semCupom = 0;
  for (const h of linhas) {
    if (!h.link) continue;
    const p = await prometido(h, estimar);
    if (!p.coupon) { semCupom += 1; continue; }
    // Do mais recente pro mais antigo: o que fica é o último envio.
    const chave = `${h.productKey}\n${p.coupon.toUpperCase()}`;
    if (cfg.umPorProduto && vistos.has(chave)) continue;
    vistos.add(chave);
    const g = porId.get(String(h.groupId));
    lista.push({
      historyId: String(h.id),
      groupId: String(h.groupId),
      groupName: g?.name || null,
      key: h.productKey,
      name: h.name,
      img: h.img || null,
      link: h.link,
      coupon: p.coupon.toUpperCase(),
      sentAt: h.sentAt.toISOString(),
      estimado: p.estimado,
      prometidoPreco: p.preco,
      prometidoComCupom: p.comCupom,
      rotulo: p.rotulo,
    });
  }
  const escolhidos = lista.slice(0, cfg.maxProdutos);
  return {
    alvos: escolhidos,
    total: escolhidos.length,
    // Quantos havia antes do teto: a tela diz "20 de 57".
    disponiveis: lista.length,
    campanhas: new Set(escolhidos.map(a => a.groupId)).size,
    envios: linhas.length,
    semCupom,
    estimados: escolhidos.filter(a => a.estimado).length,
  };
}

// ── A leitura de um produto ──────────────────────────────────────────────

// Falhas do teste que são resposta do ML sobre o CUPOM (ele não pegou), e não
// "não deu pra chegar lá".
const MOTIVOS_DO_CUPOM = new Set(["indisponivel", "erro-do-site", "sem-confirmacao"]);

// O desconto que o ML deu por ESTE cupom neste carrinho: o `given_discount` do
// cupom na página dos cupons (pela campanha que o teste identificou; sem ela, o
// único aplicado). Na falta, o desconto do resumo da compra — que soma todos os
// cupons em uso, por isso vem marcado.
function descontoDoMl(material, r) {
  const pagina = material?.htmlCupons ? parseCheckoutCupons(material.htmlCupons) : { ok: false, cupons: [] };
  if (pagina.ok) {
    const aplicados = pagina.cupons.filter(c => c.aplicado);
    const cupom = (r.campaignId && pagina.cupons.find(c => String(c.campaignId) === String(r.campaignId)))
      || (aplicados.length === 1 ? aplicados[0] : null);
    if (cupom && cupom.descontoNoCarrinho != null) {
      return { valor: cupom.descontoNoCarrinho, fonte: "cupom", cupom };
    }
  }
  if (r.desconto_no_pedido != null) return { valor: r.desconto_no_pedido, fonte: "resumo", cupom: null };
  return { valor: null, fonte: null, cupom: null };
}

// Pura. `alvo` é um item de `alvos()`; `material` o que a extensão devolveu.
// diferenca = prometido − real: positiva, a mensagem disse MAIS CARO do que o ML
// cobra; negativa, prometeu mais barato do que o cliente vai pagar (o caso grave).
function interpretarConferencia(alvo, material, { toleranciaReais = 0.1 } = {}) {
  const a = alvo || {};
  const r = interpretar(material, a.coupon);
  const precoPagina = num(material?.produto?.price);
  const base = {
    precoPagina,
    descontoMl: null,
    realComCupom: null,
    totalCheckout: r.total_final ?? null,
    diferenca: null,
    muro: !!r.bloqueio,
    detalhe: {
      statusCupom: r.status,
      motivoCupom: r.motivo,
      mensagemSite: r.mensagem_site,
      desconto: r.desconto,
      compraMinima: r.compra_minima,
      limiteDesconto: r.limite_desconto,
      vencimento: r.vencimento,
      cuponsEmUso: r.cupons_em_uso,
      campaignId: r.campaignId,
      variacao: r.variacao,
      bloqueio: r.bloqueio,
    },
  };

  if (r.status === "falha") {
    const doCupom = MOTIVOS_DO_CUPOM.has(r.motivo);
    return {
      ...base,
      status: doCupom ? "cupom-nao-pegou" : "falhou",
      motivo: doCupom
        ? `O cupom ${a.coupon} não pegou no checkout. ${mensagemDe(r)}${a.prometidoComCupom != null ? ` A mensagem prometeu ${reais(a.prometidoComCupom)} com ele.` : ""}`
        : mensagemDe(r),
    };
  }

  const d = descontoDoMl(material, r);
  base.descontoMl = d.valor;
  base.detalhe.fonteDesconto = d.fonte;
  if (precoPagina == null || d.valor == null) {
    return {
      ...base,
      status: "falhou",
      motivo: precoPagina == null
        ? "O cupom pegou, mas não deu pra ler o preço na página do produto."
        : "O cupom pegou, mas não deu pra ler quanto o ML descontou.",
    };
  }

  const real = centavos(precoPagina - d.valor);
  base.realComCupom = real;
  const tol = Math.max(0, Number(toleranciaReais) || 0) + 0.005;

  // A mensagem saiu sem desconto (a conta não calculou o cupom), mas o ML deu.
  if (a.prometidoComCupom == null) {
    const prometeu = num(a.prometidoPreco);
    base.diferenca = prometeu != null ? centavos(prometeu - real) : null;
    if (d.valor > tol) {
      return {
        ...base,
        status: "prometeu-sem-desconto",
        motivo: `A mensagem saiu sem o desconto do cupom (${reais(prometeu)}), mas o ML desconta ${reais(d.valor)} e cobra ${reais(real)}. O sistema não sabia as regras deste cupom na hora do envio.`,
      };
    }
  }

  const prometido = num(a.prometidoComCupom ?? a.prometidoPreco);
  base.diferenca = prometido != null ? centavos(prometido - real) : null;
  if (base.diferenca == null || Math.abs(base.diferenca) <= tol) {
    return { ...base, status: "ok", motivo: `Bate: a mensagem disse ${reais(prometido)} e o ML cobra ${reais(real)}.` };
  }

  // Divergiu: o porquê mais provável, na ordem em que as causas se excluem.
  const porques = [];
  const prometeuPreco = num(a.prometidoPreco);
  if (prometeuPreco != null && Math.abs(prometeuPreco - precoPagina) > tol) {
    porques.push(`o preço do produto mudou (a mensagem partiu de ${reais(prometeuPreco)}, a página mostra ${reais(precoPagina)})`);
  }
  const descontoCalculado = prometeuPreco != null && a.prometidoComCupom != null ? centavos(prometeuPreco - a.prometidoComCupom) : null;
  if (descontoCalculado != null && Math.abs(descontoCalculado - d.valor) > tol) {
    let p = `o desconto é outro (a conta deu ${reais(descontoCalculado)}, o ML deu ${reais(d.valor)})`;
    const limite = r.limite_desconto ?? d.cupom?.maxDiscount ?? null;
    if (limite != null && Math.abs(d.valor - limite) <= tol) p += ` — bateu no teto de ${reais(limite)} do cupom`;
    if (d.fonte === "resumo" && r.cupons_em_uso && !/^1\//.test(r.cupons_em_uso)) p += ` — há ${r.cupons_em_uso} cupons em uso no pedido, o desconto do resumo soma todos`;
    porques.push(p);
  }
  const lado = base.diferenca < 0 ? "mais barato do que o ML cobra" : "mais caro do que o ML cobra";
  return {
    ...base,
    status: "divergente",
    motivo: `A mensagem disse ${reais(prometido)}, ${lado} (${reais(real)}).${porques.length ? ` Motivo provável: ${porques.join("; ")}.` : ""}${a.estimado ? " (Envio antigo: o prometido foi refeito com as regras de hoje.)" : ""}`,
  };
}

// ── As rodadas ───────────────────────────────────────────────────────────

const CONTADOR = { ok: "ok", divergente: "divergente", "prometeu-sem-desconto": "divergente", "cupom-nao-pegou": "naoPegou", falhou: "falhou" };
const STATUS_FIM = new Set(["concluida", "cancelada", "interrompida"]);

const runParaJson = (r) => r && ({ ...r, id: String(r.id) });
const itemParaJson = (i) => i && ({ ...i, id: String(i.id), runId: String(i.runId) });

async function abrirRun({ config, total }) {
  // Rodada que ficou "rodando" é a de uma aba que fechou no meio: só uma aba
  // confere por vez, então abrir outra encerra a anterior.
  await prisma().cupomTesteRun.updateMany({
    where: { status: "rodando" },
    data: { status: "interrompida", finishedAt: new Date(), motivoFim: "A página foi fechada antes do fim." },
  });
  const run = await prisma().cupomTesteRun.create({
    data: { status: "rodando", config: config || {}, total: Math.max(0, parseInt(total, 10) || 0) },
  });
  return runParaJson(run);
}

function idDe(v) {
  try { return BigInt(String(v)); } catch { throw Object.assign(new Error("Rodada inválida."), { status: 400 }); }
}

async function registrarItem({ runId, alvo, material = null, erro = null, durationMs = null, toleranciaReais }) {
  const id = idDe(runId);
  const a = alvo || {};
  if (!a.link || !a.coupon) throw Object.assign(new Error("Faltou o link ou o cupom do produto."), { status: 400 });
  const run = await prisma().cupomTesteRun.findUnique({ where: { id } });
  if (!run) throw Object.assign(new Error("Rodada não encontrada."), { status: 404 });
  const tol = toleranciaReais ?? run.config?.toleranciaReais ?? 0.1;

  const c = material && typeof material === "object"
    ? interpretarConferencia(a, material, { toleranciaReais: tol })
    : {
      status: "falhou", motivo: `A extensão não terminou: ${String(erro || "sem resposta").slice(0, 300)}`,
      precoPagina: null, descontoMl: null, realComCupom: null, totalCheckout: null, diferenca: null, muro: false, detalhe: {},
    };

  const item = await prisma().cupomTesteItem.create({
    data: {
      runId: id,
      groupId: a.groupId ? String(a.groupId) : null,
      groupName: a.groupName ? String(a.groupName).slice(0, 200) : null,
      productKey: a.key ? String(a.key) : null,
      name: a.name ? String(a.name).slice(0, 300) : null,
      img: a.img ? String(a.img).slice(0, 1000) : null,
      link: String(a.link).slice(0, 2000),
      coupon: String(a.coupon).toUpperCase().slice(0, 40),
      sentAt: a.sentAt ? new Date(a.sentAt) : null,
      estimado: !!a.estimado,
      prometidoPreco: num(a.prometidoPreco),
      prometidoComCupom: num(a.prometidoComCupom),
      precoPagina: c.precoPagina,
      descontoMl: c.descontoMl,
      realComCupom: c.realComCupom,
      totalCheckout: c.totalCheckout,
      diferenca: c.diferenca,
      status: c.status,
      motivo: c.motivo ? String(c.motivo).slice(0, 1000) : null,
      detalhe: c.detalhe || {},
      durationMs: Number.isFinite(Number(durationMs)) ? Math.round(Number(durationMs)) : null,
    },
  });
  const campo = CONTADOR[c.status] || "falhou";
  await prisma().cupomTesteRun.update({
    where: { id },
    data: { feitos: { increment: 1 }, [campo]: { increment: 1 } },
  });
  return { item: itemParaJson(item), muro: c.muro };
}

async function fecharRun({ runId, status, motivo = null }) {
  const id = idDe(runId);
  const st = STATUS_FIM.has(status) ? status : "concluida";
  const r = await prisma().cupomTesteRun.updateMany({
    where: { id, status: "rodando" },
    data: { status: st, finishedAt: new Date(), motivoFim: motivo ? String(motivo).slice(0, 500) : null },
  });
  return { fechada: r.count > 0 };
}

async function listarRuns({ limit = 20 } = {}) {
  const runs = await prisma().cupomTesteRun.findMany({
    orderBy: { startedAt: "desc" },
    take: Math.min(100, Math.max(1, parseInt(limit, 10) || 20)),
  });
  return runs.map(runParaJson);
}

async function detalheRun(runId) {
  const id = idDe(runId);
  const run = await prisma().cupomTesteRun.findUnique({ where: { id } });
  if (!run) throw Object.assign(new Error("Rodada não encontrada."), { status: 404 });
  const itens = await prisma().cupomTesteItem.findMany({ where: { runId: id }, orderBy: { id: "asc" } });
  return { run: runParaJson(run), itens: itens.map(itemParaJson) };
}

module.exports = {
  alvos, prometido, interpretarConferencia, descontoDoMl,
  abrirRun, registrarItem, fecharRun, listarRuns, detalheRun,
};
