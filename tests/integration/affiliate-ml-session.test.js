// Sessão do Mercado Livre DA CONTA DO SISTEMA (usada pra abrir o Hub de Afiliados).
// O ponto mais importante aqui é o isolamento: essa sessão vive em appConfig e não
// pode encostar no cookie que cada cliente salva na aba dele (affiliate_config),
// nem o contrário — são credenciais de donos diferentes.

import "../helpers/env.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const backend = (...p) => require(path.resolve(__dirname, "..", "..", "backend", ...p));

const affiliate = backend("scraping", "affiliate.js");
const { prisma } = backend("db.js");

const SYSTEM_COOKIE = "ssid=cookie-da-conta-do-sistema; orguseridp=123456";
const USER_COOKIE = "ssid=cookie-do-cliente; orguseridp=999999";
const TEST_USER_ID = "test-user-ml-session";

beforeEach(async () => {
  delete process.env.ML_SCRAPER_COOKIE;
  affiliate.clearScraperMLAdminSession();
  await prisma().user.upsert({
    where: { id: TEST_USER_ID },
    create: { id: TEST_USER_ID, email: `${TEST_USER_ID}@test.local`, name: "Unit", passwordHash: "x" },
    update: {},
  });
  affiliate.clearMLConfig(TEST_USER_ID);
});

afterEach(() => {
  delete process.env.ML_SCRAPER_COOKIE;
  affiliate.clearScraperMLAdminSession();
});

describe("sessão ML do sistema", () => {
  it("salva, lê e apaga", () => {
    affiliate.writeScraperMLAdminSession({ cookie: SYSTEM_COOKIE });
    const saved = affiliate.readScraperMLAdminSession();
    expect(saved.cookie).toBe(SYSTEM_COOKIE);
    expect(saved.updatedAt).toBeTruthy();

    affiliate.clearScraperMLAdminSession();
    expect(affiliate.readScraperMLAdminSession().cookie).toBe(null);
  });

  it("recusa cola que não parece cookie", () => {
    expect(() => affiliate.writeScraperMLAdminSession({ cookie: "" })).toThrow();
    expect(() => affiliate.writeScraperMLAdminSession({ cookie: "https://mercadolivre.com.br/afiliados/hub" })).toThrow();
    expect(() => affiliate.writeScraperMLAdminSession({ cookie: "x=1" })).toThrow();   // curto demais
  });

  it("cookie novo zera o resultado do teste anterior", () => {
    affiliate.writeScraperMLAdminSession({ cookie: SYSTEM_COOKIE });
    affiliate.recordMLHubCheck({ ok: true, reason: "Entrou no Hub (10 blocos de oferta visíveis)." });
    expect(affiliate.readScraperMLAdminSession().lastCheckOk).toBe(true);

    affiliate.writeScraperMLAdminSession({ cookie: `${SYSTEM_COOKIE}; extra=1` });
    const s = affiliate.readScraperMLAdminSession();
    expect(s.lastCheckOk).toBe(null);
    expect(s.lastCheckAt).toBe(null);
  });

  it("recordMLHubCheck guarda motivo da falha", () => {
    affiliate.writeScraperMLAdminSession({ cookie: SYSTEM_COOKIE });
    affiliate.recordMLHubCheck({ ok: false, reason: "O Mercado Livre pediu login" });
    const s = affiliate.readScraperMLAdminSession();
    expect(s.lastCheckOk).toBe(false);
    expect(s.lastCheckReason).toMatch(/login/);
    expect(s.lastCheckAt).toBeTruthy();
  });
});

describe("getScraperMLSession", () => {
  it("sem nada configurado devolve null", () => {
    expect(affiliate.getScraperMLSession()).toBe(null);
  });

  it("usa a sessão do admin quando salva", () => {
    affiliate.writeScraperMLAdminSession({ cookie: SYSTEM_COOKIE });
    expect(affiliate.getScraperMLSession()).toEqual({ cookie: SYSTEM_COOKIE, source: "admin" });
  });

  it("env ML_SCRAPER_COOKIE ganha do admin", () => {
    affiliate.writeScraperMLAdminSession({ cookie: SYSTEM_COOKIE });
    process.env.ML_SCRAPER_COOKIE = "ssid=vem-do-ambiente; a=b";
    const s = affiliate.getScraperMLSession();
    expect(s.source).toBe("env");
    expect(s.cookie).toBe("ssid=vem-do-ambiente; a=b");
  });

  it("NUNCA cai no cookie de um usuário", () => {
    affiliate.writeMLConfig(TEST_USER_ID, { tag: "tag-do-cliente", cookie: USER_COOKIE });
    expect(affiliate.getScraperMLSession()).toBe(null);
  });
});

describe("isolamento entre a sessão do sistema e o cookie do usuário", () => {
  it("salvar/apagar a sessão do sistema não mexe no cookie do cliente", () => {
    affiliate.writeMLConfig(TEST_USER_ID, { tag: "tag-do-cliente", cookie: USER_COOKIE });

    affiliate.writeScraperMLAdminSession({ cookie: SYSTEM_COOKIE });
    expect(affiliate.readMLConfig(TEST_USER_ID).cookie).toBe(USER_COOKIE);

    affiliate.clearScraperMLAdminSession();
    const cfg = affiliate.readMLConfig(TEST_USER_ID);
    expect(cfg.cookie).toBe(USER_COOKIE);
    expect(cfg.tag).toBe("tag-do-cliente");
  });

  it("apagar o cookie do cliente não mexe na sessão do sistema", () => {
    affiliate.writeScraperMLAdminSession({ cookie: SYSTEM_COOKIE });
    affiliate.writeMLConfig(TEST_USER_ID, { tag: "tag-do-cliente", cookie: USER_COOKIE });

    affiliate.clearMLConfig(TEST_USER_ID);
    expect(affiliate.readMLConfig(TEST_USER_ID).cookie).toBe(null);
    expect(affiliate.getScraperMLSession()).toEqual({ cookie: SYSTEM_COOKIE, source: "admin" });
  });
});

// O liga/desliga do Hub e a prioridade entre as fontes moram em
// tests/unit/ml-scraper-sources.test.js (chave própria desde a tarefa 57).
