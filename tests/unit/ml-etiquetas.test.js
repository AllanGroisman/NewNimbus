// Etiquetas de afiliado do ML (backend/scraping/ml-etiquetas.js).
//
// O que importa aqui:
//   - a lista do getTags vira { tag, inUse, createdAt } sem quebrar com item torto;
//   - cookie vencido (302 pro login) é "cole um cookie novo", não "erro";
//   - sincronizar grava o cookie novo, a lista e a padrão (a "em uso") — e só
//     depois que o ML listou: cookie que não lista não é gravado.
import "../helpers/env.js";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const backend = (...p) => path.resolve(__dirname, "..", "..", "backend", ...p);

const etiquetas = require(backend("scraping", "ml-etiquetas.js"));
const affiliate = require(backend("scraping", "affiliate.js"));
const FX = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "fixtures", "ml-etiquetas.json"), "utf8"));

const USER = "u-etiquetas";
const COOKIE = "ssid=cookie-de-teste";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const login = () => new Response("Found", { status: 302, headers: { location: "https://www.mercadolivre.com/jms/mlb/lgz/login?go=x" } });

// O ML de mentira: o getTags devolve a lista.
function mlFake({ getTags = () => json(FX.getTags) } = {}) {
  return vi.fn(async (url) => {
    if (new URL(url).pathname.endsWith("/getTags")) return getTags();
    return new Response("not found", { status: 404 });
  });
}

let fetchMock, writeSpy;

beforeEach(() => {
  vi.spyOn(affiliate, "readMLConfig").mockReturnValue({ tag: "allangroisman", cookie: COOKIE, tags: [], source: "file", updatedAt: null });
  writeSpy = vi.spyOn(affiliate, "writeMLConfig").mockImplementation(() => ({}));
  fetchMock = mlFake();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("normalizaListaEtiquetas", () => {
  it("lê a resposta do getTags", () => {
    expect(etiquetas.normalizaListaEtiquetas(FX.getTags)).toEqual([
      { tag: "allangroisman", inUse: true, createdAt: "2026-07-21 17:27:07.151627" },
      { tag: "grupo-ofertas", inUse: false, createdAt: "2026-09-30 10:00:00.000000" },
    ]);
  });

  it("aceita a lista dentro de `data` e ignora item sem etiqueta", () => {
    const r = etiquetas.normalizaListaEtiquetas({ data: [{ tag: " x " }, { tag: "" }, null, { in_use: true }] });
    expect(r).toEqual([{ tag: "x", inUse: false, createdAt: null }]);
  });

  it("resposta que não é lista vira lista vazia", () => {
    expect(etiquetas.normalizaListaEtiquetas(null)).toEqual([]);
    expect(etiquetas.normalizaListaEtiquetas({ erro: 1 })).toEqual([]);
  });
});

describe("escolhePadrao", () => {
  const T = (tag, inUse = false) => ({ tag, inUse, createdAt: null });

  it("é a em uso no ML", () => {
    expect(etiquetas.escolhePadrao([T("a"), T("b", true)])).toBe("b");
  });

  it("sem nenhuma marcada, a primeira", () => {
    expect(etiquetas.escolhePadrao([T("a"), T("b")])).toBe("a");
  });

  it("lista vazia não tem padrão", () => {
    expect(etiquetas.escolhePadrao([])).toBe(null);
  });
});

describe("sincronizarEtiquetas", () => {
  it("com cookie novo: testa no ML com ELE e grava cookie, lista e padrão", async () => {
    const r = await etiquetas.sincronizarEtiquetas(USER, { cookie: "  ssid=novo  " });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://www.mercadolivre.com.br/affiliate-program/api/v2/affiliates/getTags");
    expect(init.headers.Cookie).toBe("ssid=novo");
    expect(init.redirect).toBe("manual");

    expect(writeSpy).toHaveBeenCalledWith(USER, {
      cookie: "ssid=novo",
      tag: "allangroisman",
      tags: [
        { tag: "allangroisman", inUse: true, createdAt: "2026-07-21 17:27:07.151627" },
        { tag: "grupo-ofertas", inUse: false, createdAt: "2026-09-30 10:00:00.000000" },
      ],
      tagsFetchedAt: expect.any(String),
    });
    expect(r.current).toBe("allangroisman");
  });

  it("sem cookie novo: rebusca com o salvo e não mexe nele", async () => {
    await etiquetas.sincronizarEtiquetas(USER);
    expect(fetchMock.mock.calls[0][1].headers.Cookie).toBe(COOKIE);
    expect(writeSpy.mock.calls[0][1]).not.toHaveProperty("cookie");
  });

  it("a padrão segue a em uso no ML, mesmo com outra salva antes", async () => {
    vi.stubGlobal("fetch", mlFake({ getTags: () => json(FX.getTags.map(t => ({ ...t, in_use: t.tag === "grupo-ofertas" }))) }));
    await etiquetas.sincronizarEtiquetas(USER);
    expect(writeSpy.mock.calls[0][1].tag).toBe("grupo-ofertas");
  });

  it("sem cookie nenhum não chama o ML", async () => {
    affiliate.readMLConfig.mockReturnValue({ tag: null, cookie: null, tags: [] });
    await expect(etiquetas.sincronizarEtiquetas(USER)).rejects.toMatchObject({ status: 409, code: affiliate.ML_LINK_KIND.SEM_CONFIG });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("302 pro login é cookie vencido — e o cookie novo não é gravado", async () => {
    vi.stubGlobal("fetch", mlFake({ getTags: login }));
    await expect(etiquetas.sincronizarEtiquetas(USER, { cookie: "ssid=morto" })).rejects.toMatchObject({
      status: 409, code: affiliate.ML_LINK_KIND.COOKIE, message: expect.stringMatching(/não aceitou este cookie/i),
    });
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("outro erro do ML diz o status e não grava", async () => {
    vi.stubGlobal("fetch", mlFake({ getTags: () => json({}, 500) }));
    await expect(etiquetas.sincronizarEtiquetas(USER, { cookie: "ssid=x" })).rejects.toMatchObject({ status: 502, message: expect.stringMatching(/HTTP 500/) });
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("formato inesperado não vira lista vazia calada", async () => {
    vi.stubGlobal("fetch", mlFake({ getTags: () => json({ algo: "outro" }) }));
    await expect(etiquetas.sincronizarEtiquetas(USER)).rejects.toMatchObject({ status: 502 });
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("conta sem etiqueta: pede pra criar uma, sem gravar", async () => {
    vi.stubGlobal("fetch", mlFake({ getTags: () => json([]) }));
    await expect(etiquetas.sincronizarEtiquetas(USER, { cookie: "ssid=x" })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/não tem etiquetas/) });
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("config vinda de variável de ambiente não é mexida", async () => {
    affiliate.readMLConfig.mockReturnValue({ tag: "env-tag", cookie: COOKIE, tags: [], source: "env" });
    await expect(etiquetas.sincronizarEtiquetas(USER)).rejects.toMatchObject({ status: 409 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
