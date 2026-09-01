// A categoria do cupom do ML: filtrar por ela e contar quantos há em cada uma.
//
// O ML separa os cupons por categoria e o mesmo cupom aparece em várias — o
// 13907402 estava em 7. Por isso `ml_coupons.groupings` é um array jsonb, e não
// uma coluna: filtrar é `array_contains`, contar passa por
// jsonb_array_elements_text. Um cupom em duas categorias conta 1 em CADA.

import { describe, it, expect, beforeEach } from "vitest";
import { createTestUser, auth as authMod } from "../helpers/app.js";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const backendDir = path.resolve(__dirname, "..", "..", "backend");
const coupons = require(path.join(backendDir, "coupons"));

const base = { kind: "percent", value: 20, scope: "campaign" };

async function semear() {
  await coupons.upsertCoupons([
    { ...base, campaignId: "9910001", title: "Eletro 20%", groupings: ["ce_vertical"] },
    { ...base, campaignId: "9910002", title: "Eletro e moda", groupings: ["ce_vertical", "tb_vertical"] },
    { ...base, campaignId: "9910003", title: "Sem categoria", groupings: [] },
  ]);
}

describe("cupons por categoria", () => {
  beforeEach(semear);

  it("filtra a lista pela categoria, inclusive o cupom que está em duas", async () => {
    const eletro = await coupons.listCoupons({ grouping: "ce_vertical" });
    expect(eletro.total).toBe(2);
    expect(eletro.items.map(c => c.campaignId).sort()).toEqual(["9910001", "9910002"]);

    const moda = await coupons.listCoupons({ grouping: "tb_vertical" });
    expect(moda.total).toBe(1);
    expect(moda.items[0].campaignId).toBe("9910002");
  });

  it("categoria desconhecida devolve lista vazia, e sem categoria devolve tudo", async () => {
    expect((await coupons.listCoupons({ grouping: "nao_existe" })).total).toBe(0);
    expect((await coupons.listCoupons({})).total).toBe(3);
    // String em branco não é filtro — senão a tela, que manda "" por padrão,
    // devolveria zero cupom.
    expect((await coupons.listCoupons({ grouping: "  " })).total).toBe(3);
  });

  it("a contagem por categoria soma o cupom em cada uma delas, e ignora quem não tem", async () => {
    const porCategoria = await coupons.countByGrouping();
    expect(porCategoria).toEqual([
      { chave: "ce_vertical", n: 2 },
      { chave: "tb_vertical", n: 1 },
    ]);
    expect((await coupons.stats()).porCategoria).toEqual(porCategoria);
  });
});

describe("GET /api/admin/ml-cupons?grouping", () => {
  beforeEach(semear);

  it("a rota repassa a categoria pro filtro", async () => {
    const { user, auth } = await createTestUser();
    await authMod.setUserRole(user.id, "admin");

    const todos = await auth("get", "/api/admin/ml-cupons");
    expect(todos.status).toBe(200);
    expect(todos.body.total).toBe(3);

    const moda = await auth("get", "/api/admin/ml-cupons?grouping=tb_vertical");
    expect(moda.status).toBe(200);
    expect(moda.body.total).toBe(1);
    expect(moda.body.items[0].campaignId).toBe("9910002");
    // A chave crua vai no payload — é dela que a tela tira a coluna "Categoria".
    expect(moda.body.items[0].groupings).toEqual(["ce_vertical", "tb_vertical"]);
  });
});

// O nome da categoria ("Eletrônicos") só o ML diz, e só na leitura da aba. Ele é
// MESCLADO a cada rodada: uma rodada de uma categoria só não lista as outras, e
// sobrescrever deixaria a tela mostrando `tb_vertical` cru pro resto.
describe("dicionário de nomes das categorias", () => {
  const sync = require(path.join(backendDir, "coupons", "sync"));

  it("mescla o que cada rodada viu, sem apagar o que já sabia", async () => {
    sync.mergeGroupingLabels([{ key: "ce_vertical", title: "Eletrônicos", count: 12 }]);
    sync.mergeGroupingLabels([{ key: "tb_vertical", title: "Moda", count: 3 }]);

    expect(sync.readGroupingLabels()).toEqual({ ce_vertical: "Eletrônicos", tb_vertical: "Moda" });
    expect(sync.status().groupingLabels.ce_vertical).toBe("Eletrônicos");

    // Grupo sem título (o ML às vezes manda a chave sozinha) não apaga o nome.
    sync.mergeGroupingLabels([{ key: "ce_vertical", title: null }]);
    expect(sync.readGroupingLabels().ce_vertical).toBe("Eletrônicos");
  });
});

// "Puxar de tudo" (task 28): a COLETA é a lista geral, sempre, e é ela que traz
// todos os cupons da conta. As verticais vêm DEPOIS e servem só para carimbar a
// categoria — o ML não diz a vertical do cupom na lista, a categoria gravada é o
// filtro que a varredura pediu na URL. Sem a geral antes, cupom que não está em
// vertical nenhuma nunca entrava; sem as verticais depois, a coluna Categoria
// fica vazia.
describe("categoriasDaRodada — o que 'todas as categorias' quer dizer", () => {
  const sync = require(path.join(backendDir, "coupons", "sync"));

  // O dicionário real da conta, com as três chaves que NÃO são categoria.
  const LABELS = {
    ce_vertical: "Eletrônicos, Áudio e Vídeo",
    fa_vertical: "Moda e acessórios",
    tb_vertical: "Brinquedos, Hobbies e Bebês",
    price: "Mais de R$100",
    percentage: "Mais de 10%",
    recommended: "Recomendados",
  };

  it("a lista geral vem primeiro, e as verticais depois, para carimbar", () => {
    expect(sync.categoriasDaRodada({ categorias: [] }, { labels: LABELS }))
      .toEqual([null, "ce_vertical", "fa_vertical", "tb_vertical"]);
  });

  it("sem o carimbo ligado, é só a lista geral", () => {
    expect(sync.categoriasDaRodada({ categorias: [], carimbarCategorias: false }, { labels: LABELS }))
      .toEqual([null]);
  });

  it("filtro não é categoria: price, percentage e recommended ficam de fora", () => {
    // Varrer por eles traria cupom repetido e carimbaria "Mais de 10%" na coluna
    // Categoria da tabela — uma categoria que não existe.
    const r = sync.categoriasDaRodada({ categorias: [] }, { labels: LABELS });
    for (const filtro of ["price", "percentage", "recommended"]) expect(r).not.toContain(filtro);
  });

  it("categoria escolhida na tela manda o CARIMBO, na ordem em que veio", () => {
    // A coleta continua sendo a lista geral: escolher categoria estreita o
    // carimbo, não a colheita. Foi o contrário disso que segurou a rodada em
    // Brinquedos por meses (task 26).
    expect(sync.categoriasDaRodada({ categorias: ["fa_vertical", "ce_vertical"] }, { labels: LABELS }))
      .toEqual([null, "fa_vertical", "ce_vertical"]);
  });

  it("sem dicionário nenhum, cai na lista geral em vez de não varrer nada", () => {
    // Instalação nova: o nome das categorias só chega depois da primeira leitura
    // da aba do ML. Sem este caso, a primeira rodada da vida não abriria página
    // nenhuma.
    expect(sync.categoriasDaRodada({ categorias: [] }, { labels: {} })).toEqual([null]);
  });

  it("buscar UMA campanha é a lista geral, não dez varreduras", () => {
    // A lista geral já contém a campanha procurada; varrer vertical por vertical
    // custaria dez vezes mais navegação com a conta do sistema pelo mesmo cupom.
    expect(sync.categoriasDaRodada({ categorias: ["tb_vertical"] }, { procurar: "14193848", labels: LABELS }))
      .toEqual([null]);
  });
});

// A categoria que a rodada geral NÃO sabe não pode apagar a que uma rodada por
// vertical já aprendeu. Era o que acontecia: o upsert gravava `groupings: []` por
// cima, e 1.211 dos 1.231 cupons do banco acabaram sem categoria nenhuma.
describe("upsertCoupons e a categoria", () => {
  // Reusa os cupons do `semear` (que roda a cada teste) em vez de criar outros: os
  // testes de cima contam a tabela INTEIRA, e cupom novo deixado para trás os
  // quebra na rodada seguinte.
  beforeEach(semear);

  it("lista vazia é 'não sei', não 'não tem' — a categoria de antes fica", async () => {
    // É a regressão: a passada na lista geral não pede filtro nenhum e traz `[]`
    // para todo mundo. Gravar isso por cima apagava a categoria já aprendida.
    await coupons.upsertCoupons([{ ...base, campaignId: "9910001", title: "Eletro 20%", groupings: [] }]);
    expect((await coupons.getCoupon("9910001")).groupings).toEqual(["ce_vertical"]);
  });

  it("categoria nova substitui a antiga — quem veio com filtro sabe do que fala", async () => {
    await coupons.upsertCoupons([{ ...base, campaignId: "9910001", title: "Eletro 20%", groupings: ["fa_vertical"] }]);
    expect((await coupons.getCoupon("9910001")).groupings).toEqual(["fa_vertical"]);
  });
});
