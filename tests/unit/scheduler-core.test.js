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
    const out = scheduler.renderTemplate("{produto}|{preco}|{desconto}|{loja}|{link}", {});
    expect(out).toBe("|—|—||");
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
});

describe("scheduler.isAutoApprove / isRepasse", () => {
  it("auto default é true (legado); false só quando explícito", () => {
    expect(scheduler.isAutoApprove({})).toBe(true);
    expect(scheduler.isAutoApprove({ scraping: {} })).toBe(true);
    expect(scheduler.isAutoApprove({ scraping: { auto: false } })).toBe(false);
    expect(scheduler.isAutoApprove({ scraping: { auto: true } })).toBe(true);
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
