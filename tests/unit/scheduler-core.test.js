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

describe("queueEmptyAlert", () => {
  it("envio instantâneo nunca avisa fila vazia — ela esvazia a cada produto", () => {
    expect(scheduler.queueEmptyAlert({ scraping: { autoSend: true } }, true, 0)).toBe(false);
  });

  it("sem envio instantâneo avisa fila vazia dentro da janela", () => {
    expect(scheduler.queueEmptyAlert({}, true, 0)).toBe(true);
    // Só o true explícito liga o envio instantâneo.
    expect(scheduler.queueEmptyAlert({ scraping: { autoSend: "sim" } }, true, 0)).toBe(true);
  });

  it("fora da janela ou com itens na fila não avisa", () => {
    expect(scheduler.queueEmptyAlert({}, false, 0)).toBe(false);
    expect(scheduler.queueEmptyAlert({}, true, 3)).toBe(false);
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

  // Regra única: variável sem valor derruba a linha inteira — nada de "—" nem
  // rótulo solto ("🏪 " sem loja).
  it("variável sem valor derruba a linha inteira", () => {
    expect(scheduler.renderTemplate("{produto}|{preco}|{loja}|{link}", {})).toBe("");
    const tpl = "🔥 {produto}\n🏪 {loja}\n📦 {vendas}\n✅ {preco}\n🛒 {link}";
    expect(scheduler.renderTemplate(tpl, { name: "X", price: 10, link: "L" }))
      .toBe("🔥 X\n✅ R$ 10,00\n🛒 L");
  });

  it("linhas em branco que sobram quando um bloco some viram uma só (e as pontas são aparadas)", () => {
    const tpl = "{produto}\n\n🎟️ {cupom}\n🏷️ {desconto_cupom}\n\n🛒 {link}\n";
    expect(scheduler.renderTemplate(tpl, { name: "X", link: "L" })).toBe("X\n\n🛒 L");
  });

  it("token desconhecido fica como está e não derruba a linha", () => {
    expect(scheduler.renderTemplate("{produto} {xyz}", { name: "X" })).toBe("X {xyz}");
  });

  it("nome do produto com chaves não vira outra variável", () => {
    expect(scheduler.renderTemplate("{produto}", { name: "Kit {link}" })).toBe("Kit {link}");
  });

  // Item sem promoção não mostra "de" nem "desconto": a linha inteira sai.
  it("sem promoção, a linha com {desconto} some; com promoção ela fica", () => {
    expect(scheduler.renderTemplate("{produto}|{desconto}|{link}", {})).toBe("");
    expect(scheduler.renderTemplate("{produto}|{desconto}|{link}", { name: "X", discount: 30, link: "L" }))
      .toBe("X|30%|L");
  });

  // A Shopee manda discount 0 (não null) quando não há promoção — antes isso
  // virava "De: —" e "Desconto: -—".
  it("Shopee sem promoção (discount 0): as linhas de {preco_antigo} e {desconto} somem", () => {
    const tpl = "💰 De: {preco_antigo}\n✅ Por: {preco}\n🏷️ Desconto: -{desconto}";
    expect(scheduler.renderTemplate(tpl, { price: 50, originalPrice: null, discount: 0, store: "Shopee" }))
      .toBe("✅ Por: R$ 50,00");
  });

  // Card do ML com a pílula "42% OFF" mas sem o preço riscado.
  it("desconto sem preço antigo: some só a linha do {preco_antigo}", () => {
    const tpl = "De: {preco_antigo}\nPor: {preco}\n{desconto} OFF";
    expect(scheduler.renderTemplate(tpl, { price: 58, originalPrice: null, discount: 42 }))
      .toBe("Por: R$ 58,00\n42% OFF");
  });

  it("preço antigo sem desconto: o {desconto} sai do par de preços", () => {
    expect(scheduler.renderTemplate("{desconto}", { price: 75, originalPrice: 100, discount: null })).toBe("25%");
  });

  it("preço antigo igual ou menor que o atual é dado ruim: a linha some", () => {
    const tpl = "De: {preco_antigo}\nPor: {preco}\n{desconto}";
    expect(scheduler.renderTemplate(tpl, { price: 100, originalPrice: 100, discount: null })).toBe("Por: R$ 100,00");
  });

  it("{economia} é preço antigo − preço; sem promoção a linha some", () => {
    expect(scheduler.renderTemplate("Economize {economia}", produto)).toBe("Economize R$ 150,00");
    expect(scheduler.renderTemplate("A\nEconomize {economia}", { price: 10 })).toBe("A");
  });

  it("{economia} não come o {economia_cupom} na substituição", () => {
    expect(scheduler.renderTemplate("{economia_cupom}", { ...produto, couponSaving: 22.5 })).toBe("R$ 22,50");
  });

  it("{frete} só com frete grátis informado", () => {
    expect(scheduler.renderTemplate("A\n🚚 {frete}", { freeShipping: true })).toBe("A\n🚚 Frete grátis");
    expect(scheduler.renderTemplate("A\n🚚 {frete}", { freeShipping: false })).toBe("A");
  });

  it("{avaliacao} com uma casa decimal; sem nota a linha some", () => {
    expect(scheduler.renderTemplate("⭐ {avaliacao}", { rating: 4.75 })).toBe("⭐ 4,8");
    expect(scheduler.renderTemplate("⭐ {avaliacao}", { rating: 5 })).toBe("⭐ 5,0");
    expect(scheduler.renderTemplate("A\n⭐ {avaliacao}", { rating: null })).toBe("A");
  });

  it("preço nunca sai com mais de 2 casas", () => {
    expect(scheduler.renderTemplate("{preco}", { price: 19.999 })).toBe("R$ 20,00");
    expect(scheduler.renderTemplate("{preco}", { price: 1899 })).toBe("R$ 1.899,00");
  });

  it("{vendas} usa soldCount numérico compacto ou sold em texto; sem dado a linha some", () => {
    expect(scheduler.renderTemplate("{vendas}", { soldCount: 1500 })).toBe("1,5 mil vendidos");
    expect(scheduler.renderTemplate("{vendas}", { sold: "500+ vendidos" })).toBe("500+ vendidos");
    expect(scheduler.renderTemplate("{vendas}", { sold: "500+" })).toBe("500+ vendidos");
    expect(scheduler.renderTemplate("A\n📦 {vendas}", {})).toBe("A");
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

  // {preco_com_cupom}: quem calcula é o sendItem (lê o cupom no banco na hora do
  // envio) e passa o número pronto em priceWithCoupon. Sem número: se o modelo já
  // mostra o {preco}, a linha some (não repete o mesmo preço); se é o único preço
  // do modelo, vira o {preco}.
  it("{preco_com_cupom} mostra o preço com desconto quando ele foi calculado", () => {
    const out = scheduler.renderTemplate("{preco} → {preco_com_cupom}", { ...produto, priceWithCoupon: 134.91 });
    expect(out).toBe("R$ 149,90 → R$ 134,91");
  });

  it("cupom que não vale e modelo sem {preco}: {preco_com_cupom} sai igual ao preço e a linha fica", () => {
    const tpl = "🔥 {produto}\n💸 Com cupom: {preco_com_cupom}\n{link}";
    expect(scheduler.renderTemplate(tpl, produto))
      .toBe("🔥 Mouse Pro\n💸 Com cupom: R$ 149,90\nhttps://amzn.to/x");
    // priceWithCoupon explicitamente nulo é o caso comum (sendItem não achou cupom).
    expect(scheduler.renderTemplate(tpl, { ...produto, priceWithCoupon: null }))
      .toBe("🔥 Mouse Pro\n💸 Com cupom: R$ 149,90\nhttps://amzn.to/x");
  });

  it("cupom que não vale e modelo com {preco}: a linha do {preco_com_cupom} some", () => {
    const tpl = "✅ Por: {preco}\n🎟️ Cupom: {cupom}\n💸 Com cupom: {preco_com_cupom}";
    expect(scheduler.renderTemplate(tpl, produto)).toBe("✅ Por: R$ 149,90");
    // Palavra sem regra (cupom da Amazon no repasse): o {cupom} fica, o preço não repete.
    expect(scheduler.renderTemplate(tpl, { ...produto, coupon: "AMZ10" }))
      .toBe("✅ Por: R$ 149,90\n🎟️ Cupom: AMZ10");
    expect(scheduler.renderTemplate(tpl, { ...produto, coupon: "JBL20", priceWithCoupon: 134.91 }))
      .toBe("✅ Por: R$ 149,90\n🎟️ Cupom: JBL20\n💸 Com cupom: R$ 134,91");
  });

  it("se a linha do {preco} caiu por outro motivo, o {preco_com_cupom} fica e mostra o preço", () => {
    const tpl = "Por {preco} ({desconto} OFF)\nCom cupom {preco_com_cupom}";
    expect(scheduler.renderTemplate(tpl, { price: 10 })).toBe("Com cupom R$ 10,00");
  });

  it("{preco} e {preco_com_cupom} na mesma linha: sem cupom a linha fica, com o preço normal", () => {
    expect(scheduler.renderTemplate("{preco} / {preco_com_cupom}", { price: 10 })).toBe("R$ 10,00 / R$ 10,00");
  });

  it("sem preço nenhum, as linhas de {preco} e {preco_com_cupom} somem", () => {
    expect(scheduler.renderTemplate("A\n{preco}\n{preco_com_cupom}", {})).toBe("A");
    expect(scheduler.renderTemplate("A\n{preco_com_cupom}", {})).toBe("A");
  });

  // {desconto_cupom} e {economia_cupom}: quem calcula é o sendItem (detalheDoCupom
  // contra o cupom no banco na hora do envio) — aqui só chegam prontos, ou nulos.
  it("{desconto_cupom} e {economia_cupom} entram quando o cupom vale", () => {
    const out = scheduler.renderTemplate(
      "{produto}\n🏷️ {desconto_cupom}\n💸 Economize {economia_cupom}",
      { ...produto, coupon: "JBL20", couponLabel: "15% OFF", couponSaving: 284.85 },
    );
    expect(out).toBe("Mouse Pro\n🏷️ 15% OFF\n💸 Economize R$ 284,85");
  });

  it("sem cupom válido, as linhas de {desconto_cupom} e {economia_cupom} somem", () => {
    const tpl = "🔥 {produto}\n🏷️ Cupom: {desconto_cupom}\n💸 Economize {economia_cupom}\n{link}";
    expect(scheduler.renderTemplate(tpl, produto))
      .toBe("🔥 Mouse Pro\nhttps://amzn.to/x");
  });

  // Economia 0 não existe (precoComCupom recusa desconto que não muda o preço);
  // se um dia chegar, "Economize R$ 0,00" seria pior que linha nenhuma.
  it("{economia_cupom} zero derruba a linha", () => {
    expect(scheduler.renderTemplate("A\nE: {economia_cupom}", { ...produto, couponSaving: 0 }))
      .toBe("A");
  });

  it("{desconto} não come o {desconto_cupom} na substituição", () => {
    expect(scheduler.renderTemplate("{desconto_cupom}", { ...produto, couponLabel: "10% OFF" }))
      .toBe("10% OFF");
  });

  it("{preco} não come o {preco_com_cupom} na substituição", () => {
    expect(scheduler.renderTemplate("{preco_com_cupom}", { price: 10, priceWithCoupon: 8 })).toBe("R$ 8,00");
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
