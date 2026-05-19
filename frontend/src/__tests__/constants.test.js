// Helpers de data/constants.js — funções puras de categorias e detecção de afiliados.

import { describe, it, expect } from "vitest";
import {
  categoryLabel, categoryColor, categoryIcon,
  getGroupCategories, getLinkedWhatsapps,
  groupUsesML, groupUsesShopee,
  getGroupStats,
  CATEGORIES, allSources,
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
    expect(Object.keys(CATEGORIES)).toEqual(["gamer", "bebe", "eletronicos", "casa", "beleza"]);
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
