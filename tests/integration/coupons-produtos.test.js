// A ETAPA 2 dos cupons: quem ainda precisa de produtos, e o que acontece quando a
// vitrine chega.
//
// Ela é um botão separado da varredura da lista porque é a única que ESCREVE na
// conta do ML: o "Eu quero" que faz a vitrine existir é irreversível, e a conta é
// a mesma do Hub de Afiliados. O que este arquivo protege:
//
//   - a fila não repete trabalho já feito (`productsSyncedAt`);
//   - quem precisa de clique fica SEPARADO de quem só precisa ser lido, para a
//     tela poder avisar antes;
//   - uma vitrine cortada pelo teto entra como PARCIAL, nunca como lista fechada —
//     senão o sistema passa a dizer "fora da vitrine" para produto que o cupom
//     cobre;
//   - apagar um cupom limpa o carimbo dele no catálogo, que é coluna solta sem FK.
import { describe, it, expect, beforeEach } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { catalog, createTestUser, auth as authMod } from "../helpers/app.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const backendDir = path.resolve(__dirname, "..", "..", "backend");
const coupons = require(path.join(backendDir, "coupons"));
const sync = require(path.join(backendDir, "coupons", "sync.js"));
const { productKey } = require(path.join(backendDir, "catalog", "product-key"));

const AMANHA = () => new Date(Date.now() + 864e5).toISOString();
const base = { kind: "percent", value: 20, expiresAt: AMANHA() };

// Três situações que a fila precisa distinguir:
//   PRONTO   — tem vitrine para abrir e nunca foi raspado.
//   ATIVAR   — cupom de campanha sem `containerUrl`: o ML só dá a URL depois do
//              "Eu quero", então ele custa uma escrita na conta.
//   RASPADO  — já tem vitrine; não pode voltar para a fila.
const PRONTO = "9920001";
const ATIVAR = "9920002";
const RASPADO = "9920003";

const produto = {
  name: "Produto do cupom", link: "https://www.mercadolivre.com.br/produto/p/MLB7790001",
  store: "Mercado Livre", category: "gamer", price: 100, discount: 40,
};

async function semear() {
  await coupons.upsertCoupons([
    { ...base, campaignId: PRONTO, title: "Pronto", scope: "campaign", activated: true, containerUrl: "https://lista.mercadolivre.com.br/_Container_9920001" },
    { ...base, campaignId: ATIVAR, title: "Falta aceitar", scope: "campaign", activated: false, containerUrl: null },
    { ...base, campaignId: RASPADO, title: "Já raspado", scope: "campaign", activated: true, containerUrl: "https://lista.mercadolivre.com.br/_Container_9920003" },
  ]);
  await catalog.upsertProducts([produto]);
  // `origem: "vitrine"` é o que carimba o `productsSyncedAt` — é ele, e não a
  // contagem de vínculos, que diz "já buscado" (amostra e landing também viram
  // vínculo, e nenhuma das duas é lista fechada).
  await coupons.replaceCouponProducts(RASPADO, [{ productKey: productKey(produto), productUrl: produto.link }]);
  await coupons.syncCatalogCoupons();
}

describe("alvosDeProdutos — a fila da etapa 2", () => {
  beforeEach(semear);

  it("separa quem só precisa ser lido de quem precisa de uma escrita na conta", async () => {
    const r = await sync.alvosDeProdutos({});
    expect(r.prontos.map(c => c.campaignId)).toEqual([PRONTO]);
    expect(r.precisamAtivar.map(c => c.campaignId)).toEqual([ATIVAR]);
    // O já raspado não aparece em lugar nenhum.
    expect(r.total).toBe(2);
  });

  it("o cupom já raspado não volta para a fila", async () => {
    const antes = await sync.alvosDeProdutos({});
    expect(antes.prontos.map(c => c.campaignId)).not.toContain(RASPADO);

    // E o que acabou de ser raspado sai da fila na leitura seguinte.
    await coupons.replaceCouponProducts(PRONTO, [{ productKey: productKey(produto), productUrl: produto.link }]);
    const depois = await sync.alvosDeProdutos({});
    expect(depois.prontos).toEqual([]);
  });

  it("cupom vencido não entra: abrir a vitrine dele é aba aberta à toa", async () => {
    await coupons.upsertCoupons([{
      ...base, campaignId: "9920009", title: "Vencido", scope: "campaign", activated: true,
      containerUrl: "https://lista.mercadolivre.com.br/_Container_9920009",
      expiresAt: new Date(Date.now() - 864e5).toISOString(),
    }]);
    const r = await sync.alvosDeProdutos({});
    expect(r.prontos.map(c => c.campaignId)).not.toContain("9920009");
  });

  it("cupom de loja sem vitrine não entra na fila de ativação", async () => {
    // Ele é AUTOMATIC — já chega aceito. Sem `containerUrl` quer dizer que o ML
    // não deu vitrine nenhuma, e clicar não muda isso.
    await coupons.upsertCoupons([{
      ...base, campaignId: "9920010", title: "Da loja", scope: "store", sellerName: "Agrotrator",
      activated: true, containerUrl: null,
    }]);
    const r = await sync.alvosDeProdutos({});
    expect(r.precisamAtivar.map(c => c.campaignId)).not.toContain("9920010");
  });

  it("com um campaignId, a fila é só daquele cupom", async () => {
    const r = await sync.alvosDeProdutos({ campaignIds: [ATIVAR] });
    expect(r.prontos).toEqual([]);
    expect(r.precisamAtivar.map(c => c.campaignId)).toEqual([ATIVAR]);
  });

  it("leva junto os limites que a tela usa para conduzir o laço", async () => {
    // Vêm daqui e não da tela: um teto escrito em dois lugares diverge.
    const r = await sync.alvosDeProdutos({});
    expect(r.config.maxPaginasVitrine).toBeGreaterThan(0);
    expect(r.config.pausaEntreVitrinesMs).toBeGreaterThan(0);
    expect(r.config).toHaveProperty("activateCoupons");
    expect(r.config).toHaveProperty("maxActivationsPerRun");
  });

  it("com a ativação desligada, o teto vai a zero em vez de mentir", async () => {
    sync.writeConfig({ activateCoupons: false });
    try {
      const r = await sync.alvosDeProdutos({});
      expect(r.config.activateCoupons).toBe(false);
      expect(r.config.maxActivationsPerRun).toBe(0);
    } finally {
      sync.writeConfig({ activateCoupons: true });
    }
  });
});

describe("soSemProdutos — a fila sem os parciais (task 11)", () => {
  beforeEach(semear);

  it("o parcial (só um pedaço) sai da fila, e a contagem diz quantos saíram", async () => {
    // Um pedaço da vitrine: vínculo existe, `productsSyncedAt` não.
    await coupons.replaceCouponProducts(PRONTO, [{ productKey: productKey(produto), productUrl: produto.link }], { origem: "parcial" });

    const todos = await sync.alvosDeProdutos({});
    expect(todos.prontos.map(c => c.campaignId)).toEqual([PRONTO]);
    expect(todos.parciaisFora).toBe(0);

    const so = await sync.alvosDeProdutos({ soSemProdutos: true });
    expect(so.prontos).toEqual([]);
    expect(so.precisamAtivar.map(c => c.campaignId)).toEqual([ATIVAR]);
    expect(so.total).toBe(1);
    expect(so.parciaisFora).toBe(1);
  });

  it("devolve o tamanho da fila nas duas escolhas, qualquer que seja o filtro", async () => {
    await coupons.replaceCouponProducts(PRONTO, [{ productKey: productKey(produto), productUrl: produto.link }], { origem: "parcial" });
    for (const soSemProdutos of [false, true]) {
      const r = await sync.alvosDeProdutos({ soSemProdutos });
      expect(r.incompletos).toBe(2);
      expect(r.semNada).toBe(1);
    }
  });

  it("stats reparte os cupons em completos, parciais e sem nada — e os três somam o total", async () => {
    await coupons.replaceCouponProducts(PRONTO, [{ productKey: productKey(produto), productUrl: produto.link }], { origem: "parcial" });
    const s = await coupons.stats();
    expect(s.produtosPorCupom).toEqual({ completos: 1, parciais: 1, semNada: 1 });
    const { completos, parciais, semNada } = s.produtosPorCupom;
    expect(completos + parciais + semNada).toBe(s.cupons);
  });

  it("a rota lê o filtro da query", async () => {
    await coupons.replaceCouponProducts(PRONTO, [{ productKey: productKey(produto), productUrl: produto.link }], { origem: "parcial" });
    const { user, auth } = await createTestUser();
    await authMod.setUserRole(user.id, "admin");

    const r = await auth("get", "/api/admin/ml-cupons/alvos-produtos?soSemProdutos=1");
    expect(r.status).toBe(200);
    expect(r.body.prontos).toEqual([]);
    expect(r.body.parciaisFora).toBe(1);
  });
});

describe("GET /api/admin/ml-cupons/alvos-produtos", () => {
  beforeEach(semear);

  it("a rota devolve a fila e os limites", async () => {
    const { user, auth } = await createTestUser();
    await authMod.setUserRole(user.id, "admin");

    const r = await auth("get", "/api/admin/ml-cupons/alvos-produtos");
    expect(r.status).toBe(200);
    expect(r.body.prontos.map(c => c.campaignId)).toEqual([PRONTO]);
    expect(r.body.precisamAtivar.map(c => c.campaignId)).toEqual([ATIVAR]);
    expect(r.body.config.maxPaginasVitrine).toBeGreaterThan(0);
    // A extensão corta a colheita neste número. Sem ele ela só sabia contar
    // páginas, e página não prevê quantidade.
    expect(r.body.config.maxProductsPerCoupon).toBeGreaterThan(0);
  });
});

// O balanço dos botões 2 e 3 (task 17): o laço é da tela, que avisa o fim por aqui.
describe("POST /api/admin/ml-cupons/rodada-fim", () => {
  it("guarda o balanço do botão, e recusa botão que não existe", async () => {
    const { user, auth } = await createTestUser();
    await authMod.setUserRole(user.id, "admin");

    const ok = await auth("post", "/api/admin/ml-cupons/rodada-fim")
      .send({ botao: "produtos", duracaoMs: 1200, resultado: { tentados: 2, colhidos: 1 } });
    expect(ok.status).toBe(200);
    expect(sync.status().ultimas.produtos.resultado).toEqual({ tentados: 2, colhidos: 1 });

    const ruim = await auth("post", "/api/admin/ml-cupons/rodada-fim").send({ botao: "lista" });
    expect(ruim.status).toBe(400);
  });

  it("não é para quem não é admin", async () => {
    const { auth } = await createTestUser();
    const r = await auth("post", "/api/admin/ml-cupons/rodada-fim").send({ botao: "produtos" });
    expect(r.status).toBe(403);
  });
});

// O teto de produtos por cupom não pode virar uma lista fechada mentirosa: uma
// vitrine cortada no meio, gravada como fechada, faz o quick-check responder
// "este cupom não vale para o seu produto" para produto que o cupom cobre.
describe("gravarVitrineLocal — o teto de produtos corta, e o corte é parcial", () => {
  beforeEach(semear);

  const vitrine = (n) => Array.from({ length: n }, (_, i) => ({
    name: `Produto ${i}`, link: `https://www.mercadolivre.com.br/p/MLB99${String(i).padStart(4, "0")}`,
    price: 10 + i, store: "Mercado Livre",
  }));

  it("grava o total que a vitrine declara — e sem ele não apaga o que já tinha", async () => {
    await sync.gravarVitrineLocal(PRONTO, vitrine(3), { parcial: true, total: 200 });
    expect((await coupons.getCoupon(PRONTO)).vitrineTotal).toBe(200);

    await sync.gravarVitrineLocal(PRONTO, vitrine(3), { parcial: true });
    expect((await coupons.getCoupon(PRONTO)).vitrineTotal).toBe(200);
  });

  it("a rota aceita o total só como inteiro — lixo vira \"não sei\"", async () => {
    const { user, auth } = await createTestUser();
    await authMod.setUserRole(user.id, "admin");

    let r = await auth("post", `/api/admin/ml-cupons/${PRONTO}/vitrine-local`).send({ products: vitrine(2), parcial: true, total: "abc" });
    expect(r.status).toBe(200);
    expect((await coupons.getCoupon(PRONTO)).vitrineTotal).toBe(null);

    r = await auth("post", `/api/admin/ml-cupons/${PRONTO}/vitrine-local`).send({ products: vitrine(2), parcial: true, total: 45 });
    expect(r.status).toBe(200);
    expect((await coupons.getCoupon(PRONTO)).vitrineTotal).toBe(45);
  });

  it("cabendo no teto, entra como lista fechada", async () => {
    sync.writeConfig({ maxProductsPerCoupon: 10 });
    const r = await sync.gravarVitrineLocal(PRONTO, vitrine(4), { parcial: false });
    expect(r.produtos).toBe(4);
    expect(r.parcial).toBe(false);
    expect(r.cortadosPeloTeto).toBe(0);
    expect(await coupons.hasVitrine(PRONTO)).toBe(true);
  });

  it("estourando o teto, corta e marca parcial", async () => {
    sync.writeConfig({ maxProductsPerCoupon: 10 });
    const r = await sync.gravarVitrineLocal(PRONTO, vitrine(25), { parcial: false });
    expect(r.produtos).toBe(10);
    expect(r.parcial).toBe(true);
    expect(r.cortadosPeloTeto).toBe(15);
    // Parcial grava como "parcial" — prova positiva de cobertura, nunca lista
    // fechada. É o que impede o "fora da vitrine".
    expect(await coupons.hasVitrine(PRONTO)).toBe(false);
  });

  // A regressão de 01/09: "10% OFF com QUEROPROMO" trouxe 1040 produtos e o lote
  // inteiro foi RECUSADO, porque o teto de sanidade do payload era o mesmo número
  // do teto de negócio. 22 abas abertas na conta do ML para gravar zero produto.
  it("lote bem acima do teto de negócio corta, não é recusado", async () => {
    sync.writeConfig({ maxProductsPerCoupon: 500 });
    const r = await sync.gravarVitrineLocal(PRONTO, vitrine(1040), { parcial: false });
    expect(r.produtos).toBe(500);
    expect(r.parcial).toBe(true);
    expect(r.cortadosPeloTeto).toBe(540);
  });

  it("o parcial que veio da extensão continua parcial mesmo cabendo no teto", async () => {
    sync.writeConfig({ maxProductsPerCoupon: 100 });
    const r = await sync.gravarVitrineLocal(PRONTO, vitrine(3), { parcial: true });
    expect(r.parcial).toBe(true);
    expect(await coupons.hasVitrine(PRONTO)).toBe(false);
  });
});

describe("deleteCoupon — apagar UM cupom", () => {
  beforeEach(semear);

  it("some da lista, leva os vínculos e limpa o carimbo do catálogo", async () => {
    // O carimbo é coluna solta em catalog_products, sem FK: apagar o cupom antes
    // de limpá-lo deixaria produto apontando pra campanha que não existe mais.
    expect((await coupons.stats()).catalogo).toBeGreaterThan(0);

    const r = await coupons.deleteCoupon(RASPADO);
    expect(r.vinculos).toBeGreaterThan(0);
    expect(r.catalogoLimpo).toBeGreaterThan(0);

    expect(await coupons.getCoupon(RASPADO)).toBe(null);
    expect((await coupons.stats()).catalogo).toBe(0);
    // Os outros dois continuam lá: apagar um não é apagar tudo.
    expect((await coupons.listCoupons({})).total).toBe(2);
  });

  it("apagar um que não existe não explode", async () => {
    const r = await coupons.deleteCoupon("9999999");
    expect(r.vinculos).toBe(0);
  });

  it("sem campanha, recusa em vez de apagar por engano", async () => {
    await expect(coupons.deleteCoupon("")).rejects.toThrow(/Sem campanha/i);
  });

  it("a rota apaga e recusa durante uma varredura", async () => {
    const { user, auth } = await createTestUser();
    await authMod.setUserRole(user.id, "admin");

    // Apagar no meio da varredura é apagar o que ela está gravando.
    sync.startLocalRun({});
    try {
      const recusa = await auth("delete", `/api/admin/ml-cupons/${PRONTO}`);
      expect(recusa.status).toBe(409);
    } finally {
      sync.fimLocalRun({ cancelada: true });
    }

    const ok = await auth("delete", `/api/admin/ml-cupons/${PRONTO}`);
    expect(ok.status).toBe(200);
    expect(await coupons.getCoupon(PRONTO)).toBe(null);
  });
});

// A palavra que vem no TÍTULO do cupom ("10% OFF com QUEROPROMO"). Ela chega de
// graça na varredura da lista, mas vale menos que a palavra TESTADA no ML — e é
// essa hierarquia que o upsert precisa respeitar.
describe("a palavra do título carimbando o cupom", () => {
  it("cupom sem palavra recebe a do título", async () => {
    await coupons.upsertCoupons([{ ...base, campaignId: "9920020", title: "10% OFF com QUEROPROMO", codeFromTitle: "QUEROPROMO" }]);
    expect((await coupons.getCoupon("9920020")).code).toBe("QUEROPROMO");
  });

  it("palavra já descoberta por TESTE não é sobrescrita pela do título", async () => {
    // A testada é resposta do próprio ML e custou uma aba do Chrome com a conta do
    // sistema; a do título é leitura de texto. Trocar uma pela outra seria trocar
    // prova por palpite.
    await coupons.upsertCoupons([{ ...base, campaignId: "9920021", title: "10% OFF" }]);
    await coupons.recordCodeCheck({ code: "TESTADA9920021", verdict: "valid", campaignId: "9920021", source: "admin" });
    expect((await coupons.getCoupon("9920021")).code).toBe("TESTADA9920021");

    await coupons.upsertCoupons([{ ...base, campaignId: "9920021", title: "10% OFF com OUTRAPALAVRA", codeFromTitle: "OUTRAPALAVRA" }]);
    expect((await coupons.getCoupon("9920021")).code).toBe("TESTADA9920021");
  });

  it("a palavra do título não vira 'teste válido' no dicionário de palavras", async () => {
    // O `recoverCodesFromCoupons` reconstrói `ml_coupon_codes` a partir de
    // `ml_coupons.code`, carimbando `verdict: "valid"`. Isso só é honesto para
    // palavra que FOI ao ML — deixar a do título entrar inventaria um teste que
    // não houve, e o cache de 12h passaria a responder "válido" por ela.
    await coupons.upsertCoupons([{
      ...base, campaignId: "9920022", title: "10% OFF com SODOTITULO", codeFromTitle: "SODOTITULO",
      raw: { codeFromTitle: true },
    }]);
    await coupons.recordCodeCheck({ code: "SODOTITULO", verdict: "indeterminado", campaignId: null, source: "admin" });

    await coupons.recoverCodesFromCoupons();
    const linha = (await coupons.listCodeChecks({ limit: 50 })).find(p => p.code === "SODOTITULO");
    expect(linha.campaignId).toBe(null);
  });
});

// Task 14: as rotas do carimbo adiado da etapa 2.
describe("POST vitrine-local com carimbar:false + POST /carimbar", () => {
  beforeEach(semear);

  it("a vitrine grava sem carimbar, e o /carimbar carimba o catálogo", async () => {
    const { user, auth } = await createTestUser();
    await authMod.setUserRole(user.id, "admin");
    const novo = { name: "Produto em paralelo", link: "https://www.mercadolivre.com.br/produto/p/MLB7790099", price: 50 };
    const { prisma } = require(path.join(backendDir, "db.js"));
    const carimbo = async () =>
      (await prisma().catalogProduct.findUnique({ where: { key: productKey(novo) } }))?.couponCampaignId ?? null;

    const g = await auth("post", `/api/admin/ml-cupons/${PRONTO}/vitrine-local`).send({ products: [novo], parcial: false, carimbar: false });
    expect(g.status).toBe(200);
    expect(await carimbo()).toBeNull();

    const c = await auth("post", "/api/admin/ml-cupons/carimbar").send({});
    expect(c.status).toBe(200);
    expect(await carimbo()).toBe(PRONTO);
  });
});
