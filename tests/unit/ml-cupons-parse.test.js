// A leitura da aba de cupons do Mercado Livre. Tudo aqui é puro: recebe o JSON
// que a página do ML carrega dentro dela (o modelo "nordic") e devolve cupom no
// formato do sistema. As fixtures são recortes de dumps de verdade
// (backend/logs/ml-coupons/), então o que quebrar aqui quebrou lá também.

import "../helpers/env.js";
import { describe, it, expect } from "vitest";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ml = require(path.resolve(__dirname, "..", "..", "backend", "scraping", "ml-cupons.js"));

const fixture = (nome) => JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "fixtures", nome), "utf8"));
const landing = fixture("ml-cupons-landing.json");
const filterProps = fixture("ml-cupons-filter.json");

describe("parseAmount", () => {
  it("lê o número cru do accessibility e o formatado do texto", () => {
    expect(ml.parseAmount("1900")).toBe(1900);
    expect(ml.parseAmount("R$ 1.900,50")).toBe(1900.5);
    expect(ml.parseAmount(null)).toBe(null);
    expect(ml.parseAmount("Sem compra mínima.")).toBe(null);
  });
});

describe("parseCoupon", () => {
  const todos = landing.groupings.flatMap(g => (g.rawCoupons || []).map(c => ml.parseCoupon(c, [g.key])));

  it("cupom em porcentagem: valor, teto e a vitrine que veio no modelo", () => {
    const c = todos.find(x => x.kind === "percent" && x.containerUrl);
    expect(c.value).toBeGreaterThan(0);
    expect(c.campaignId).toMatch(/^\d+$/);
    expect(c.containerUrl).toMatch(/lista\.mercadolivre\.com\.br/);
  });

  it("\"Sem compra mínima.\" não vira mínimo de R$ 1", () => {
    // O ML manda fractional_amount "1" nesse caso; quem manda é o rótulo.
    const cru = { campaign_id: "1", title: { text: "10% OFF" }, status: { id: "ACTIVE" },
      amount: { min_amount: "Sem compra mínima.", accessibility: { min_amount: { fractional_amount: "1", label: "Sem compra mínima." } } } };
    expect(ml.parseCoupon(cru).minPurchase).toBe(null);
  });

  it("cupom de loja sai com escopo e nome do vendedor", () => {
    const cru = { campaign_id: "2", title: { text: "5% OFF" }, status: { id: "ACTIVE" },
      initial_subtitle: { text: "Em produtos de Tecprintrp10" },
      action: { type: "link", value: "https://lista.mercadolivre.com.br/_CustId_69438105?coupon_campaign_id=2" } };
    const c = ml.parseCoupon(cru);
    expect(c.scope).toBe("store");
    expect(c.sellerName).toBe("Tecprintrp10");
  });

  it("cupom NÃO ativado: sem vitrine, com o token de ativação guardado", () => {
    const c = todos.find(x => !x.activated);
    expect(c).toBeTruthy();
    expect(c.containerUrl).toBe(null);
    // O token não é uma palavra digitável — só existe pra diagnóstico.
    expect(typeof c.activationToken).toBe("string");
    expect(c.activationToken.length).toBeGreaterThan(20);
  });

  it("desconto em reais vira kind 'fixed'", () => {
    const cru = { campaign_id: "3", title: { text: "R$ 90 OFF CAPACETE", accessibility: { title: { fractional_amount: "90" } } }, status: { id: "INACTIVE" }, code: "abc" };
    const c = ml.parseCoupon(cru);
    expect(c.kind).toBe("fixed");
    expect(c.value).toBe(90);
  });

  it("miniatura em http vira https (senão quebra na tela do admin)", () => {
    const cru = { campaign_id: "4", title: { text: "10% OFF" }, status: { id: "ACTIVE" },
      items: [{ image_url: "http://http2.mlstatic.com/D_1-I.jpg", alt_text: "Coisa" }] };
    expect(ml.parseCoupon(cru).sampleItems[0].img).toBe("https://http2.mlstatic.com/D_1-I.jpg");
  });

  it("cupom sem campaign_id é descartado", () => {
    expect(ml.parseCoupon({ title: { text: "10% OFF" } })).toBe(null);
    expect(ml.parseCoupon(null)).toBe(null);
  });
});

describe("parseLanding", () => {
  const r = ml.parseLanding(landing);

  it("lê o total da conta e as categorias que o ML oferece", () => {
    expect(r.total).toBeGreaterThan(100);
    expect(r.categories.length).toBeGreaterThan(5);
    expect(r.groupings.length).toBe(landing.groupings.length);
  });

  it("o mesmo cupom em vários grupos vira UMA linha, guardando os grupos", () => {
    const ids = r.coupons.map(c => c.campaignId);
    expect(new Set(ids).size).toBe(ids.length);
    const repetido = r.coupons.find(c => c.groupings.length > 1);
    if (repetido) expect(repetido.groupings.length).toBeGreaterThan(1);
  });

  it("modelo ausente não explode — devolve lista vazia", () => {
    expect(ml.parseLanding(null).coupons).toEqual([]);
    expect(ml.parseLanding({}).coupons).toEqual([]);
  });
});

describe("parseFilterProps (a lista cheia, paginada)", () => {
  const r = ml.parseFilterProps(filterProps, "ce_vertical");

  it("lê os cupons da página e quantas páginas existem", () => {
    expect(r.coupons.length).toBeGreaterThan(0);
    expect(r.pages).toBeGreaterThan(1);
    expect(r.total).toBeGreaterThan(0);
    expect(r.coupons[0].groupings).toContain("ce_vertical");
  });

  it("entende o cupom em camelCase (é o formato desta página)", () => {
    const comVitrine = r.coupons.find(c => c.containerUrl);
    expect(comVitrine.activated).toBe(true);
    expect(comVitrine.title).toBeTruthy();
  });

  it("página sem o bloco da lista devolve vazio em vez de quebrar", () => {
    expect(ml.parseFilterProps(null).coupons).toEqual([]);
    expect(ml.parseFilterProps({}).pages).toBe(1);
  });
});

// Loja × campanha: a decisão que faz a rodada PULAR o cupom, então errar aqui é
// abrir uma página do Chrome à toa (ou perder cupom bom).
describe("detectScope — os sinais isolados", () => {
  it("`icon: store` sozinho basta — é o caso do cupom de loja NÃO ativado, que não tem URL", () => {
    expect(ml.detectScope({ icon: "store" }, null, null).scope).toBe("store");
  });

  it("cupom de novo seguidor é, por definição, de uma loja", () => {
    expect(ml.detectScope({ is_new_follower_coupon: true }, null, "Em produtos selecionados").scope).toBe("store");
  });

  it("sem `icon`, o _CustId_ da vitrine ainda resolve", () => {
    const url = "https://lista.mercadolivre.com.br/_CustId_69438105?coupon_campaign_id=13422085";
    expect(ml.detectScope({}, url, null).scope).toBe("store");
  });

  it("sem `icon` e sem URL, o subtítulo decide e dá o nome da loja", () => {
    const r = ml.detectScope({}, null, "Em produtos de Tecprintrp10");
    expect(r).toEqual({ scope: "store", sellerName: "Tecprintrp10" });
  });

  it("`icon: store` vence a URL de campanha — o modelo manda mais que o texto", () => {
    const url = "https://lista.mercadolivre.com.br/_Container_13907402?coupon_campaign_id=13907402";
    expect(ml.detectScope({ icon: "store" }, url, "Em produtos de Alguma Loja").scope).toBe("store");
  });

  it("campanha é campanha: nenhum sinal aceso, nenhum nome de vendedor", () => {
    const url = "https://lista.mercadolivre.com.br/_Container_13907402?coupon_campaign_id=13907402";
    expect(ml.detectScope({ icon: "tickets" }, url, "Em produtos selecionados"))
      .toEqual({ scope: "campaign", sellerName: null });
  });
});

describe("loja × campanha nas fixtures reais", () => {
  // Os mesmos cupons chegam por dois caminhos: a aba (snake_case, `rawCoupons`) e
  // a /cupons/filter (camelCase, via camelToRaw) — e é a segunda que traz o grosso
  // da coleta. Se os dois discordarem, metade da rodada classifica errado.
  const LOJA = ["13422085", "14087636", "13474243"];
  const CAMPANHA = ["13907402", "13491809"];

  const porLanding = new Map(
    landing.groupings
      .flatMap(g => (g.rawCoupons || []).map(c => ml.parseCoupon(c, [g.key])))
      .filter(Boolean)
      .map(c => [c.campaignId, c]));
  const porFilter = new Map(ml.parseFilterProps(filterProps, "ce_vertical").coupons.map(c => [c.campaignId, c]));

  it("os três cupons de loja são reconhecidos nos DOIS formatos", () => {
    for (const id of LOJA) {
      expect([id, porLanding.get(id)?.scope]).toEqual([id, "store"]);
      expect([id, porFilter.get(id)?.scope]).toEqual([id, "store"]);
    }
  });

  it("cupom de campanha não é confundido com loja — ativado ou não", () => {
    for (const id of CAMPANHA) {
      expect([id, porLanding.get(id)?.scope]).toEqual([id, "campaign"]);
      expect([id, porLanding.get(id)?.sellerName]).toEqual([id, null]);
      if (porFilter.has(id)) expect([id, porFilter.get(id).scope]).toEqual([id, "campaign"]);
    }
  });

  it("o cupom de loja sai com o nome do vendedor", () => {
    expect(porFilter.get("13422085").sellerName).toBe("Tecprintrp10");
    expect(porLanding.get("13474243").sellerName).toBe("Universalcases2");
  });

  it("landing e filter concordam sobre todo cupom que aparece nos dois", () => {
    for (const [id, c] of porFilter) {
      if (porLanding.has(id)) expect([id, c.scope]).toEqual([id, porLanding.get(id).scope]);
    }
  });
});

describe("camelToRaw", () => {
  it("não joga fora o `icon` — é por ele que passa quase toda a coleta", () => {
    const r = ml.camelToRaw({ campaignId: "1", icon: "store", isNewFollowerCoupon: true });
    expect(r.icon).toBe("store");
    expect(r.is_new_follower_coupon).toBe(true);
  });

  it("cupom de loja sem _CustId_ e sem subtítulo ainda sai como loja", () => {
    const c = ml.parseCoupon(ml.camelToRaw({
      campaignId: "9", icon: "store", title: { text: "5% OFF" }, status: { id: "INACTIVE" },
    }));
    expect(c.scope).toBe("store");
    expect(c.raw.icon).toBe("store");
  });
});

describe("crawlFilter — o corte de cupom de loja na coleta", () => {
  // Página de mentira: `crawlFilter` só usa goto + evaluate (é o readPageProps).
  // A segunda leitura vem vazia pra lista acabar na página 1, sem navegador e sem
  // esperar as pausas de 13 páginas.
  const fakePage = (paginas) => {
    let n = 0;
    return { goto: async () => {}, evaluate: async () => paginas[n++] ?? {} };
  };

  it("com skipStore, só sobra campanha — e o limite conta cupom útil", async () => {
    const r = await ml.crawlFilter(fakePage([filterProps]), { grouping: "ce_vertical", limit: 50, skipStore: true });
    expect(r.coupons.every(c => c.scope === "campaign")).toBe(true);
    expect(r.ignoradosLoja).toBe(3);   // 13422085, 14087636, 13474243
    expect(r.coupons.length).toBe(5);
  });

  it("sem skipStore nada muda — é o que a sonda precisa enxergar", async () => {
    const r = await ml.crawlFilter(fakePage([filterProps]), { grouping: "ce_vertical", limit: 50 });
    expect(r.coupons.some(c => c.scope === "store")).toBe(true);
    expect(r.ignoradosLoja).toBe(0);
    expect(r.coupons.length).toBe(8);
  });
});

describe("vitrine do cupom", () => {
  it("só existe a URL que o próprio ML deu — não se monta na mão", () => {
    // O caminho usa um slug do ML (_Container_toys-e-babys), não o id da
    // campanha: montar `_Container_<campaignId>` devolve lista vazia.
    const url = "https://lista.mercadolivre.com.br/_Container_toys-e-babys?coupon_campaign_id=13471229";
    expect(ml.containerUrlFor({ containerUrl: url })).toBe(url);
    expect(ml.containerUrlFor({ containerUrl: null, scope: "campaign", campaignId: "13471229" })).toBe(null);
    expect(ml.containerUrlFor(null)).toBe(null);
  });

  it("a paginação do lista.mercadolivre é _Desde_ no caminho, não ?page=", () => {
    const url = "https://lista.mercadolivre.com.br/_Container_toys-e-babys?coupon_campaign_id=13471229";
    expect(ml.containerPageUrl(url, 1)).toBe(url);
    expect(ml.containerPageUrl(url, 2)).toBe("https://lista.mercadolivre.com.br/_Container_toys-e-babys_Desde_49?coupon_campaign_id=13471229");
    expect(ml.containerPageUrl(url, 3)).toContain("_Desde_97");
  });

  it("a URL da lista carrega a categoria e a página", () => {
    expect(ml.filterUrl({})).toBe("https://www.mercadolivre.com.br/cupons/filter?all=true");
    expect(ml.filterUrl({ grouping: "tb_vertical", page: 2 }))
      .toBe("https://www.mercadolivre.com.br/cupons/filter?all=true&tb_vertical=true&page=2");
  });
});

describe("classifyCuponsResult", () => {
  const ok = { finalUrl: "https://www.mercadolivre.com.br/cupons", modelFound: true, couponCount: 30 };

  it("entrou", () => expect(ml.classifyCuponsResult(ok).kind).toBe("ok"));

  it("sessão vencida manda colar cookie novo", () => {
    const r = ml.classifyCuponsResult({ ...ok, finalUrl: "https://www.mercadolivre.com.br/gz/login" });
    expect(r.kind).toBe("login");
    expect(r.reason).toMatch(/cookie novo/i);
  });

  it("conta em verificação NÃO é sessão vencida", () => {
    const r = ml.classifyCuponsResult({ ...ok, finalUrl: "https://www.mercadolivre.com.br/gz/account-verification" });
    expect(r.kind).toBe("verificacao");
    expect(r.reason).toMatch(/verifica/i);
  });

  it("CAPTCHA", () => {
    expect(ml.classifyCuponsResult({ ...ok, finalUrl: "https://www.mercadolivre.com.br/captcha/wall" }).kind).toBe("captcha");
  });

  it("página abriu sem o JSON dos cupons = layout mudou, e isso não é 'sem cupom'", () => {
    const r = ml.classifyCuponsResult({ ...ok, modelFound: false });
    expect(r.kind).toBe("sem-modelo");
    expect(r.ok).toBe(false);
  });

  it("modelo veio e não tem cupom nenhum = conta sem cupom, não é erro", () => {
    const r = ml.classifyCuponsResult({ ...ok, couponCount: 0 });
    expect(r.kind).toBe("empty");
    expect(r.ok).toBe(true);
  });

  it("o bloqueio genérico só vale depois que a leitura específica passou", () => {
    const bloqueio = { blocked: true, captcha: true, reason: "bloqueado" };
    expect(ml.verdictFor({ ...ok, blocked: bloqueio }).kind).toBe("captcha");
    // Muro de login tem precedência: a orientação dele é melhor que "tente depois".
    expect(ml.verdictFor({ ...ok, finalUrl: "https://www.mercadolivre.com.br/gz/login", blocked: bloqueio }).kind).toBe("login");
  });
});

describe("classifyCodeCheck (a resposta do ML a uma PALAVRA digitada)", () => {
  it("palavra que o ML não conhece", () => {
    const r = ml.classifyCodeCheck({
      coupon: { campaignId: "0" },
      responseMessage: { text: "Confira se o cupom está correto", type: "error" },
      tracking: { event: { eventData: { response_code: "INVALID_1", response_type: "error" } } },
    });
    expect(r.verdict).toBe("invalid");
    expect(r.campaignId).toBe(null);
    expect(r.message).toMatch(/Confira/);
  });

  it("palavra que existe: o ML entrega a campanha, mesmo vencida", () => {
    const r = ml.classifyCodeCheck({
      coupon: { campaignId: "13456503" },
      responseMessage: { text: "O cupom venceu em 16 de agosto às 23:59.", type: "error" },
      tracking: { event: { eventData: { response_code: "EXPIRED_ACTION", coupon: { campaign_id: "13456503" } } } },
    });
    expect(r.verdict).toBe("valid");
    expect(r.campaignId).toBe("13456503");
    expect(r.responseCode).toBe("EXPIRED_ACTION");
  });

  it("resposta que ninguém reconhece vira indeterminado, não um chute", () => {
    expect(ml.classifyCodeCheck(null).verdict).toBe("indeterminado");
    expect(ml.classifyCodeCheck({ algo: "outro" }).verdict).toBe("indeterminado");
  });
});
