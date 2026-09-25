// O teste de um cupom do repasse NO CHECKOUT do produto que chegou com ele — o
// lado do servidor do comando `cupom-no-checkout` da extensão (extension/cupom-checkout.js).
//
// Até aqui o cupom do repasse era testado como PALAVRA solta em /cupons, pelo
// Chrome do servidor (scraping/ml-cupons.js:checkCouponWord). O ML responde a esse
// Chrome com CAPTCHA ou "Tivemos um problema", e todo cupom da aba virava "o ML não
// respondeu". Agora quem anda é a aba do admin: produto → "Comprar agora" → o
// modal "Cupons" do checkout (um iframe `/cupons/cho`) → digita o código → lê o
// que o ML respondeu. A extensão só colhe; a leitura mora aqui, pura e testável.
//
// O resultado segue o formato combinado na task 7:
//   { codigo, status: "ja_aplicado" | "aplicado_agora" | "falha", desconto,
//     compra_minima, limite_desconto, vencimento, alerta, desconto_no_pedido,
//     total_final, mensagem_site }
// mais `motivo` (por que falhou, em código), `bloqueio` (captcha/login/…) e
// `campaignId` quando a página dos cupons diz qual campanha é.
const { cupomNoResumo } = require("../coupons/product-coupons");
const { parseCheckoutCupons } = require("../coupons/checkout-list");

// As respostas do campo "Insira seu código aqui" que já se conhecem.
const JA_ADICIONADO_RE = /j[áa] foi adicionado/i;
// O ML não diferencia código inexistente de esgotado/vencido: é esta frase pros dois.
const INDISPONIVEL_RE = /n[ãa]o est[áa] mais dispon[íi]vel/i;

function dinheiro(txt) {
  if (txt == null) return null;
  const s = String(txt).replace(/[^\d.,]/g, "");
  if (!s) return null;
  // "1.234,56" / "59" / "59,90"
  const n = Number(s.replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

// O total do resumo de página única. "Você pagará" / "Total", e quando há preço
// riscado vêm dois valores seguidos — o último é o que se paga.
function totalDoResumo(texto) {
  const t = String(texto || "").replace(/\s+/g, " ");
  let bloco = null;
  for (const m of t.matchAll(/(?:\btotal\b|voc[êe] pagar[áa])\s*:?\s*((?:R\$\s?[\d.]+(?:,\d{1,2})?\s*){1,3})/gi)) bloco = m[1];
  if (!bloco) return null;
  const valores = bloco.match(/R\$\s?[\d.]+(?:,\d{1,2})?/g) || [];
  return dinheiro(valores[valores.length - 1]);
}

// As condições do cartão do cupom ("15% OFF", "Compra mínima R$ 59 | Limite de
// R$ 50 | Venc. 27/09/2026", "Está esgotando!"). Pura, texto entra.
function condicoesDoCartao(texto) {
  const t = String(texto || "");
  const pct = t.match(/(\d{1,3})\s*%\s*OFF/i);
  const fixo = !pct && t.match(/R\$\s?([\d.]+(?:,\d{1,2})?)\s*OFF/i);
  const venc = t.match(/Venc(?:e|imento)?\.?\s*(?:em\s*)?(\d{2})\/(\d{2})\/(\d{4})/i);
  const minima = t.match(/Compra m[íi]nima\s*(?:de\s*)?R\$\s?([\d.]+(?:,\d{1,2})?)/i);
  const limite = t.match(/Limite\s*(?:de\s*)?R\$\s?([\d.]+(?:,\d{1,2})?)/i);
  const alerta = t.match(/(Est[áa] esgotando!?|[ÚU]ltimas unidades!?|Vence hoje!?)/i);
  return {
    desconto: pct ? `${pct[1]}% OFF` : (fixo ? `R$ ${fixo[1]} OFF` : null),
    compra_minima: minima ? dinheiro(minima[1]) : null,
    limite_desconto: limite ? dinheiro(limite[1]) : null,
    vencimento: venc ? `${venc[3]}-${venc[2]}-${venc[1]}` : null,
    alerta: alerta ? alerta[1] : null,
  };
}

// O nome que o ML dá ao cupom no cartão: a primeira linha que não é condição nem
// botão. "Com MELIKIDS" → "MELIKIDS"; "Cupom Site\n10% OFF\n…" → "Cupom Site".
// Só para mostrar e conferir — nada decide por ele.
const LINHA_NAO_NOME = /(%\s*OFF|R\$\s?[\d.,]+\s*OFF|compra m[íi]nima|limite|venc|^aplica|est[áa] esgotando|[úu]ltimas unidades|vence hoje)/i;
function nomeDoCartao(texto) {
  for (const bruta of String(texto || "").split(/\n+/)) {
    const linha = bruta.replace(/\s+/g, " ").trim();
    if (!linha || LINHA_NAO_NOME.test(linha)) continue;
    return linha.replace(/^com\s+/i, "").slice(0, 120) || null;
  }
  return null;
}

// A campanha do código, pelo modelo da página dos cupons. O modelo quase nunca traz
// o código (`code: ""` na captura real), então o plano B é o cartão: entre os
// cupons APLICADOS, o único cujas condições (desconto, mínimo, teto) batem com as
// que o cartão "Com <CÓDIGO>" mostrou. Mais de um batendo = não dá pra saber.
function campanhaDoCodigo(html, codigo, cond = {}) {
  if (!html) return null;
  const r = parseCheckoutCupons(html);
  if (!r.ok) return null;
  const alvo = String(codigo || "").toUpperCase();
  const porCodigo = r.cupons.find(c => String(c.code || "").toUpperCase() === alvo);
  if (porCodigo) return porCodigo.campaignId;

  const pct = String(cond.desconto || "").match(/^(\d+)%/);
  const fixo = String(cond.desconto || "").match(/^R\$ ([\d.,]+)/);
  const valor = pct ? Number(pct[1]) : (fixo ? dinheiro(fixo[1]) : null);
  if (valor == null) return null;
  const bate = (a, b) => a == null || b == null || Math.abs(a - b) < 0.01;
  const candidatos = r.cupons.filter(c => c.aplicado
    && (pct ? c.kind === "percent" : c.kind !== "percent")
    && bate(c.value, valor)
    && bate(c.minPurchase, cond.compra_minima)
    && bate(c.maxDiscount, cond.limite_desconto));
  return candidatos.length === 1 ? candidatos[0].campaignId : null;
}

// Antes sem "Cupons (N/M em uso)" = nenhum cupom (o link era "Inserir código do cupom").
function maisCuponsEmUso(resumoAntes, resumoDepois) {
  const depois = cupomNoResumo(resumoDepois);
  if (!depois) return false;
  const antes = cupomNoResumo(resumoAntes);
  return depois.emUso > (antes ? antes.emUso : 0);
}

const MOTIVOS = {
  muro: "O ML pediu verificação e ela não foi resolvida.",
  "nao-e-produto": "O link não abriu a página de um produto.",
  landing: "Link de afiliado: o \"Ir para o produto\" não abriu a página do produto.",
  variacao: "Variação obrigatória não selecionada.",
  "sem-checkout": "Não chegou ao checkout do produto.",
  "modal-nao-abriu": "Chegou ao checkout, mas o quadro \"Cupons\" não abriu.",
  "sem-campo": "O quadro \"Cupons\" abriu sem o campo do código.",
  "sem-confirmacao": "Inseriu o código e o ML não mostrou nem erro nem o cupom aplicado.",
  indisponivel: "O ML disse que o cupom não está disponível (não existe, esgotou ou venceu).",
  "erro-do-site": "O ML recusou o código.",
};

function interpretar(material, code) {
  const m = material || {};
  const codigo = String(code || "").trim().toUpperCase();
  const r = {
    codigo,
    status: "falha",
    desconto: null,
    compra_minima: null,
    limite_desconto: null,
    vencimento: null,
    alerta: null,
    desconto_no_pedido: null,
    total_final: null,
    cupons_em_uso: null,
    variacao: m.variacao || null,
    mensagem_site: null,
    motivo: null,
    bloqueio: null,
    campaignId: null,
  };

  if (m.muro) { r.motivo = "muro"; r.bloqueio = m.muro; return r; }
  if (m.notProductPage) { r.motivo = m.landing ? "landing" : "nao-e-produto"; return r; }
  if (m.variacaoFaltando && !m.checkout?.reached) {
    r.motivo = "variacao";
    r.mensagem_site = String(m.variacaoFaltando).slice(0, 200);
    return r;
  }
  if (!m.checkout?.reached) {
    r.motivo = "sem-checkout";
    r.mensagem_site = m.checkout?.blockedReason || null;
    return r;
  }
  if (!m.modal?.aberto) { r.motivo = "modal-nao-abriu"; return r; }

  const antes = m.cartaoAntes || null;
  const depois = m.cartaoDepois || null;
  // "Erro" é o rótulo visual do campo (o Andes o põe escondido antes da mensagem).
  const erro = String(m.erroCampo || "").replace(/\s+/g, " ").trim().replace(/^Erro[:\s]+(?=\p{Lu})/u, "") || null;

  if (antes?.aplicado) {
    r.status = "ja_aplicado";
  } else if (erro) {
    r.mensagem_site = erro;
    if (JA_ADICIONADO_RE.test(erro)) r.status = "ja_aplicado";
    else r.motivo = INDISPONIVEL_RE.test(erro) ? "indisponivel" : "erro-do-site";
  } else if (!m.modal?.campo && !antes) {
    r.motivo = "sem-campo";
  } else if (depois?.aplicado) {
    r.status = "aplicado_agora";
  } else if (maisCuponsEmUso(m.resumoAntes, m.resumoDepois)) {
    // O cartão não foi reconhecido, mas o resumo da compra ganhou um cupom em uso
    // depois do "Inserir" — e o campo não reclamou.
    r.status = "aplicado_agora";
  } else {
    r.motivo = "sem-confirmacao";
    // O que a tela mostrou: sem isto, "não mostrou nem erro nem o cupom" não tem
    // como ser conferido depois.
    r.diagnostico = {
      textoDoModal: String(m.textoDoModal || "").slice(0, 1500) || null,
      aplicados: (m.aplicadosDepois || []).map(t => String(t).slice(0, 300)),
      resumoDepois: String(m.resumoDepois || "").slice(0, 500) || null,
    };
  }

  const cartao = depois?.texto ? depois : antes;
  if (cartao?.texto) Object.assign(r, condicoesDoCartao(cartao.texto));
  if (r.status !== "falha" && cartao?.texto) {
    r.cartao = { nome: nomeDoCartao(cartao.texto), texto: String(cartao.texto).slice(0, 300) };
  }

  const resumo = cupomNoResumo(m.resumoDepois) || cupomNoResumo(m.resumoAntes);
  if (resumo) {
    r.cupons_em_uso = `${resumo.emUso}/${resumo.disponiveis}`;
    r.desconto_no_pedido = resumo.desconto;
  }
  r.total_final = totalDoResumo(m.resumoDepois);
  r.campaignId = r.status === "falha" ? null : campanhaDoCodigo(m.htmlCupons, codigo, r);
  return r;
}

// O resultado no vocabulário de `ml_coupon_codes.verdict`, que a tela e o robô já
// entendem. "Não chegou lá" continua indeterminado — mas agora com o porquê.
function verdictDe(r) {
  if (!r) return "indeterminado";
  if (r.status === "ja_aplicado" || r.status === "aplicado_agora") return "valid";
  if (r.motivo === "indisponivel") return "invalid";
  return "indeterminado";
}

// A frase da coluna "Situação".
function mensagemDe(r) {
  if (!r) return null;
  if (r.status !== "falha") {
    const partes = [r.status === "ja_aplicado" ? "Já estava aplicado no checkout" : "Aplicado no checkout"];
    if (r.desconto) partes.push(r.desconto);
    if (r.compra_minima != null) partes.push(`mínimo R$ ${r.compra_minima}`);
    if (r.limite_desconto != null) partes.push(`limite R$ ${r.limite_desconto}`);
    if (r.vencimento) partes.push(`vence ${r.vencimento.split("-").reverse().join("/")}`);
    if (r.desconto_no_pedido != null) partes.push(`-R$ ${r.desconto_no_pedido.toFixed(2).replace(".", ",")} no pedido`);
    if (r.variacao) partes.push(`variação: ${r.variacao}`);
    if (r.cartao?.nome && r.cartao.nome.toUpperCase() !== r.codigo) partes.push(`cartão "${r.cartao.nome}"`);
    return partes.join(" · ");
  }
  const base = r.motivo === "muro" ? `O ML pediu verificação (${r.bloqueio}) e ela não foi resolvida.` : (MOTIVOS[r.motivo] || "Falhou.");
  return r.mensagem_site ? `${base} ML: "${r.mensagem_site}"` : base;
}

module.exports = { interpretar, verdictDe, mensagemDe, condicoesDoCartao, nomeDoCartao, totalDoResumo, campanhaDoCodigo, dinheiro };
