// Etiquetas de afiliado do ML (backend/scraping/ml-etiquetas.js).
//
// O que importa aqui:
//   - a lista do getTags vira { tag, inUse, createdAt } sem quebrar com item torto;
//   - cookie vencido (302 pro login) é "cole um cookie novo", não "erro";
//   - trocar mexe no ML ANTES da TAG salva aqui — se o ML recusar, nada muda;
//   - só etiqueta da conta é aceita (TAG de fora gera link sem comissão).
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

// O ML de mentira: getTags devolve a lista; setTagInUse move a marca de "em uso".
function mlFake({ getTags = () => json(FX.getTags), setTagInUse = null } = {}) {
  let lista = FX.getTags.map(t => ({ ...t }));
  return vi.fn(async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/getTags")) return getTags();
    if (u.pathname.endsWith("/setTagInUse")) {
      if (setTagInUse) return setTagInUse(init);
      const { tag } = JSON.parse(init.body);
      lista = lista.map(t => ({ ...t, in_use: t.tag === tag }));
      return json(lista);
    }
    return new Response("not found", { status: 404 });
  });
}

let fetchMock, writeSpy;

beforeEach(() => {
  vi.spyOn(affiliate, "readMLConfig").mockReturnValue({ tag: "allangroisman", cookie: COOKIE, source: "file", updatedAt: null });
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

describe("listarEtiquetas", () => {
  it("busca com o cookie do usuário e devolve a TAG salva como `current`", async () => {
    const r = await etiquetas.listarEtiquetas(USER);
    expect(r.current).toBe("allangroisman");
    expect(r.tags.map(t => t.tag)).toEqual(["allangroisman", "grupo-ofertas"]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://www.mercadolivre.com.br/affiliate-program/api/v2/affiliates/getTags");
    expect(init.headers.Cookie).toBe(COOKIE);
    expect(init.redirect).toBe("manual");
  });

  it("sem cookie não chama o ML", async () => {
    affiliate.readMLConfig.mockReturnValue({ tag: null, cookie: null });
    await expect(etiquetas.listarEtiquetas(USER)).rejects.toMatchObject({ status: 409, code: affiliate.ML_LINK_KIND.SEM_CONFIG });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("302 pro login é cookie vencido", async () => {
    vi.stubGlobal("fetch", mlFake({ getTags: login }));
    await expect(etiquetas.listarEtiquetas(USER)).rejects.toMatchObject({
      status: 409, code: affiliate.ML_LINK_KIND.COOKIE, message: expect.stringMatching(/cookie.*venceu/i),
    });
  });

  it("outro erro do ML diz o status", async () => {
    vi.stubGlobal("fetch", mlFake({ getTags: () => json({}, 500) }));
    await expect(etiquetas.listarEtiquetas(USER)).rejects.toMatchObject({ status: 502, message: expect.stringMatching(/HTTP 500/) });
  });

  it("formato inesperado não vira lista vazia calada", async () => {
    vi.stubGlobal("fetch", mlFake({ getTags: () => json({ algo: "outro" }) }));
    await expect(etiquetas.listarEtiquetas(USER)).rejects.toMatchObject({ status: 502 });
  });
});

describe("trocarEtiqueta", () => {
  it("troca no ML e depois salva a TAG aqui", async () => {
    const r = await etiquetas.trocarEtiqueta(USER, "grupo-ofertas");

    const set = fetchMock.mock.calls.find(([url]) => url.endsWith("/setTagInUse"));
    expect(set[1].method).toBe("PUT");
    expect(JSON.parse(set[1].body)).toEqual({ tag: "grupo-ofertas" });
    expect(set[1].headers.Cookie).toBe(COOKIE);

    expect(writeSpy).toHaveBeenCalledWith(USER, { tag: "grupo-ofertas" });
    expect(r.current).toBe("grupo-ofertas");
    expect(r.tags.find(t => t.inUse).tag).toBe("grupo-ofertas");
  });

  it("se o ML recusar, a TAG daqui não muda", async () => {
    vi.stubGlobal("fetch", mlFake({ setTagInUse: () => json({ message: "forbidden" }, 403) }));
    await expect(etiquetas.trocarEtiqueta(USER, "grupo-ofertas")).rejects.toMatchObject({ status: 502, message: expect.stringMatching(/HTTP 403/) });
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("cookie vencido na troca também não salva", async () => {
    vi.stubGlobal("fetch", mlFake({ setTagInUse: login }));
    await expect(etiquetas.trocarEtiqueta(USER, "grupo-ofertas")).rejects.toMatchObject({ code: affiliate.ML_LINK_KIND.COOKIE });
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("recusa etiqueta que não é da conta, sem chamar o setTagInUse", async () => {
    await expect(etiquetas.trocarEtiqueta(USER, "de-outra-conta")).rejects.toMatchObject({ status: 400 });
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith("/setTagInUse"))).toBe(false);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("etiqueta vazia nem chega no ML", async () => {
    await expect(etiquetas.trocarEtiqueta(USER, "  ")).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("config vinda de variável de ambiente não é trocada", async () => {
    affiliate.readMLConfig.mockReturnValue({ tag: "env-tag", cookie: COOKIE, source: "env" });
    await expect(etiquetas.trocarEtiqueta(USER, "grupo-ofertas")).rejects.toMatchObject({ status: 409 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resposta do setTagInUse sem lista: usa a de antes com a marca movida", async () => {
    vi.stubGlobal("fetch", mlFake({ setTagInUse: () => json({ ok: true }) }));
    const r = await etiquetas.trocarEtiqueta(USER, "grupo-ofertas");
    expect(r.tags).toEqual([
      expect.objectContaining({ tag: "allangroisman", inUse: false }),
      expect.objectContaining({ tag: "grupo-ofertas", inUse: true }),
    ]);
  });
});
