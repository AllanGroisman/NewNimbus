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

// A PALAVRA escondida no título ("10% OFF com QUEROPROMO").
//
// Vale ouro porque é o único jeito de descobrir uma palavra sem TESTAR no ML — e
// testar custa uma aba do Chrome com a conta do sistema, uma palavra por vez.
// Por isso mesmo a regra é apertada: um falso positivo carimba a palavra ERRADA
// num cupom, e daí em diante o teste de cupom mente.
describe("palavraDoTitulo", () => {
  it("pega o token em maiúscula depois do 'com'", () => {
    expect(ml.palavraDoTitulo("10% OFF com QUEROPROMO")).toBe("QUEROPROMO");
    expect(ml.palavraDoTitulo("R$ 50 OFF com PROMO2026")).toBe("PROMO2026");
    // O ML às vezes começa a frase com "Com".
    expect(ml.palavraDoTitulo("Com BRINQUEDOS você ganha 15%")).toBe("BRINQUEDOS");
  });

  it("'com' seguido de palavra normal não é palavra de cupom", () => {
    expect(ml.palavraDoTitulo("15% OFF com desconto extra")).toBe(null);
    expect(ml.palavraDoTitulo("Casa com Estilo")).toBe(null);
    expect(ml.palavraDoTitulo("Cupom com frete grátis")).toBe(null);
  });

  it("as maiúsculas que fazem parte do desconto ficam de fora", () => {
    // "com OFF" e "com FRETE" apareceriam como palavra e carimbariam dezenas de
    // campanhas com a mesma palavra inventada.
    expect(ml.palavraDoTitulo("20% com OFF")).toBe(null);
    expect(ml.palavraDoTitulo("Compre com FRETE grátis")).toBe(null);
    expect(ml.palavraDoTitulo("Pague com PIX")).toBe(null);
  });

  it("token curto demais não conta", () => {
    // "com R$ 10", "com 2 itens": números e siglas de duas letras não são palavra.
    expect(ml.palavraDoTitulo("Desconto com R$ 10 de volta")).toBe(null);
    expect(ml.palavraDoTitulo("com AB")).toBe(null);
  });

  it("sem título, sem palavra — e sem explodir", () => {
    expect(ml.palavraDoTitulo(null)).toBe(null);
    expect(ml.palavraDoTitulo("")).toBe(null);
    expect(ml.palavraDoTitulo(undefined)).toBe(null);
  });

  it("o parseCoupon devolve a palavra e diz de onde ela veio", () => {
    const c = ml.parseCoupon({ campaign_id: "1", title: { text: "10% OFF com QUEROPROMO" } });
    expect(c.codeFromTitle).toBe("QUEROPROMO");
    expect(c.raw.codeFromTitle).toBe(true);

    const sem = ml.parseCoupon({ campaign_id: "2", title: { text: "10% OFF em tudo" } });
    expect(sem.codeFromTitle).toBe(null);
    expect(sem.raw.codeFromTitle).toBe(false);
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

  // O caso do BRINCADEIRAS: o JSON abaixo é exatamente o que ficou gravado em
  // ml_coupon_codes. Ele foi lido como "o ML não reconheceu" e ainda apagou a
  // campanha 13471229 que a palavra já tinha resolvido no dia anterior.
  it("\"Tivemos um problema\" é o ML engasgando, não a palavra sendo negada", () => {
    const r = ml.classifyCodeCheck({
      responseMessage: { text: "Tivemos um problema", type: "error" },
    });
    expect(r.verdict).toBe("indeterminado");
    expect(r.campaignId).toBe(null);
    expect(r.responseCode).toBe(null);
  });

  it("o que separa os dois é o ML ter avaliado: response_code ou o objeto coupon", () => {
    // Sem tracking, mas com o coupon zerado: ele avaliou e a palavra não existe.
    expect(ml.classifyCodeCheck({
      coupon: { campaignId: "0" },
      responseMessage: { text: "Confira se o cupom está correto", type: "error" },
    }).verdict).toBe("invalid");

    // Só o response_code, sem coupon nenhum: também é avaliação.
    expect(ml.classifyCodeCheck({
      responseMessage: { text: "qualquer coisa", type: "error" },
      tracking: { event: { eventData: { response_code: "SOME_ERROR" } } },
    }).verdict).toBe("invalid");
  });

  it("erro sem avaliação nenhuma nunca vira invalid", () => {
    expect(ml.classifyCodeCheck({ message: "falhou", response_code: null, responseMessage: { type: "error" } }).verdict)
      .toBe("indeterminado");
  });
});

describe("crawlFilter — a varredura de UMA campanha (findCampaignId)", () => {
  // O mesmo duplo de página do bloco acima, mas contando as navegações: é o que
  // prova que a busca não varre as 13 páginas para achar algo na primeira.
  const fakePage = (paginas) => {
    const estado = { gotos: 0 };
    let n = 0;
    return {
      estado,
      page: { goto: async () => { estado.gotos++; }, evaluate: async () => paginas[n++] ?? {} },
    };
  };

  // A fixture tem uma página só. Para a segunda, os ids são reescritos — assim
  // existe um cupom que SÓ aparece depois de virar a página.
  const paginaDois = () => {
    const c = JSON.parse(JSON.stringify(filterProps));
    // A fixture da /cupons/filter é camelCase (é o que o ML serve ali) — mexer no
    // `campaign_id` em vez do `campaignId` jogaria o parseFilterProps no ramo errado.
    for (const cupom of c.filteredCouponsData.coupons) cupom.campaignId = `77${cupom.campaignId}`;
    c.activeCouponsData = null;
    return c;
  };

  it("para na página em que a campanha aparece", async () => {
    const f = fakePage([filterProps, paginaDois()]);
    const r = await ml.crawlFilter(f.page, { limit: 500, findCampaignId: "14030498" });

    expect(r.achou).toBe(true);
    expect(f.estado.gotos).toBe(1);
    expect(r.coupons.some(c => c.campaignId === "14030498")).toBe(true);
  });

  it("sem findCampaignId a mesma lista vira a página — é o contraste do teste acima", async () => {
    const f = fakePage([filterProps, paginaDois()]);
    const r = await ml.crawlFilter(f.page, { limit: 500 });

    expect(f.estado.gotos).toBeGreaterThan(1);
    expect(r.achou).toBe(false);
  });

  it("acha na página 2 quando não estava na 1", async () => {
    const f = fakePage([filterProps, paginaDois()]);
    const r = await ml.crawlFilter(f.page, { limit: 500, findCampaignId: "7714030498" });

    expect(r.achou).toBe(true);
    expect(f.estado.gotos).toBe(2);
  });

  it("cupom de loja não é descartado quando ele é o alvo — por isso findCampaign não usa skipStore", async () => {
    const f = fakePage([filterProps]);
    // 13422085 é um dos cupons de loja da fixture (ver o bloco do skipStore acima).
    const r = await ml.crawlFilter(f.page, { limit: 500, skipStore: false, findCampaignId: "13422085" });

    expect(r.achou).toBe(true);
    expect(r.coupons.find(c => c.campaignId === "13422085").scope).toBe("store");
  });
});

// ────────────────────────────────────────────────────────────────────────
// A amostra da vitrine (os `item_ids` do bloco de telemetria)
// ────────────────────────────────────────────────────────────────────────
//
// Os ids das 4 miniaturas do card não estão no card: estão em
// `tracking.view.eventData.coupons_list[]`, num campo IRMÃO de `segmentations`.
// É fácil procurar no lugar errado — `segmentations.item_ids` existe e vem
// sempre vazio —, e é fácil o ML mudar isso de lugar sem avisar. Daí estes
// testes: as fixtures são recortes de dumps de verdade, então o dia em que o
// campo sair do modelo, quebra aqui e não em produção com vínculo faltando.
describe("sampleIdsFromTracking (a amostra da vitrine)", () => {
  it("tira os MLBs do bloco de telemetria, por campanha", () => {
    const mapa = ml.sampleIdsFromTracking(landing);
    expect(mapa.size).toBeGreaterThan(0);
    expect(mapa.get("13907402")).toEqual([
      "MLB4714381579", "MLB6781617356", "MLB4751231153", "MLB4751243865",
    ]);
  });

  it("ignora o que não é MLB e não repete id", () => {
    const mapa = ml.sampleIdsFromTracking({
      tracking: { view: { eventData: { coupons_list: [
        { campaign_id: "1", item_ids: ["MLB123456789", "MLB123456789", "lixo", null, "MLB-987654321"] },
        { campaign_id: "2", item_ids: [] },
        { item_ids: ["MLB111111111"] },   // sem campanha: não dá pra vincular
      ] } } },
    });
    expect(mapa.get("1")).toEqual(["MLB123456789", "MLB987654321"]);
    expect(mapa.has("2")).toBe(false);
    expect(mapa.size).toBe(1);
  });

  it("página sem telemetria não quebra — devolve mapa vazio", () => {
    expect(ml.sampleIdsFromTracking(null).size).toBe(0);
    expect(ml.sampleIdsFromTracking({}).size).toBe(0);
    expect(ml.sampleIdsFromTracking({ tracking: { view: {} } }).size).toBe(0);
  });
});

describe("sampleItemIds chega no cupom", () => {
  it("pela aba (parseLanding)", () => {
    const cupons = ml.parseLanding(landing).coupons;
    expect(cupons.every(c => Array.isArray(c.sampleItemIds))).toBe(true);
    const c = cupons.find(x => x.campaignId === "13907402");
    expect(c.sampleItemIds).toHaveLength(4);
    // A amostra existe para cupom NÃO ativado também — e é justamente nele que
    // ela é o único vínculo possível, porque vitrine ele não tem.
    const inativo = cupons.find(x => !x.activated && x.sampleItemIds.length);
    expect(inativo ? inativo.sampleItemIds.length : 4).toBeGreaterThan(0);
  });

  it("pela lista cheia (parseFilterProps), que só serve camelCase", () => {
    const cupons = ml.parseFilterProps(filterProps, "ce_vertical").coupons;
    const c = cupons.find(x => x.campaignId === "13907402");
    expect(c.sampleItemIds).toHaveLength(4);
  });

  it("cupom sem telemetria fica com a lista vazia, não com undefined", () => {
    const c = ml.parseCoupon({ campaign_id: "999", title: { text: "10% OFF" } });
    expect(c.sampleItemIds).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Ativar cupom ("Eu quero") — a única ESCRITA na conta do ML
// ────────────────────────────────────────────────────────────────────────
//
// Contexto (27/08/2026): o ML só entrega a URL da vitrine para cupom ATIVADO. O
// não ativado vem com `action.type === "button"` e nada mais — e sem vitrine o
// sistema não sabe quais produtos o cupom cobre.
//
// Ativar é escrita na conta, e a conta é a MESMA do Hub de Afiliados. Por isso a
// regra de QUEM ativar é pura e tem teste: cada item que sai daqui vira um clique
// de verdade na conta do Allan, e ativar o cupom errado não tem desfazer.
describe("aAtivar — quem pode receber o clique", () => {
  const cupom = (over = {}) => ({
    campaignId: "1", scope: "campaign", activated: false,
    activationLabel: "Aplicar cupom 10 por cento OFF Em produtos selecionados",
    expiresAt: new Date(Date.now() + 864e5).toISOString(),
    ...over,
  });

  it("deixa passar o cupom de campanha não ativado", () => {
    expect(ml.aAtivar([cupom()], { max: 20 })).toHaveLength(1);
  });

  it("cupom de LOJA fica de fora — vale só para um vendedor, ativar é escrita à toa", () => {
    expect(ml.aAtivar([cupom({ scope: "store" })], { max: 20 })).toEqual([]);
  });

  it("já ativado fica de fora", () => {
    expect(ml.aAtivar([cupom({ activated: true })], { max: 20 })).toEqual([]);
  });

  it("vencido fica de fora — ativar cupom morto é sujeira na conta", () => {
    expect(ml.aAtivar([cupom({ expiresAt: new Date(Date.now() - 864e5).toISOString() })], { max: 20 })).toEqual([]);
  });

  it("sem rótulo fica de fora: sem ele não se sabe QUAL botão é o dele", () => {
    expect(ml.aAtivar([cupom({ activationLabel: null })], { max: 20 })).toEqual([]);
  });

  it("respeita o teto — é ele que protege a conta da rajada de cliques", () => {
    // Rótulos distintos de propósito: cupom diferente com rótulo igual é ambíguo
    // e o `aAtivar` descarta — o que este teste mede é o TETO, não a ambiguidade.
    const muitos = Array.from({ length: 50 }, (_, i) =>
      cupom({ campaignId: String(i), activationLabel: `Aplicar cupom ${i} por cento OFF` }));
    expect(ml.aAtivar(muitos, { max: 20 })).toHaveLength(20);
    expect(ml.aAtivar(muitos, { max: 0 })).toEqual([]);
  });

  it("cupom sem data de validade passa (o ML nem sempre manda)", () => {
    expect(ml.aAtivar([cupom({ expiresAt: null })], { max: 5 })).toHaveLength(1);
  });
});

describe("parseCoupon — o rótulo que liga o modelo ao botão", () => {
  const cupons = ml.parseLanding(landing).coupons;

  it("o cupom não ativado guarda o rótulo do 'Aplicar'", () => {
    const semVitrine = cupons.filter(c => !c.containerUrl && !c.activated);
    expect(semVitrine.length).toBeGreaterThan(0);
    // O rótulo é o que evita clicar no cupom errado: "Aplicar" sozinho se repete
    // dezenas de vezes na página.
    expect(semVitrine.every(c => typeof c.activationLabel === "string" && /Aplicar/i.test(c.activationLabel))).toBe(true);
  });

  it("a lista PAGINADA também guarda o rótulo — é ela que a rodada usa", () => {
    // Aqui mora o bug de verdade, e é uma lição sobre onde apontar o teste: a aba
    // inicial (`parseLanding`) lê `rawCoupons`, em snake_case, com `sr_label` — e
    // sempre funcionou. A lista paginada (`parseFilterProps`) vem em camelCase,
    // com `srLabel`, e é essa que a rodada percorre. O código lia só o snake, então
    // caía no `label` = "Aplicar" exatamente no caminho que importa, enquanto os
    // testes da aba passavam verdes.
    const daLista = ml.parseFilterProps(filterProps, null).coupons.filter(c => c.activationLabel);
    expect(daLista.length).toBeGreaterThan(1);
    expect(daLista.map(c => c.activationLabel)).not.toContain("Aplicar");
    for (const c of daLista) expect(c.activationLabel.length).toBeGreaterThan("Aplicar".length);
  });

  it("o rótulo IDENTIFICA o cupom — nunca é o texto solto do botão", () => {
    // Este teste existe por causa de um bug de verdade: o código lia `sr_label` e
    // o ML manda `srLabel`, então caía no `label` irmão — que é "Aplicar", igual
    // em todos os cards. O efeito não era "não ativa": era casar o primeiro botão
    // da página e ativar OUTRO cupom na conta. A asserção antiga (/Aplicar/i)
    // passava feliz com o bug, por isso aqui se exige unicidade.
    const rotulos = cupons.filter(c => c.activationLabel).map(c => c.activationLabel);
    expect(rotulos.length).toBeGreaterThan(1);
    expect(rotulos).not.toContain("Aplicar");
    expect(new Set(rotulos).size).toBe(rotulos.length);
  });

  it("o cupom que já tem vitrine não tem rótulo de ativação", () => {
    const comVitrine = cupons.filter(c => c.containerUrl);
    expect(comVitrine.length).toBeGreaterThan(0);
    expect(comVitrine.every(c => c.activationLabel === null)).toBe(true);
  });
});
