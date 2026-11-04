// A aba Admin › Scraping Cupons › Cupons Teste com banco: o histórico de envios
// guarda o que a mensagem prometeu (e não perde no "apaga e regrava" do
// saveGroup), a lista de envios a conferir sai dele, e a rodada anda pelas rotas
// (abrir → item → fim) com as contagens certas.

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createTestUser, auth as authMod, storage } from "../helpers/app.js";
import { makeGroup } from "../helpers/fixtures.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const htmlCupons = fs.readFileSync(path.resolve(__dirname, "..", "fixtures", "ml-checkout-cupons-iframe.html"), "utf8");

async function makeAdmin() {
  const u = await createTestUser({ plan: "pro" });
  await authMod.setUserRole(u.user.id, "admin");
  return u;
}

const agora = () => new Date().toISOString();

describe("Cupons Teste", () => {
  it("o histórico guarda cupom e preço com cupom, e eles sobrevivem ao próximo envio", async () => {
    const { user, auth } = await makeAdmin();
    await auth("put", "/api/state").send({ groups: [makeGroup({ id: 501, name: "Ofertas" })] });

    const envio1 = {
      key: "k1", name: "Porteiro", link: "https://meli.la/abc", store: "Mercado Livre",
      price: 279.9, sentAt: agora(), groupCount: 1,
      coupon: "CASA25", couponCampaignId: "14167118", sentPrice: 269.9, priceWithCoupon: 249.9, couponLabel: "25% OFF",
    };
    await storage.updateGroupOps(user.id, 501, { history: [envio1] });
    // O próximo envio regrava o histórico inteiro a partir do que foi lido.
    const lido = (await storage.loadState(user.id)).groups.find(g => g.id === 501).history;
    expect(lido[0]).toMatchObject({ coupon: "CASA25", sentPrice: 269.9, priceWithCoupon: 249.9, couponLabel: "25% OFF" });
    await storage.updateGroupOps(user.id, 501, {
      history: [{ key: "k2", name: "Outro", link: "https://meli.la/x", store: "Mercado Livre", price: 10, sentAt: agora() }, ...lido],
    });
    const depois = (await storage.loadState(user.id)).groups.find(g => g.id === 501).history;
    expect(depois.find(h => h.key === "k1")).toMatchObject({ coupon: "CASA25", priceWithCoupon: 249.9 });

    // A lista: só o envio com cupom (o k2 não tem cupom gravado nem no catálogo).
    const r = await auth("get", "/api/admin/cupons-teste/alvos");
    expect(r.status).toBe(200);
    expect(r.body.alvos).toHaveLength(1);
    expect(r.body.alvos[0]).toMatchObject({
      coupon: "CASA25", link: "https://meli.la/abc", estimado: false,
      prometidoPreco: 269.9, prometidoComCupom: 249.9, groupName: "Ofertas",
    });

    // A rodada pelas rotas.
    const aberta = await auth("post", "/api/admin/cupons-teste/runs").send({ total: 2 });
    expect(aberta.status).toBe(200);
    const runId = aberta.body.run.id;

    const material = {
      produto: { name: "Porteiro", price: 269.9 },
      checkout: { reached: true },
      modal: { aberto: true, campo: true },
      resumoDepois: "Cupons (1/1 em uso) - R$ 20,00 Você pagará R$ 269,90 R$ 249,90",
      cartaoDepois: { texto: "Com CASA25\n25% OFF\nCompra mínima R$ 25 | Limite de R$ 20\nAplicado", aplicado: true },
      htmlCupons,
    };
    const it1 = await auth("post", `/api/admin/cupons-teste/runs/${runId}/item`).send({ alvo: r.body.alvos[0], material, durationMs: 1234 });
    expect(it1.status).toBe(200);
    expect(it1.body.item).toMatchObject({ status: "ok", realComCupom: 249.9, descontoMl: 20 });

    const it2 = await auth("post", `/api/admin/cupons-teste/runs/${runId}/item`).send({ alvo: r.body.alvos[0], erro: "A extensão não respondeu a tempo." });
    expect(it2.body.item.status).toBe("falhou");

    const fim = await auth("post", `/api/admin/cupons-teste/runs/${runId}/fim`).send({ status: "cancelada", motivo: "Parado por você." });
    expect(fim.body.fechada).toBe(true);

    const det = await auth("get", `/api/admin/cupons-teste/runs/${runId}`);
    expect(det.body.run).toMatchObject({ status: "cancelada", feitos: 2, ok: 1, falhou: 1, total: 2 });
    expect(det.body.itens).toHaveLength(2);

    const lista = await auth("get", "/api/admin/cupons-teste/runs");
    expect(lista.body.runs[0].id).toBe(runId);
  });

  it("abrir uma rodada nova encerra a que ficou rodando (página fechada no meio)", async () => {
    const { auth } = await makeAdmin();
    const a = (await auth("post", "/api/admin/cupons-teste/runs").send({ total: 1 })).body.run.id;
    await auth("post", "/api/admin/cupons-teste/runs").send({ total: 1 });
    const det = await auth("get", `/api/admin/cupons-teste/runs/${a}`);
    expect(det.body.run.status).toBe("interrompida");
  });

  it("config: salva saneando, e usuário comum não entra", async () => {
    const { auth } = await makeAdmin();
    const put = await auth("put", "/api/admin/cupons-teste/config").send({ dias: 500, toleranciaReais: 0.5 });
    expect(put.body.config).toMatchObject({ dias: 30, toleranciaReais: 0.5 });
    const get = await auth("get", "/api/admin/cupons-teste/config");
    expect(get.body.config.dias).toBe(30);
    expect(Array.isArray(get.body.campanhas)).toBe(true);

    const comum = await createTestUser({ plan: "pro" });
    expect((await comum.auth("get", "/api/admin/cupons-teste/alvos")).status).toBe(403);
  });
});
