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
