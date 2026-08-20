// Funções puras do coração do scheduler: janelas de horário, cooldown,
// filtros de campanha e template da mensagem. Backend puro — sem servidor.

import { describe, it, expect } from "vitest";
import "../helpers/env.js";
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const scheduler = require(path.resolve(__dirname, "..", "..", "backend", "scheduler.js"));

// Constrói um Date no dia de hoje com hora local hh:mm — inWindow compara
// contra o horário local (toTimeString), então o teste também precisa ser local.
function at(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d;
}

describe("scheduler.inWindow — janela de horário", () => {
  const w = { from: "08:00", to: "12:00" };

  it("dentro da janela", () => {
    expect(scheduler.inWindow(at("08:00"), w)).toBe(true); // início inclusivo
    expect(scheduler.inWindow(at("10:30"), w)).toBe(true);
    expect(scheduler.inWindow(at("11:59"), w)).toBe(true);
  });

  it("fora da janela (fim é exclusivo)", () => {
    expect(scheduler.inWindow(at("07:59"), w)).toBe(false);
    expect(scheduler.inWindow(at("12:00"), w)).toBe(false);
    expect(scheduler.inWindow(at("23:00"), w)).toBe(false);
  });
});

describe("scheduler.activeWindow — escolhe a janela ativa", () => {
  const schedule = {
    windows: [
      { from: "08:00", to: "10:00" },
      { from: "18:00", to: "22:00" },
    ],
  };

  it("acha a janela que contém o horário", () => {
    expect(scheduler.activeWindow(at("09:00"), schedule)).toEqual({ from: "08:00", to: "10:00" });
    expect(scheduler.activeWindow(at("20:00"), schedule)).toEqual({ from: "18:00", to: "22:00" });
  });

  it("null fora de qualquer janela", () => {
    expect(scheduler.activeWindow(at("14:00"), schedule)).toBeNull();
  });

  it("null quando schedule ausente ou sem windows", () => {
    expect(scheduler.activeWindow(at("09:00"), null)).toBeNull();
    expect(scheduler.activeWindow(at("09:00"), {})).toBeNull();
    expect(scheduler.activeWindow(at("09:00"), { windows: "não é array" })).toBeNull();
  });
});

describe("scheduler.cooldownMinutes — conversão de unidade", () => {
  it("minutos, horas e dias", () => {
    expect(scheduler.cooldownMinutes({ cooldownValue: 45, cooldownUnit: "minutos" })).toBe(45);
    expect(scheduler.cooldownMinutes({ cooldownValue: 2, cooldownUnit: "horas" })).toBe(120);
    expect(scheduler.cooldownMinutes({ cooldownValue: 1, cooldownUnit: "dias" })).toBe(1440);
  });

  it("default: sem unidade cai em horas; sem schedule é 0", () => {
    expect(scheduler.cooldownMinutes({ cooldownValue: 3 })).toBe(180);
    expect(scheduler.cooldownMinutes(null)).toBe(0);
    expect(scheduler.cooldownMinutes(undefined)).toBe(0);
  });

  it("valor inválido vira 0", () => {
    expect(scheduler.cooldownMinutes({ cooldownValue: "abc", cooldownUnit: "horas" })).toBe(0);
  });
});

describe("scheduler.itemMatchesCampaign — filtros da campanha", () => {
  const baseItem = {
    name: "Headset Gamer XYZ",
    store: "Mercado Livre",
    category: "gamer",
    price: 200,
    discount: 40,
    rating: 4.5,
  };
  const baseCtx = { cats: new Set(["gamer"]), srcs: new Set(["ml"]), filters: {} };

  it("item que casa com categoria + loja + sem filtros passa", () => {
    expect(scheduler.itemMatchesCampaign(baseItem, baseCtx)).toBe(true);
  });

  it("item manual sempre passa, mesmo fora dos filtros", () => {
    const item = { ...baseItem, manual: true, category: "outra", discount: 1 };
    expect(scheduler.itemMatchesCampaign(item, baseCtx)).toBe(true);
  });

  it("categoria fora do set reprova; categoria como objeto {id} funciona", () => {
    expect(scheduler.itemMatchesCampaign({ ...baseItem, category: "casa" }, baseCtx)).toBe(false);
    expect(scheduler.itemMatchesCampaign({ ...baseItem, category: { id: "gamer" } }, baseCtx)).toBe(true);
  });

  it("loja fora das sources reprova (Amazon numa campanha só-ML)", () => {
    expect(scheduler.itemMatchesCampaign({ ...baseItem, store: "Amazon" }, baseCtx)).toBe(false);
  });

  it("minDiscount reprova desconto menor ou ausente", () => {
    const ctx = { ...baseCtx, filters: { minDiscount: 50 } };
    expect(scheduler.itemMatchesCampaign(baseItem, ctx)).toBe(false); // 40 < 50
    expect(scheduler.itemMatchesCampaign({ ...baseItem, discount: null }, ctx)).toBe(false);
    expect(scheduler.itemMatchesCampaign({ ...baseItem, discount: 60 }, ctx)).toBe(true);
  });

  it("faixa de preço min/max", () => {
    const ctx = { ...baseCtx, filters: { minPrice: 100, maxPrice: 300 } };
    expect(scheduler.itemMatchesCampaign(baseItem, ctx)).toBe(true); // 200 na faixa
    expect(scheduler.itemMatchesCampaign({ ...baseItem, price: 50 }, ctx)).toBe(false);
    expect(scheduler.itemMatchesCampaign({ ...baseItem, price: 500 }, ctx)).toBe(false);
    expect(scheduler.itemMatchesCampaign({ ...baseItem, price: null }, ctx)).toBe(false);
  });

  it("minRating reprova nota baixa ou ausente", () => {
    const ctx = { ...baseCtx, filters: { minRating: 4 } };
    expect(scheduler.itemMatchesCampaign(baseItem, ctx)).toBe(true); // 4.5
    expect(scheduler.itemMatchesCampaign({ ...baseItem, rating: 3.9 }, ctx)).toBe(false);
    expect(scheduler.itemMatchesCampaign({ ...baseItem, rating: undefined }, ctx)).toBe(false);
  });

  it("keywords: basta UMA palavra bater no nome (case-insensitive, separadas por vírgula)", () => {
    const ctx = { ...baseCtx, filters: { keywords: "mouse, HEADSET" } };
    expect(scheduler.itemMatchesCampaign(baseItem, ctx)).toBe(true); // "headset" no nome
    const ctx2 = { ...baseCtx, filters: { keywords: "geladeira, fogão" } };
    expect(scheduler.itemMatchesCampaign(baseItem, ctx2)).toBe(false);
  });

  it("cats=null significa 'todas as categorias'", () => {
    const ctx = { cats: null, srcs: new Set(["ml"]), filters: {} };
    expect(scheduler.itemMatchesCampaign({ ...baseItem, category: "qualquer" }, ctx)).toBe(true);
  });

  it("srcs vazio (todas as lojas trancadas) reprova tudo que não é manual", () => {
    const ctx = { cats: null, srcs: new Set(), filters: {} };
    expect(scheduler.itemMatchesCampaign(baseItem, ctx)).toBe(false);
    expect(scheduler.itemMatchesCampaign({ ...baseItem, manual: true }, ctx)).toBe(true);
  });

  it("item null/undefined reprova", () => {
    expect(scheduler.itemMatchesCampaign(null, baseCtx)).toBe(false);
    expect(scheduler.itemMatchesCampaign(undefined, baseCtx)).toBe(false);
  });

  it("minSales reprova quem vendeu pouco (texto de vendas ou soldCount)", () => {
    const ctx = { ...baseCtx, filters: { minSales: 100 } };
    expect(scheduler.itemMatchesCampaign({ ...baseItem, sold: "+1 mil vendidos" }, ctx)).toBe(true);
    expect(scheduler.itemMatchesCampaign({ ...baseItem, sold: "12 vendidos" }, ctx)).toBe(false);
    // Shopee manda a contagem exata em soldCount, sem texto
    expect(scheduler.itemMatchesCampaign({ ...baseItem, soldCount: 500 }, ctx)).toBe(true);
    expect(scheduler.itemMatchesCampaign({ ...baseItem, soldCount: 3 }, ctx)).toBe(false);
    // sem informação de vendas nenhuma: reprova (mesma regra do rating)
    expect(scheduler.itemMatchesCampaign(baseItem, ctx)).toBe(false);
  });
});

describe("scheduler.isAutoRefill — preenchimento automático da fila", () => {
  it("ligado por padrão; campanha antiga (sem o campo) continua preenchendo sozinha", () => {
    expect(scheduler.isAutoRefill({ scraping: {} })).toBe(true);
    expect(scheduler.isAutoRefill({})).toBe(true);
    expect(scheduler.isAutoRefill({ scraping: { autoRefill: true } })).toBe(true);
  });

  it("só desliga com o valor explícito false", () => {
    expect(scheduler.isAutoRefill({ scraping: { autoRefill: false } })).toBe(false);
  });
});

describe("scheduler.windowGate — sem janela a campanha fica parada", () => {
  it("com pelo menos uma janela, passa", () => {
    expect(scheduler.windowGate({ schedule: { windows: [{ from: "08:00", to: "12:00" }] } }).ok).toBe(true);
  });

  it("sem nenhuma janela, barra (e diz o porquê)", () => {
    const g = scheduler.windowGate({ schedule: { windows: [] } });
    expect(g.ok).toBe(false);
    expect(g.reason).toMatch(/janela de envio/i);
    expect(scheduler.windowGate({ schedule: {} }).ok).toBe(false);
    expect(scheduler.windowGate({}).ok).toBe(false);
  });

  it("envio automático ignora as janelas de propósito — não está parada", () => {
    expect(scheduler.windowGate({ schedule: { windows: [] }, scraping: { autoSend: true } }).ok).toBe(true);
    // Só o true explícito vale.
    expect(scheduler.windowGate({ schedule: { windows: [] }, scraping: { autoSend: "sim" } }).ok).toBe(false);
  });
});

describe("scheduler.shuffleArray / shuffleAfterRefill — misturar a fila", () => {
  it("shuffleArray devolve os mesmos itens, sem mexer no array original", () => {
    const orig = [1, 2, 3, 4, 5, 6, 7, 8];
    const out = scheduler.shuffleArray(orig);
    expect(out).toHaveLength(orig.length);
    expect([...out].sort((a, b) => a - b)).toEqual(orig);
    expect(orig).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("shuffleArray aguenta vazio e undefined", () => {
    expect(scheduler.shuffleArray([])).toEqual([]);
    expect(scheduler.shuffleArray(undefined)).toEqual([]);
  });

  it("shuffleAfterRefill é desligado por padrão e só liga com true explícito", () => {
    expect(scheduler.shuffleAfterRefill({})).toBe(false);
    expect(scheduler.shuffleAfterRefill({ scraping: {} })).toBe(false);
    expect(scheduler.shuffleAfterRefill({ scraping: { shuffleAfterRefill: "sim" } })).toBe(false);
    expect(scheduler.shuffleAfterRefill({ scraping: { shuffleAfterRefill: true } })).toBe(true);
  });
});

describe("scheduler.sortMode / batchSize — ordem e tamanho do lote da busca", () => {
  it("sortMode aceita os modos do catálogo e cai no padrão pro resto", () => {
    expect(scheduler.sortMode({ sortBy: "price_asc" })).toBe("price_asc");
    expect(scheduler.sortMode({ sortBy: "lastSeen_desc" })).toBe("lastSeen_desc");
    expect(scheduler.sortMode({ sortBy: "inventado" })).toBe("discount_desc");
    expect(scheduler.sortMode({})).toBe("discount_desc");
    expect(scheduler.sortMode(undefined)).toBe("discount_desc");
  });

  it("batchSize usa o valor salvo, com teto de 50 e padrão de 20", () => {
    expect(scheduler.batchSize({ batchSize: 5 })).toBe(5);
    expect(scheduler.batchSize({ batchSize: "7" })).toBe(7);
    expect(scheduler.batchSize({ batchSize: 999 })).toBe(50);
    expect(scheduler.batchSize({ batchSize: 0 })).toBe(20);
    expect(scheduler.batchSize({ batchSize: -3 })).toBe(20);
    expect(scheduler.batchSize({})).toBe(20);
    expect(scheduler.batchSize(undefined)).toBe(20);
  });
});

describe("scheduler.isAutoApprove — revisão só existe no repasse", () => {
  it("campanha de catálogo manda direto pra fila, mesmo com o auto:false antigo", () => {
    expect(scheduler.isAutoApprove({ scraping: {} })).toBe(true);
    expect(scheduler.isAutoApprove({ scraping: { auto: false } })).toBe(true);
  });

  it("repasse mantém a aprovação manual dos links capturados", () => {
    expect(scheduler.isAutoApprove({ scraping: { kind: "repasse" } })).toBe(true);
    expect(scheduler.isAutoApprove({ scraping: { kind: "repasse", auto: false } })).toBe(false);
  });
});

describe("scheduler.autoRefillDue — quando o preenchimento automático dispara", () => {
  const baseGroup = (scraping, queue = [], pending = []) => ({
    id: 1, scraping, queue, pending,
  });

  it("refillThreshold: valor salvo, com teto e padrão 5", () => {
    expect(scheduler.refillThreshold({ refillThreshold: 12 })).toBe(12);
    expect(scheduler.refillThreshold({ refillThreshold: "8" })).toBe(8);
    expect(scheduler.refillThreshold({ refillThreshold: 999 })).toBe(50);
    expect(scheduler.refillThreshold({ refillThreshold: 0 })).toBe(5);
    expect(scheduler.refillThreshold({})).toBe(5);
  });

  it("refillTimes aceita só HH:MM, sem repetidos e em ordem", () => {
    expect(scheduler.refillTimes({ refillTimes: ["14:30", "08:00", "14:30", "25:00", "abc", ""] }))
      .toEqual(["08:00", "14:30"]);
    expect(scheduler.refillTimes({})).toEqual([]);
    expect(scheduler.refillTimes({ refillTimes: "08:00" })).toEqual([]);
  });

  it("refillMode é 'threshold' a não ser que a campanha peça 'schedule'", () => {
    expect(scheduler.refillMode({})).toBe("threshold");
    expect(scheduler.refillMode({ refillMode: "schedule" })).toBe("schedule");
    expect(scheduler.refillMode({ refillMode: "qualquer" })).toBe("threshold");
  });

  it("modo fila acabando: dispara abaixo do número, e só dentro da janela", () => {
    const now = new Date();
    const g = (n) => baseGroup({ refillThreshold: 3 }, new Array(n).fill({}));
    expect(scheduler.autoRefillDue(g(2), now, true).go).toBe(true);
    expect(scheduler.autoRefillDue(g(3), now, true).go).toBe(false);
    // fora da janela de envio não busca, mesmo com a fila vazia
    expect(scheduler.autoRefillDue(g(0), now, false).go).toBe(false);
  });

  it("modo fila acabando conta os pendentes junto da fila", () => {
    const now = new Date();
    const g = baseGroup({ refillThreshold: 3 }, [{}], [{}, {}]);
    expect(scheduler.autoRefillDue(g, now, true).go).toBe(false);
  });

  it("modo horários: dispara no horário que acabou de passar, mesmo fora da janela", () => {
    const now = new Date();
    now.setHours(10, 5, 0, 0);
    const g = baseGroup({ refillMode: "schedule", refillTimes: ["10:00", "18:00"] });
    const due = scheduler.autoRefillDue(g, now, false);
    expect(due.go).toBe(true);
    expect(due.slot).toBe("10:00");
  });

  it("modo horários: uma vez marcado, o mesmo horário não repete no dia", () => {
    const now = new Date();
    now.setHours(10, 5, 0, 0);
    const g = { ...baseGroup({ refillMode: "schedule", refillTimes: ["10:00"] }), id: 4242 };
    const due = scheduler.autoRefillDue(g, now, false);
    expect(due.go).toBe(true);
    scheduler.markAutoRefill(g.id, now, due.slot);
    expect(scheduler.autoRefillDue(g, now, false).go).toBe(false);
    // o tick 30s depois também não repete
    const later = new Date(now.getTime() + 30000);
    expect(scheduler.autoRefillDue(g, later, false).go).toBe(false);
  });

  it("modo horários: horário antigo demais não dispara (evita rodar o dia todo no restart)", () => {
    const now = new Date();
    now.setHours(23, 0, 0, 0);
    const g = baseGroup({ refillMode: "schedule", refillTimes: ["08:00"] });
    expect(scheduler.autoRefillDue(g, now, true).go).toBe(false);
  });

  it("modo horários sem nenhum horário não dispara nada", () => {
    const g = baseGroup({ refillMode: "schedule", refillTimes: [] });
    expect(scheduler.autoRefillDue(g, new Date(), true).go).toBe(false);
  });
});

describe("scheduler.renderTemplate — mensagem do envio", () => {
  const produto = {
    name: "Mouse Pro",
    price: 149.9,
    originalPrice: 299.9,
    discount: 50,
    store: "Amazon",
    link: "https://amzn.to/x",
  };

  it("substitui todos os placeholders", () => {
    const out = scheduler.renderTemplate(
      "🔥 {produto} por {preco} (era {preco_antigo}) — {desconto} OFF na {loja}\n{link}",
      produto
    );
    expect(out).toContain("Mouse Pro");
    expect(out).toContain("R$ 149,90");
    expect(out).toContain("R$ 299,90");
    expect(out).toContain("50% OFF");
    expect(out).toContain("Amazon");
    expect(out).toContain("https://amzn.to/x");
  });

  it("placeholder repetido substitui todas as ocorrências", () => {
    const out = scheduler.renderTemplate("{produto} / {produto}", produto);
    expect(out).toBe("Mouse Pro / Mouse Pro");
  });

  it("campos ausentes: preço vira — e strings viram vazio", () => {
    const out = scheduler.renderTemplate("{produto}|{preco}|{loja}|{link}", {});
    expect(out).toBe("|—||");
  });

  // Item sem promoção não mostra "de" nem "desconto": a linha inteira sai.
  it("sem promoção, a linha com {desconto} some; com promoção ela fica", () => {
    expect(scheduler.renderTemplate("{produto}|{desconto}|{link}", {})).toBe("");
    expect(scheduler.renderTemplate("{produto}|{desconto}|{link}", { name: "X", discount: 30, link: "L" }))
      .toBe("X|30%|L");
  });

  it("{vendas} usa soldCount numérico compacto ou sold em texto; sem dado fica vazio", () => {
    expect(scheduler.renderTemplate("{vendas}", { soldCount: 1500 })).toBe("1,5 mil vendidos");
    expect(scheduler.renderTemplate("{vendas}", { sold: "500+ vendidos" })).toBe("500+ vendidos");
    expect(scheduler.renderTemplate("{vendas}", { sold: "500+" })).toBe("500+ vendidos");
    expect(scheduler.renderTemplate("{vendas}", {})).toBe("");
  });

  it("template null/undefined vira string vazia", () => {
    expect(scheduler.renderTemplate(null, produto)).toBe("");
    expect(scheduler.renderTemplate(undefined, produto)).toBe("");
  });

  it("{cupom} com valor entra normalmente", () => {
    const out = scheduler.renderTemplate("{produto}\n🎟️ Cupom: {cupom}\n{link}", { ...produto, coupon: "JBL20" });
    expect(out).toBe("Mouse Pro\n🎟️ Cupom: JBL20\nhttps://amzn.to/x");
  });

  it("sem cupom: a linha inteira que contém {cupom} some (nada de 'Cupom:' vazio)", () => {
    const tpl = "{produto}\n🎟️ Cupom: {cupom}\n🛒 {link}";
    expect(scheduler.renderTemplate(tpl, produto)).toBe("Mouse Pro\n🛒 https://amzn.to/x");
    expect(scheduler.renderTemplate(tpl, { ...produto, coupon: "  " })).toBe("Mouse Pro\n🛒 https://amzn.to/x");
  });
});

describe("scheduler.isAutoApprove / isRepasse", () => {
  it("campanha de catálogo sempre aprova (a revisão saiu da aba de busca)", () => {
    expect(scheduler.isAutoApprove({})).toBe(true);
    expect(scheduler.isAutoApprove({ scraping: {} })).toBe(true);
    expect(scheduler.isAutoApprove({ scraping: { auto: false } })).toBe(true);
    expect(scheduler.isAutoApprove({ scraping: { auto: true } })).toBe(true);
  });

  it("no repasse o auto:false continua mandando pra revisão", () => {
    expect(scheduler.isAutoApprove({ scraping: { kind: "repasse", auto: false } })).toBe(false);
    expect(scheduler.isAutoApprove({ scraping: { kind: "repasse" } })).toBe(true);
  });

  it("isRepasse só com kind='repasse'", () => {
    expect(scheduler.isRepasse({ scraping: { kind: "repasse" } })).toBe(true);
    expect(scheduler.isRepasse({ scraping: { kind: "scraping" } })).toBe(false);
    expect(scheduler.isRepasse({})).toBe(false);
    expect(scheduler.isRepasse(null)).toBe(false);
  });
});

describe("scheduler.resolveSources — normalização", () => {
  it("deduplica e normaliza; vazio cai em ['ml']", () => {
    expect(scheduler.resolveSources(["ml", "ml", "amazon"])).toEqual(["ml", "amazon"]);
    expect(scheduler.resolveSources([])).toEqual(["ml"]);
    expect(scheduler.resolveSources(null)).toEqual(["ml"]);
  });
});

// Produtos que têm cupom do ML (tarefa 100). O "off" é o default e não muda nada
// em campanha nenhuma — é o que garante que ligar isso não mexe com quem já roda.
describe("couponMode", () => {
  it("config sem o campo, ou com lixo, é 'off'", () => {
    expect(scheduler.couponMode(undefined)).toBe("off");
    expect(scheduler.couponMode({})).toBe("off");
    expect(scheduler.couponMode({ couponBoost: "sim" })).toBe("off");
    expect(scheduler.couponMode({ couponBoost: null })).toBe("off");
  });

  it("os três modos válidos passam", () => {
    expect(scheduler.couponMode({ couponBoost: "off" })).toBe("off");
    expect(scheduler.couponMode({ couponBoost: "prefer" })).toBe("prefer");
    expect(scheduler.couponMode({ couponBoost: "only" })).toBe("only");
  });
});

describe("sortByCoupon", () => {
  const produtos = [
    { key: "a", discount: 50 },
    { key: "b", discount: 40 },
    { key: "c", discount: 30 },
    { key: "d", discount: 20 },
  ];

  it("os com cupom vêm na frente, sem embaralhar a ordem da campanha", () => {
    const comCupom = new Map([["c", {}], ["b", {}]]);
    expect(scheduler.sortByCoupon(produtos, comCupom).map(p => p.key)).toEqual(["b", "c", "a", "d"]);
  });

  it("ninguém com cupom = lista intacta", () => {
    expect(scheduler.sortByCoupon(produtos, new Map()).map(p => p.key)).toEqual(["a", "b", "c", "d"]);
  });
});
