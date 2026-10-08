// As duas contas Shopee e o papel de cada uma (tarefa 10).
//
// O que importa aqui:
//   - a conta DO SISTEMA (env → Admin › Shopee) faz toda busca na API e nunca
//     cai na conta de um usuário, nem quando ela é a única configurada;
//   - a conta DO USUÁRIO só gera os links dele: a env da Shopee não a
//     substitui nem impede de salvar;
//   - a busca de um item pelo link assina o pedido com a conta do sistema.
import "../helpers/env.js";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const backend = (...p) => require(path.resolve(__dirname, "..", "..", "backend", ...p));

const affiliate = backend("scraping", "affiliate.js");
const store = backend("scraping", "affiliate-store", "index.js");
const appConfig = backend("config", "index.js");
const db = backend("db.js");

const USER = "u-shopee";
const USER_CREDS = { appId: "18300000001", appSecret: "segredo-do-usuario-123" };
const ADMIN_CREDS = { appId: "app-do-sistema", appSecret: "segredo-do-sistema-123" };
const ENV_CREDS = { appId: "app-da-env", appSecret: "segredo-da-env-123456" };

const realFetch = globalThis.fetch;

// Os caches do affiliate-store e do app-config são os de verdade (é neles que um
// fallback pra "algum usuário configurado" procuraria); só a gravação no banco
// é de mentira.
const fakePrisma = () => {
  const op = { upsert: vi.fn(async () => ({})), delete: vi.fn(async () => ({})) };
  return { affiliateConfig: op, appConfig: op };
};

function setEnv(c) {
  process.env.SHOPEE_AFFILIATE_APP_ID = c.appId;
  process.env.SHOPEE_AFFILIATE_APP_SECRET = c.appSecret;
}

beforeEach(() => {
  delete process.env.SHOPEE_AFFILIATE_APP_ID;
  delete process.env.SHOPEE_AFFILIATE_APP_SECRET;
  vi.spyOn(db, "prisma").mockReturnValue(fakePrisma());
  affiliate.writeShopeeConfig(USER, USER_CREDS);
});

afterEach(() => {
  delete process.env.SHOPEE_AFFILIATE_APP_ID;
  delete process.env.SHOPEE_AFFILIATE_APP_SECRET;
  affiliate.clearShopeeConfig(USER);
  affiliate.clearShopeeConfig("outro-usuario");
  affiliate.clearScraperShopeeAdminCreds();
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("getScraperShopeeCreds — conta do sistema", () => {
  it("sem env nem admin: null, mesmo com um usuário configurado", () => {
    expect(affiliate.getScraperShopeeCreds()).toBeNull();
  });

  it("usa a credencial do Admin › Shopee", () => {
    affiliate.writeScraperShopeeAdminCreds(ADMIN_CREDS);
    expect(affiliate.getScraperShopeeCreds()).toEqual({ ...ADMIN_CREDS, source: "admin" });
  });

  it("a env ganha da credencial do admin", () => {
    affiliate.writeScraperShopeeAdminCreds(ADMIN_CREDS);
    setEnv(ENV_CREDS);
    expect(affiliate.getScraperShopeeCreds()).toEqual({ ...ENV_CREDS, source: "env" });
  });
});

describe("readShopeeConfig / writeShopeeConfig — conta do usuário", () => {
  it("a env da Shopee não substitui a conta do usuário", () => {
    setEnv(ENV_CREDS);
    expect(affiliate.readShopeeConfig(USER)).toMatchObject({ ...USER_CREDS, source: "file" });
    expect(affiliate.status(USER).shopee).toMatchObject({ configured: true, appId: USER_CREDS.appId, source: "file" });
  });

  it("quem não configurou continua sem conta, mesmo com a env setada", () => {
    setEnv(ENV_CREDS);
    expect(affiliate.readShopeeConfig("outro-usuario")).toMatchObject({ appId: null, appSecret: null, source: null });
  });

  it("salva com a env setada", () => {
    setEnv(ENV_CREDS);
    const saved = affiliate.writeShopeeConfig("outro-usuario", { appId: "18300000002", appSecret: "novo-segredo-123456" });
    expect(saved).toMatchObject({ appId: "18300000002", appSecret: "novo-segredo-123456" });
    expect(store.getRaw("outro-usuario").shopee).toMatchObject({ appId: "18300000002" });
  });
});

describe("fetchShopeeItemByIds — busca com a conta do sistema", () => {
  const node = { itemId: 1, shopId: 2, productName: "Produto", productLink: "https://shopee.com.br/product/2/1" };

  it("assina o pedido com a conta do sistema, não com a do usuário", async () => {
    affiliate.writeScraperShopeeAdminCreds(ADMIN_CREDS);
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ data: { productOfferV2: { nodes: [node] } } }), { status: 200 }));

    expect(await affiliate.fetchShopeeItemByIds(1, 2)).toEqual(node);
    const auth = globalThis.fetch.mock.calls[0][1].headers.Authorization;
    expect(auth).toContain(`Credential=${ADMIN_CREDS.appId},`);
    expect(auth).not.toContain(USER_CREDS.appId);
  });

  it("sem conta do sistema não chama a API (nem cai na do usuário)", async () => {
    globalThis.fetch = vi.fn();
    vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await affiliate.fetchShopeeItemByIds(1, 2)).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("lerRastreioShopee — de quem é o link", () => {
  const base = "https://shopee.com.br/product/1082747237/22697179178";

  it("o dono vem do mmp_pid e as marcas do utm_content", () => {
    const r = affiliate.lerRastreioShopee(`${base}?mmp_pid=an_18300000001&utm_content=ofertas-x---&utm_source=an_18300000001`);
    expect(r).toEqual({ affiliateId: "18300000001", subIds: ["ofertas", "x", "", "", ""], grupoId: null });
  });

  it("só com utm_source também identifica", () => {
    expect(affiliate.lerRastreioShopee(`${base}?utm_source=an_123456&utm_medium=affiliates`).affiliateId).toBe("123456");
  });

  it("a marca g<id> é o grupo de campanha do Nimbus", () => {
    expect(affiliate.lerRastreioShopee(`${base}?mmp_pid=an_1&utm_content=g1712345678901----`).grupoId).toBe("1712345678901");
  });

  it("marca de outra ferramenta não vira grupo", () => {
    expect(affiliate.lerRastreioShopee(`${base}?mmp_pid=an_1&utm_content=gurubot----`).grupoId).toBeNull();
  });

  it("link sem rastreio: sem dono", () => {
    expect(affiliate.lerRastreioShopee(base)).toEqual({ affiliateId: null, subIds: ["", "", "", "", ""], grupoId: null });
  });

  it("utm_source que não é de afiliado é ignorado", () => {
    expect(affiliate.lerRastreioShopee(`${base}?utm_source=google`).affiliateId).toBeNull();
  });

  it("texto que não é URL → null", () => {
    expect(affiliate.lerRastreioShopee("não é link")).toBeNull();
  });
});
