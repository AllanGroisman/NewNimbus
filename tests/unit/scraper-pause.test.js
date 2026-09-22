// Pausar/retomar o scraping global (task 16): checkpoint por passo
// (categoria × loja), retomada só no mesmo dia e purge com o dia do INÍCIO do run.
//
// scraper, catálogo, config e notificador entram por require.cache — nada de
// navegador, banco ou rede.

import "../helpers/env.js";
import { describe, it, expect, beforeEach } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const backend = path.resolve(__dirname, "..", "..", "backend");

function stub(rel, exports) {
  const p = require.resolve(path.join(backend, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

// ── fakes ──────────────────────────────────────────────────────────────────
const store = new Map();
const calls = { scrape: [], prune: 0, purgeCutoff: null };
let onScrape = null;   // gancho pra pedir pausa no meio de um passo

stub("scraping/scraper.js", {
  scrapeOfertas: async ({ category, sources }) => {
    calls.scrape.push(`${category}-${sources[0]}`);
    if (onScrape) onScrape(`${category}-${sources[0]}`);
    return [{ name: "Produto", link: "https://x", price: 10 }];
  },
  CATEGORIES: { casa: {}, gamer: {} },
  STORES: { ml: {}, amazon: {} },
});
stub("catalog/index.js", {
  upsertProducts: async (items) => ({ inserted: items.length, updated: 0 }),
  getStats: async () => ({ total: 42 }),
  prune: async () => { calls.prune++; return { removed: 0, total: 42 }; },
  pruneBeforeDate: async (d, opts) => { calls.purgeCutoff = d; calls.purgeOpts = opts; return { removed: 0, kept: 0, total: 42 }; },
});
stub("config/index.js", {
  get: (k) => store.get(k),
  set: (k, v) => store.set(k, JSON.parse(JSON.stringify(v))),
  del: (k) => store.delete(k),
});
stub("notifications/admin-notifier.js", { notifyScrapingResult: async () => {} });

const admin = require(path.join(backend, "scraping", "admin.js"));
const { buildSteps, isResumable, purgeCutoff, CHECKPOINT_KEY } = admin;

beforeEach(() => {
  store.clear();
  store.set("scraper-config", { categories: ["casa", "gamer"], sources: ["ml", "amazon"], enabled: false });
  calls.scrape = []; calls.prune = 0; calls.purgeCutoff = null;
  onScrape = null;
});

describe("helpers puros", () => {
  it("buildSteps: categoria × loja, na ordem", () => {
    expect(buildSteps(["a", "b"], ["ml", "amazon"]).map(s => s.tag))
      .toEqual(["a-ml", "a-amazon", "b-ml", "b-amazon"]);
  });

  it("isResumable: só checkpoint do mesmo dia local", () => {
    const now = new Date(2026, 8, 22, 15, 0);
    expect(isResumable(null, now)).toBe(false);
    expect(isResumable({ done: [], startedAt: new Date(2026, 8, 22, 0, 5).toISOString() }, now)).toBe(true);
    expect(isResumable({ done: [], startedAt: new Date(2026, 8, 21, 23, 59).toISOString() }, now)).toBe(false);
    expect(isResumable({ startedAt: new Date(2026, 8, 22, 1).toISOString() }, now)).toBe(false);
  });

  it("purgeCutoff: início do dia em que o run começou", () => {
    const cp = { startedAt: new Date(2026, 8, 21, 23, 30).toISOString() };
    expect(purgeCutoff(cp, new Date(2026, 8, 22, 1))).toEqual(new Date(2026, 8, 21));
    expect(purgeCutoff(null, new Date(2026, 8, 22, 1))).toEqual(new Date(2026, 8, 22));
  });
});

describe("runOnce — pausar e retomar", () => {
  it("pausa entre passos, guarda o checkpoint e não faz prune/purge", async () => {
    onScrape = (tag) => { if (tag === "casa-ml") admin.pause(); };
    const r = await admin.runOnce();

    expect(calls.scrape).toEqual(["casa-ml"]);
    expect(r.paused).toBe(true);
    expect(calls.prune).toBe(0);
    expect(calls.purgeCutoff).toBeNull();
    const cp = store.get(CHECKPOINT_KEY);
    expect(cp.done).toEqual(["casa-ml"]);
    expect(cp.pausedAt).toBeTruthy();
    expect(admin.status().paused).toMatchObject({ done: 1, total: 4, resumable: true, interrupted: false });
  });

  it("retomar roda só os passos restantes e faz purge com o dia do início", async () => {
    onScrape = (tag) => { if (tag === "casa-ml") admin.pause(); };
    await admin.runOnce();
    const startedAt = store.get(CHECKPOINT_KEY).startedAt;

    onScrape = null;
    calls.scrape = [];
    const r = await admin.runOnce({ resume: true });

    expect(calls.scrape).toEqual(["casa-amazon", "gamer-ml", "gamer-amazon"]);
    expect(r.paused).toBeUndefined();
    expect(r.inserted).toBe(4);                    // soma as duas sessões
    expect(Object.keys(r.perCategory)).toHaveLength(4);
    expect(calls.purgeCutoff).toEqual(purgeCutoff({ startedAt }));
    // Produto de vitrine de cupom válido não entra no purge diário.
    expect(calls.purgeOpts).toEqual({ keepCouponLinked: true });
    expect(store.has(CHECKPOINT_KEY)).toBe(false);
    expect(admin.status().paused).toBeNull();
  });

  it("checkpoint de outro dia é descartado: começa do zero", async () => {
    store.set(CHECKPOINT_KEY, {
      startedAt: new Date(Date.now() - 2 * 86400000).toISOString(),
      categories: ["casa", "gamer"], sources: ["ml", "amazon"],
      done: ["casa-ml", "casa-amazon"], perCategory: {}, inserted: 0, updated: 0, elapsedMs: 0, pausedAt: "x",
    });
    await admin.runOnce({ resume: true });
    expect(calls.scrape).toHaveLength(4);
  });

  it("sem resume, 'Rodar agora' ignora o pausado e começa do zero", async () => {
    onScrape = (tag) => { if (tag === "casa-ml") admin.pause(); };
    await admin.runOnce();
    onScrape = null;
    calls.scrape = [];
    await admin.runOnce();
    expect(calls.scrape).toHaveLength(4);
  });

  it("cancelar sem run rodando descarta o pausado", async () => {
    onScrape = (tag) => { if (tag === "casa-ml") admin.pause(); };
    await admin.runOnce();
    expect(admin.cancel().ok).toBe(true);
    expect(store.has(CHECKPOINT_KEY)).toBe(false);
    expect(admin.cancel().ok).toBe(false);
  });
});
