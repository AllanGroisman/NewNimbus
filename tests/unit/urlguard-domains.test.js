// urlGuard — allowlist de domínios de loja. É o primeiro portão de TODO link que
// vem de fora (fetch-url do painel e mensagem de grupo no repasse): host fora da
// lista morre antes de qualquer requisição, com "loja não suportada".
//
// Um domínio faltando aqui não parece um bug de allowlist — parece o link ser
// inválido. Foi o caso do link.amazon (encurtador do app da Amazon, gTLD
// .amazon), descartado no repasse sem nunca ter o redirect seguido.
//
// amazon-url.js tem a PRÓPRIA lista de hosts Amazon (isAmazonHost, usada pela
// chave de produto). As duas precisam andar juntas, senão o mesmo produto entra
// duas vezes no catálogo dependendo de por qual link ele chegou.

import "../helpers/env.js";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const urlGuard = require(path.resolve(__dirname, "..", "..", "backend", "scraping", "urlGuard.js"));
const amazonUrl = require(path.resolve(__dirname, "..", "..", "backend", "scraping", "amazon-url.js"));

describe("detectStore", () => {
  it("reconhece o encurtador link.amazon", () => {
    expect(urlGuard.detectStore("https://link.amazon/B0edW0eVU")).toBe("Amazon");
  });

  it("segue reconhecendo os demais domínios da Amazon", () => {
    for (const url of [
      "https://amzn.to/abc",
      "https://a.co/d/abc",
      "https://www.amazon.com.br/dp/B0ABCDEFGH",
    ]) {
      expect(urlGuard.detectStore(url)).toBe("Amazon");
    }
  });

  it("reconhece as outras lojas", () => {
    expect(urlGuard.detectStore("https://mercadolivre.com.br/p/MLB1")).toBe("Mercado Livre");
    expect(urlGuard.detectStore("https://s.shopee.com.br/abc")).toBe("Shopee");
  });

  it("não deixa o sufixo vazar pra domínio de terceiro", () => {
    expect(urlGuard.detectStore("https://link.amazon.evil.com/x")).toBeNull();
    expect(urlGuard.detectStore("https://amzn.to.evil.com/x")).toBeNull();
  });

  it("devolve null pra loja desconhecida e pra URL inválida", () => {
    expect(urlGuard.detectStore("https://exemplo.com/produto")).toBeNull();
    expect(urlGuard.detectStore("nao é uma url")).toBeNull();
  });
});

// Sem o caminho feliz de assertStoreUrl: ele termina em assertPublicHost, que faz
// DNS de verdade — rede não entra em unit/. O que importa aqui (detectStore achar
// a loja) está coberto acima; o resto do portão é testado no integration.
describe("assertStoreUrl", () => {
  it("recusa domínio fora da lista antes de tocar na rede", async () => {
    await expect(urlGuard.assertStoreUrl("https://exemplo.com/x"))
      .rejects.toThrow(/não reconhecido/i);
  });

  it("recusa protocolo que não seja http(s)", async () => {
    await expect(urlGuard.assertStoreUrl("file:///etc/passwd"))
      .rejects.toThrow(/http/i);
  });
});

describe("isAmazonHost", () => {
  it("cobre os mesmos hosts Amazon da allowlist do urlGuard", () => {
    for (const url of [
      "https://link.amazon/B0edW0eVU",
      "https://amzn.to/abc",
      "https://amzn.eu/d/abc",
      "https://a.co/d/abc",
      "https://www.amazon.com.br/dp/B0ABCDEFGH",
    ]) {
      expect(amazonUrl.isAmazonHost(url)).toBe(true);
    }
  });

  it("não casa host de terceiro que só termina parecido", () => {
    expect(amazonUrl.isAmazonHost("https://link.amazon.evil.com/x")).toBe(false);
    expect(amazonUrl.isAmazonHost("https://naoamazon.com.br/dp/B0ABCDEFGH")).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────
// safeFetchFollow — quem pode ser o quê na cadeia de redirect.
//
// O DNS é trocado por um stub: `urlGuard` guarda o OBJETO require("dns").promises
// e só resolve `.lookup` na hora da chamada, então mexer na propriedade aqui
// alcança o módulo. É o que mantém este arquivo em unit/ (sem rede).
// ────────────────────────────────────────────────────────────────────────

const dnsPromises = require("dns").promises;
const realLookup = dnsPromises.lookup;

// Responde com um IP público pra qualquer host — quem barra endereço interno é o
// isPrivateAddress, testado pelo caminho do IP literal logo abaixo.
function stubDns() {
  dnsPromises.lookup = async () => [{ address: "93.184.216.34", family: 4 }];
}

// Cada entrada: [status, location]. `null` em location = fim da cadeia.
function stubFetch(saltos) {
  const vistos = [];
  vi.stubGlobal("fetch", async (url) => {
    vistos.push(url);
    const [status, location] = saltos.shift() || [200, null];
    return {
      status,
      headers: { get: (h) => (h.toLowerCase() === "location" ? location : null) },
      body: { cancel: async () => {} },
    };
  });
  return vistos;
}

describe("safeFetchFollow — cadeia de redirect", () => {
  beforeEach(() => { stubDns(); });
  afterEach(() => { dnsPromises.lookup = realLookup; vi.unstubAllGlobals(); });

  it("atravessa encurtador de terceiro no meio do caminho", async () => {
    // O caso real que motivou isto: link.amazon passa por amzlinks.in (que não é
    // loja nenhuma) antes de cair na Amazon. Barrar o meio matava o link inteiro.
    const vistos = stubFetch([
      [302, "https://amzlinks.in/B0edW0eVU"],
      [302, "https://www.amazon.com.br/dp/B0HFNZP4JX?tag=outro-20"],
      [200, null],
    ]);
    const { finalUrl } = await urlGuard.safeFetchFollow("https://link.amazon/B0edW0eVU");
    expect(finalUrl).toBe("https://www.amazon.com.br/dp/B0HFNZP4JX?tag=outro-20");
    expect(vistos).toHaveLength(3);
  });

  it("o destino final ainda tem que ser de loja conhecida", async () => {
    stubFetch([
      [302, "https://intermediario-qualquer.com/x"],
      [200, null],
    ]);
    await expect(urlGuard.safeFetchFollow("https://amzn.to/abc"))
      .rejects.toThrow(/não reconhecido/i);
  });

  it("salto pra endereço interno é barrado mesmo vindo de loja", async () => {
    stubFetch([[302, "http://169.254.169.254/latest/meta-data/"]]);
    await expect(urlGuard.safeFetchFollow("https://amzn.to/abc"))
      .rejects.toThrow(/interno/i);
  });

  it("a entrada continua tendo que ser de loja, sem nem buscar", async () => {
    const vistos = stubFetch([[200, null]]);
    await expect(urlGuard.safeFetchFollow("https://exemplo.com/x"))
      .rejects.toThrow(/não reconhecido/i);
    expect(vistos).toHaveLength(0);
  });

  it("desiste depois de redirects demais", async () => {
    stubFetch(Array.from({ length: 10 }, () => [302, "https://amzn.to/proximo"]));
    await expect(urlGuard.safeFetchFollow("https://amzn.to/abc"))
      .rejects.toThrow(/redirecionamentos demais/i);
  });
});

describe("assertPublicUrl — o mínimo exigido de um salto do meio", () => {
  afterEach(() => { dnsPromises.lookup = realLookup; });

  it("não exige loja", async () => {
    stubDns();
    const { url } = await urlGuard.assertPublicUrl("https://amzlinks.in/B0edW0eVU");
    expect(url).toBe("https://amzlinks.in/B0edW0eVU");
  });

  it("barra IP interno literal sem consultar DNS", async () => {
    await expect(urlGuard.assertPublicUrl("http://127.0.0.1:3001/api"))
      .rejects.toThrow(/interno/i);
  });

  it("barra protocolo que não seja http(s) e credencial embutida", async () => {
    await expect(urlGuard.assertPublicUrl("file:///etc/passwd")).rejects.toThrow(/http/i);
    await expect(urlGuard.assertPublicUrl("https://user:senha@amzn.to/x")).rejects.toThrow(/inválida/i);
  });
});
