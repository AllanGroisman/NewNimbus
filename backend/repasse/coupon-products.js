// Os produtos que chegaram com um cupom nos grupos do repasse, ligados a ele.
//
// O teste no checkout liga ao cupom UM produto — aquele em que o código foi
// aplicado. Os outros que o grupo mandou com o mesmo código ficavam só no log de
// captura, e o cupom aprovado não aparecia em nenhum deles. Aqui cada um entra no
// catálogo (se ainda não estiver) e ganha o vínculo `origem: "repasse"`: o mais
// fraco de todos, porque quem disse que o cupom vale ali foi o grupo, não o ML.
// Checkout e vitrine promovem esse vínculo quando confirmam (coupons/pg.js:
// vincularDoRepasse).
//
// Idempotente, e chamado de três lugares: o teste no checkout que aprova o código,
// a captura de um produto novo com código já aprovado e a rodada do robô, que
// cobre as campanhas que só entraram no sistema depois (coupon-autotest.js).
const { prisma } = require("../db");

// O produto do repasse quase nunca passou pelo scraping, e o `vincularPorCheckout`
// só carimba linhas do catálogo que JÁ existem — o cupom ficava ligado a um
// produto que ninguém via. Então, se o anúncio ainda não está no catálogo, ele
// entra com os dados que se tem dele: os que a extensão leu na PDP
// (cupom-checkout.js:naPagina_produto) ou os da captura do repasse.
// Se já está, a linha fica como está: quem a atualiza é o scraping.
//
// Só cria com nome, foto e preço — a mesma régua do capture.js pra aceitar um
// link como produto. Linha do catálogo sem preço nem foto não serve pra envio e
// só polui a vitrine. `existe` diz se o produto está (ou ficou) no catálogo.
async function garantirNoCatalogo({ produto, productUrl, productKeys }) {
  const { mlAnuncioIdFromUrl } = require("../catalog/product-key");
  const anuncio = mlAnuncioIdFromUrl(productUrl);
  const existe = await prisma().catalogProduct.findFirst({
    where: { OR: [{ key: { in: productKeys } }, ...(anuncio ? [{ mlAnuncioId: anuncio }] : [])] },
    select: { key: true },
  });
  if (existe) return { criado: false, existe: true };
  if (!produto?.name || !produto.img || produto.price == null) return { criado: false, existe: false };

  const { upgradeMLImageUrl, normalizeSoldText } = require("../scraping/scraper");
  const r = await require("../catalog/pg").upsertProducts([{
    name: String(produto.name).trim(),
    link: productUrl,
    img: produto.img ? upgradeMLImageUrl(produto.img) : null,
    price: produto.price ?? null,
    originalPrice: produto.originalPrice ?? null,
    discount: produto.discount ?? null,
    sold: normalizeSoldText(produto.sold),
    store: "Mercado Livre",
    category: null,
  }]);
  return { criado: r.inserted > 0, existe: true };
}

// Um por link, com os dados da captura mais recente que os tiver.
async function linksCapturados(code, desde) {
  return prisma().$queryRaw`
    SELECT COALESCE(l."resolvedUrl", l."rawUrl") AS url,
           (ARRAY_AGG(l."productName"   ORDER BY l."createdAt" DESC) FILTER (WHERE l."productName"   IS NOT NULL))[1] AS "productName",
           (ARRAY_AGG(l."productImg"    ORDER BY l."createdAt" DESC) FILTER (WHERE l."productImg"    IS NOT NULL))[1] AS "productImg",
           (ARRAY_AGG(l."price"         ORDER BY l."createdAt" DESC) FILTER (WHERE l."price"         IS NOT NULL))[1] AS price,
           (ARRAY_AGG(l."originalPrice" ORDER BY l."createdAt" DESC) FILTER (WHERE l."originalPrice" IS NOT NULL))[1] AS "originalPrice",
           (ARRAY_AGG(l."discount"      ORDER BY l."createdAt" DESC) FILTER (WHERE l."discount"      IS NOT NULL))[1] AS discount,
           (ARRAY_AGG(l."sold"          ORDER BY l."createdAt" DESC) FILTER (WHERE l."sold"          IS NOT NULL))[1] AS sold
      FROM "repasse_capture_log" l
     WHERE l."coupon" = ${code}
       AND l."store" = 'Mercado Livre'
       AND l."createdAt" >= ${desde}
     GROUP BY 1
  `;
}

async function ligarProdutosDoRepasse(code, { dias = 90 } = {}) {
  const c = String(code ?? "").trim().toUpperCase();
  if (!c) return { pulado: "sem-codigo" };

  const chk = await prisma().mlCouponCode.findUnique({ where: { code: c }, select: { verdict: true, campaignId: true } });
  if (chk?.verdict !== "valid" || !chk.campaignId) return { pulado: "nao-aprovado" };
  // O vínculo tem FK para a campanha: sem ela aqui, só depois do "Trazer campanha".
  const cupom = await prisma().mlCoupon.findUnique({ where: { campaignId: chk.campaignId }, select: { expiresAt: true } });
  if (!cupom) return { pulado: "campanha-fora" };
  if (cupom.expiresAt && new Date(cupom.expiresAt) < new Date()) return { pulado: "vencido" };

  const { chavesCandidatas } = require("../coupons/quick-check");
  const { mlUrlSpace } = require("../catalog/product-key");
  const desde = new Date(Date.now() - Math.max(1, Number(dias) || 90) * 86400000);
  const itens = [];
  let noCatalogo = 0;
  for (const l of await linksCapturados(c, desde)) {
    // Só página de produto: um meli.la que nunca resolveu, uma vitrine ou uma
    // página de oferta também ganham chave (o productKey faz hash de qualquer
    // URL), e virariam produto falso no catálogo.
    if (!l.url || !mlUrlSpace(l.url)) continue;
    const productKeys = chavesCandidatas(l.url);
    if (!productKeys.length) continue;
    const { criado, existe } = await garantirNoCatalogo({
      produto: {
        name: l.productName, img: l.productImg, price: l.price,
        originalPrice: l.originalPrice, discount: l.discount, sold: l.sold,
      },
      productUrl: l.url,
      productKeys,
    });
    // Link que não é (nem virou) produto do catálogo não ganha vínculo: o CAPTCHA,
    // a landing e o "sem oferta" chegam aqui sem dados, e o vínculo apontaria pro
    // nada — inflando o "N produtos" da campanha.
    if (!existe) continue;
    if (criado) noCatalogo += 1;
    itens.push({ productKeys, productUrl: l.url });
  }

  const r = await require("../coupons/pg").vincularDoRepasse(chk.campaignId, itens);
  return { campaignId: chk.campaignId, produtos: itens.length, vinculados: r.vinculados, novos: r.novos, noCatalogo };
}

// O disparo da captura. Uma mensagem vira uma linha de log POR CAMPANHA que a
// recebeu, então o mesmo código chega aqui várias vezes no mesmo instante: roda
// uma vez por código, e mais uma no fim se outra captura dele chegou no meio.
const _emCurso = new Map(); // code → "de novo?"

function ligarEmSegundoPlano(code) {
  if (process.env.NODE_ENV === "test") return;
  const c = String(code ?? "").trim().toUpperCase();
  if (!c) return;
  if (_emCurso.has(c)) { _emCurso.set(c, true); return; }
  _emCurso.set(c, false);
  setImmediate(async () => {
    try {
      do {
        _emCurso.set(c, false);
        // O mesmo período da rodada do robô: a config é a da aba, não um 90 fixo.
        await ligarProdutosDoRepasse(c, { dias: require("./coupon-autotest-config").readConfig().diasDeBusca });
      } while (_emCurso.get(c));
    } catch (err) {
      console.error(`[repasse] produtos do repasse no cupom ${c}: ${err.message}`);
    } finally {
      _emCurso.delete(c);
    }
  });
}

module.exports = { ligarProdutosDoRepasse, ligarEmSegundoPlano, garantirNoCatalogo };
