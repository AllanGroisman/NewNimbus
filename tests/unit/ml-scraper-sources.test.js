// De onde o robô do Mercado Livre tira as ofertas — vitrine pública, Hub de
// Afiliados, ou as duas — e qual delas enche a cota primeiro.
// O que importa aqui: nunca ficar sem fonte nenhuma, e quem já tinha desligado o
// Hub antes da tarefa 57 não ver ele voltar sozinho.

import "../helpers/env.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const backend = (...p) => require(path.resolve(__dirname, "..", "..", "backend", ...p));

const affiliate = backend("scraping", "affiliate.js");
const appConfig = backend("config", "index.js");

const SYSTEM_COOKIE = "ssid=cookie-da-conta-do-sistema; orguseridp=123456";

beforeEach(() => {
  delete process.env.ML_SCRAPER_COOKIE;
  appConfig.del("ml-scraper-sources");
  affiliate.clearScraperMLAdminSession();
});

afterEach(() => {
  delete process.env.ML_SCRAPER_COOKIE;
  appConfig.del("ml-scraper-sources");
  affiliate.clearScraperMLAdminSession();
});

describe("readMLScraperSources", () => {
  it("sem nada configurado: as duas ligadas, começando pelo Hub", () => {
    expect(affiliate.readMLScraperSources()).toEqual({ vitrine: true, hub: true, priority: "hub" });
  });

  it("herda o Hub desligado da configuração antiga (que morava na chave da sessão)", () => {
    appConfig.set("scraper-ml-admin", { cookie: SYSTEM_COOKIE, hubEnabled: false });
    expect(affiliate.readMLScraperSources().hub).toBe(false);
    expect(affiliate.readMLScraperSources().vitrine).toBe(true);
  });

  it("configuração nova ganha da antiga", () => {
    appConfig.set("scraper-ml-admin", { cookie: SYSTEM_COOKIE, hubEnabled: false });
    affiliate.writeMLScraperSources({ hub: true });
    expect(affiliate.readMLScraperSources().hub).toBe(true);
  });
});

describe("writeMLScraperSources", () => {
  it("salva só o que veio no patch", () => {
    affiliate.writeMLScraperSources({ priority: "vitrine" });
    expect(affiliate.readMLScraperSources()).toEqual({ vitrine: true, hub: true, priority: "vitrine" });

    affiliate.writeMLScraperSources({ hub: false });
    expect(affiliate.readMLScraperSources()).toEqual({ vitrine: true, hub: false, priority: "vitrine" });
  });

  it("recusa desligar as duas fontes", () => {
    affiliate.writeMLScraperSources({ hub: false });
    expect(() => affiliate.writeMLScraperSources({ vitrine: false })).toThrow(/pelo menos uma fonte/i);
    // E não deixou meia configuração salva.
    expect(affiliate.readMLScraperSources().vitrine).toBe(true);
  });

  it("prioridade inválida não sobrescreve a atual", () => {
    affiliate.writeMLScraperSources({ priority: "vitrine" });
    affiliate.writeMLScraperSources({ priority: "shopee" });
    expect(affiliate.readMLScraperSources().priority).toBe("vitrine");
  });
});

describe("orderedMLSources", () => {
  it("prioridade define quem vem primeiro", () => {
    expect(affiliate.orderedMLSources({ vitrine: true, hub: true, priority: "hub" })).toEqual(["hub", "vitrine"]);
    expect(affiliate.orderedMLSources({ vitrine: true, hub: true, priority: "vitrine" })).toEqual(["vitrine", "hub"]);
  });

  it("fonte desligada sai da lista, mesmo sendo a prioritária", () => {
    expect(affiliate.orderedMLSources({ vitrine: true, hub: false, priority: "hub" })).toEqual(["vitrine"]);
    expect(affiliate.orderedMLSources({ vitrine: false, hub: true, priority: "vitrine" })).toEqual(["hub"]);
  });

  it("sem argumento lê a configuração salva", () => {
    affiliate.writeMLScraperSources({ priority: "vitrine" });
    expect(affiliate.orderedMLSources()).toEqual(["vitrine", "hub"]);
  });
});

describe("mlHubEnabled / mlVitrineEnabled", () => {
  it("Hub marcado mas sem sessão do sistema não coleta", () => {
    expect(affiliate.readMLScraperSources().hub).toBe(true);
    expect(affiliate.mlHubEnabled()).toBe(false);
  });

  it("com sessão do sistema e marcado, coleta", () => {
    affiliate.writeScraperMLAdminSession({ cookie: SYSTEM_COOKIE });
    expect(affiliate.mlHubEnabled()).toBe(true);
  });

  it("desmarcado não coleta nem com sessão", () => {
    affiliate.writeScraperMLAdminSession({ cookie: SYSTEM_COOKIE });
    affiliate.writeMLScraperSources({ hub: false });
    expect(affiliate.mlHubEnabled()).toBe(false);
  });

  it("apagar a sessão do sistema não mexe na escolha da vitrine", () => {
    affiliate.writeScraperMLAdminSession({ cookie: SYSTEM_COOKIE });
    affiliate.writeMLScraperSources({ vitrine: false });

    affiliate.clearScraperMLAdminSession();
    expect(affiliate.mlVitrineEnabled()).toBe(false);
    expect(affiliate.readMLScraperSources().hub).toBe(true);
  });
});
