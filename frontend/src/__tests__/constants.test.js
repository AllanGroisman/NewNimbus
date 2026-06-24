// Helpers de data/constants.js — funções puras de categorias e detecção de afiliados.

import { describe, it, expect } from "vitest";
import {
  categoryLabel, categoryColor, categoryIcon,
  getGroupCategories, getLinkedWhatsapps,
  groupUsesML, groupUsesShopee,
  getGroupStats,
  CATEGORIES, allSources, sidebarItems,
  computeQueueETA, formatETA,
} from "../data/constants.js";

describe("Categories — lookup helpers", () => {
  it("categoryLabel devolve label conhecido", () => {
    expect(categoryLabel("gamer")).toBe("Gamer");
    expect(categoryLabel("bebe")).toBe("Bebê");
    expect(categoryLabel("eletronicos")).toBe("Eletrônicos");
  });

  it("categoryLabel devolve a própria id quando categoria desconhecida", () => {
    expect(categoryLabel("xyz")).toBe("xyz");
  });

  it("categoryColor devolve color conhecido + gray como fallback", () => {
    expect(categoryColor("gamer")).toBe("blue");
    expect(categoryColor("desconhecida")).toBe("gray");
  });

  it("categoryIcon devolve icon conhecido + bullet como fallback", () => {
    expect(categoryIcon("casa")).toBe("🏠");
    expect(categoryIcon("xx")).toBe("•");
  });

  it("CATEGORIES é estável (snapshot rápido)", () => {
    expect(Object.keys(CATEGORIES)).toEqual(["gamer", "bebe", "eletronicos", "casa", "beleza", "brinquedos", "roupas", "esportes", "informatica", "pet"]);
  });

  it("allSources contém as lojas suportadas", () => {
    expect(allSources).toContain("Mercado Livre");
    expect(allSources).toContain("Amazon");
    expect(allSources).toContain("Shopee");
  });
});

describe("getGroupCategories — retrocompat", () => {
  it("usa categories quando array tem itens", () => {
    expect(getGroupCategories({ categories: ["gamer", "casa"] })).toEqual(["gamer", "casa"]);
  });

  it("fallback pra category legado (string)", () => {
    expect(getGroupCategories({ category: "bebe" })).toEqual(["bebe"]);
  });

  it("categories array vazio cai pro category legado", () => {
    expect(getGroupCategories({ categories: [], category: "casa" })).toEqual(["casa"]);
  });

  it("retorna [] quando não tem nada", () => {
    expect(getGroupCategories({})).toEqual([]);
    expect(getGroupCategories(null)).toEqual([]);
  });
});

describe("groupUsesML / groupUsesShopee", () => {
  it("default (sources não definido) = usa ML", () => {
    expect(groupUsesML({})).toBe(true);
    expect(groupUsesML({ scraping: {} })).toBe(true);
    expect(groupUsesML({ scraping: { sources: [] } })).toBe(true);
  });

  it("usa ML quando 'Mercado Livre' nas sources", () => {
    expect(groupUsesML({ scraping: { sources: ["Mercado Livre"] } })).toBe(true);
    expect(groupUsesML({ scraping: { sources: ["Amazon", "Mercado Livre"] } })).toBe(true);
  });

  it("não usa ML quando sources é só outras lojas", () => {
    expect(groupUsesML({ scraping: { sources: ["Amazon"] } })).toBe(false);
    expect(groupUsesML({ scraping: { sources: ["Shopee"] } })).toBe(false);
  });

  it("groupUsesShopee só quando Shopee aparece explicitamente", () => {
    expect(groupUsesShopee({})).toBe(false);
    expect(groupUsesShopee({ scraping: { sources: ["Amazon"] } })).toBe(false);
    expect(groupUsesShopee({ scraping: { sources: ["Shopee", "Amazon"] } })).toBe(true);
  });
});

describe("getLinkedWhatsapps", () => {
  const waGroups = [
    { id: "wa-1", name: "G1", status: "connected", members: 10 },
    { id: "wa-2", name: "G2", status: "disconnected", members: 5 },
    { id: "wa-3", name: "G3", status: "connected", members: 8 },
  ];

  it("filtra os grupos vinculados ao group", () => {
    const linked = getLinkedWhatsapps({ whatsappGroupIds: ["wa-1", "wa-3"] }, waGroups);
    expect(linked).toHaveLength(2);
    expect(linked.map(w => w.id)).toEqual(["wa-1", "wa-3"]);
  });

  it("retorna [] quando group não tem vínculo", () => {
    expect(getLinkedWhatsapps({}, waGroups)).toEqual([]);
  });
});

describe("sidebarItems — estrutura e ícones", () => {
  const allIds = sidebarItems.map(i => i.id);
  const adminItems = sidebarItems.filter(i => i.adminOnly);
  const userItems  = sidebarItems.filter(i => !i.adminOnly);

  it("contém os itens de navegação principais", () => {
    expect(allIds).toContain("dashboard");
    expect(allIds).toContain("whatsapp");
    expect(allIds).toContain("mercado-livre");
    expect(allIds).toContain("amazon");
    expect(allIds).toContain("shopee");
    expect(allIds).toContain("tutorials");
    expect(allIds).toContain("settings");
  });

  it("tem seções admin: ml, amazon e shopee", () => {
    const adminIds = adminItems.map(i => i.id);
    expect(adminIds).toContain("admin-ml");
    expect(adminIds).toContain("admin-amazon");
    expect(adminIds).toContain("admin-shopee");
  });

  it("nenhum item de usuário tem adminOnly=true", () => {
    for (const item of userItems) {
      expect(item.adminOnly).toBeFalsy();
    }
  });

  it("ícone de tutoriais não é emoji colorido — deve ser símbolo Unicode", () => {
    const tutorials = sidebarItems.find(i => i.id === "tutorials");
    expect(tutorials).toBeDefined();
    // Emojis são representados por code points U+1F000+ (surrogate pairs em JS)
    // um símbolo puro como ⊙ tem comprimento 1 e não é surrogado
    const icon = tutorials.icon;
    expect(icon.length).toBe(1);
    expect(icon.codePointAt(0)).toBeLessThan(0x10000); // não é emoji high-surrogate
  });

  it("todos os itens têm id, label e icon preenchidos", () => {
    for (const item of sidebarItems) {
      expect(item.id).toBeTruthy();
      expect(item.label).toBeTruthy();
      expect(item.icon).toBeTruthy();
    }
  });
});

describe("computeQueueETA", () => {
  const now = new Date("2024-01-15T10:00:00");
  const windows = [{ from: "08:00", to: "22:00", interval: 30 }];

  it("retorna array vazio quando fila vazia", () => {
    const group = { queue: [], schedule: { windows } };
    expect(computeQueueETA(group, now)).toEqual([]);
  });

  it("retorna nulls quando não há janelas", () => {
    const group = { queue: [{}], schedule: { windows: [] } };
    expect(computeQueueETA(group, now)).toEqual([null]);
  });

  it("agendamento sequencial respeita o intervalo da janela", () => {
    const group = { queue: [{}, {}], schedule: { windows } };
    const [t1, t2] = computeQueueETA(group, now);
    expect(t1).toBeInstanceOf(Date);
    expect(t2).toBeInstanceOf(Date);
    // t2 deve ser ao menos 30 min depois de t1
    expect(t2.getTime() - t1.getTime()).toBeGreaterThanOrEqual(30 * 60 * 1000);
  });

  it("retorna null quando janela tem from >= to (impossível)", () => {
    // from == to → slotMin nunca é < to → nextSlot sempre retorna null
    const impossibleWin = [{ from: "10:00", to: "10:00", interval: 30 }];
    const group = { queue: [{}, {}], schedule: { windows: impossibleWin } };
    const etas = computeQueueETA(group, now);
    expect(etas.every(e => e === null)).toBe(true);
  });
});

describe("formatETA", () => {
  const now = new Date("2024-01-15T10:00:00");

  it("retorna '—' para null", () => {
    expect(formatETA(null, now)).toBe("—");
  });

  it("retorna só HH:MM quando é hoje", () => {
    const d = new Date("2024-01-15T14:30:00");
    expect(formatETA(d, now)).toBe("14:30");
  });

  it("retorna DD/MM HH:MM quando é outro dia", () => {
    const d = new Date("2024-01-16T09:05:00");
    expect(formatETA(d, now)).toBe("16/01 09:05");
  });
});

describe("getGroupStats — derivações", () => {
  const waGroups = [
    { id: "wa-1", status: "connected", members: 10 },
    { id: "wa-2", status: "disconnected", members: 5 },
  ];

  it("soma members + conta conectados", () => {
    const stats = getGroupStats(
      { whatsappGroupIds: ["wa-1", "wa-2"] },
      waGroups,
      { affiliateConfigured: true },
    );
    expect(stats.members).toBe(15);
    expect(stats.connected).toBe(1);
    expect(stats.count).toBe(2);
  });

  it("status=empty quando não há grupos vinculados", () => {
    const stats = getGroupStats({}, waGroups, { affiliateConfigured: true });
    expect(stats.status).toBe("empty");
    expect(stats.count).toBe(0);
  });

  it("pausedByAffiliateML quando ML não configurado e grupo usa ML", () => {
    const stats = getGroupStats(
      { whatsappGroupIds: ["wa-1"], scraping: { sources: ["Mercado Livre"] } },
      waGroups,
      { affiliateConfigured: { ml: false, shopee: true } },
    );
    expect(stats.pausedByAffiliateML).toBe(true);
  });

  it("pausedByAffiliateShopee quando Shopee não configurado e grupo usa Shopee", () => {
    const stats = getGroupStats(
      { whatsappGroupIds: ["wa-1"], scraping: { sources: ["Shopee"] } },
      waGroups,
      { affiliateConfigured: { ml: true, shopee: false } },
    );
    expect(stats.pausedByAffiliateShopee).toBe(true);
  });

  it("pausedManual = true quando group.paused", () => {
    const stats = getGroupStats(
      { whatsappGroupIds: ["wa-1"], paused: true },
      waGroups,
    );
    expect(stats.pausedManual).toBe(true);
  });
});
