// Testes do helper http() em data/api.js — cobre os caminhos críticos:
// header Authorization, 401 → dispatchEvent unauthorized + token clear,
// erros não-2xx jogados como Error, token storage no localStorage.

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getToken, setToken, clearToken,
  authLogin, authRegister, authMe,
  billingMe, billingCheckout, billingPortal,
  loadAppState, saveAppState,
  adminScraperMLFilters, adminScraperMLFiltersSave,
  adminScraperAmazonFilters, adminScraperAmazonFiltersSave,
  adminScraperShopeeFilters, adminScraperShopeeFiltersSave,
  getAffiliateStatus, saveAffiliate, clearAffiliate,
} from "../data/api.js";

function mockFetch(responses) {
  // `responses` é array (ordem) ou função (req → res)
  if (Array.isArray(responses)) {
    let i = 0;
    return vi.fn(async () => {
      const r = responses[Math.min(i++, responses.length - 1)];
      return makeResponse(r);
    });
  }
  return vi.fn(async (...args) => makeResponse(responses(...args)));
}

function makeResponse({ status = 200, body = {}, ok } = {}) {
  return {
    status,
    statusText: status === 200 ? "OK" : "Error",
    ok: ok ?? (status >= 200 && status < 300),
    json: async () => body,
  };
}

beforeEach(() => {
  localStorage.clear();
  globalThis.fetch = vi.fn();
});

describe("token storage", () => {
  it("setToken + getToken funciona", () => {
    setToken("abc.def.ghi");
    expect(getToken()).toBe("abc.def.ghi");
  });
  it("setToken(null) limpa", () => {
    setToken("x");
    setToken(null);
    expect(getToken()).toBeNull();
  });
  it("clearToken remove a key", () => {
    setToken("x");
    clearToken();
    expect(getToken()).toBeNull();
  });
});

describe("http() — header Authorization", () => {
  it("não envia Authorization se não tem token", async () => {
    fetch.mockResolvedValueOnce(makeResponse({ status: 200, body: { ok: true } }));
    await loadAppState();
    const call = fetch.mock.calls[0];
    expect(call[1].headers.Authorization).toBeUndefined();
  });

  it("envia Authorization: Bearer <token> quando tem token", async () => {
    setToken("token-xyz");
    fetch.mockResolvedValueOnce(makeResponse({ status: 200, body: {} }));
    await loadAppState();
    const call = fetch.mock.calls[0];
    expect(call[1].headers.Authorization).toBe("Bearer token-xyz");
  });

  it("envia Content-Type: application/json em request com body", async () => {
    fetch.mockResolvedValueOnce(makeResponse({ status: 200, body: { token: "t" } }));
    await authLogin({ email: "a@b.c", password: "x" });
    const call = fetch.mock.calls[0];
    expect(call[1].headers["Content-Type"]).toBe("application/json");
    expect(call[1].body).toContain("a@b.c");
  });
});

describe("http() — tratamento de erros", () => {
  it("401 limpa token e dispara nimbus:unauthorized", async () => {
    setToken("vai-cair");
    const listener = vi.fn();
    window.addEventListener("nimbus:unauthorized", listener);
    fetch.mockResolvedValueOnce(makeResponse({ status: 401, body: { error: "unauth" } }));

    await expect(authMe()).rejects.toThrow();
    expect(getToken()).toBeNull();
    expect(listener).toHaveBeenCalled();
  });

  it("4xx joga Error com message do body.error", async () => {
    fetch.mockResolvedValueOnce(makeResponse({ status: 400, body: { error: "bad request msg" } }));
    await expect(authMe()).rejects.toThrow(/bad request msg/);
  });

  it("4xx sem body.error joga Error com statusText", async () => {
    fetch.mockResolvedValueOnce({
      status: 500, statusText: "Internal", ok: false,
      json: async () => { throw new Error("invalid json"); },
    });
    await expect(authMe()).rejects.toThrow(/Internal|Falha/);
  });

  it("402 (plan-gating) também joga Error", async () => {
    fetch.mockResolvedValueOnce(makeResponse({
      status: 402, body: { error: "limite", limit: 1, current: 2, planRequired: "pro" }
    }));
    await expect(saveAppState({})).rejects.toThrow(/limite/);
  });
});

describe("auth endpoints", () => {
  it("authRegister devolve user sem token (precisa verificar email)", async () => {
    fetch.mockResolvedValueOnce(makeResponse({
      status: 200, body: { user: { id: "u1", email: "x@y.z" }, requiresVerification: true }
    }));
    const r = await authRegister({ name: "X", email: "x@y.z", password: "Senha123" });
    expect(r.user.email).toBe("x@y.z");
    expect(r.requiresVerification).toBe(true);
    // Sem token: não grava nada no storage.
    expect(getToken()).toBe(null);
  });

  it("authLogin grava token", async () => {
    fetch.mockResolvedValueOnce(makeResponse({
      status: 200, body: { user: { id: "u1" }, token: "new-login-token" }
    }));
    await authLogin({ email: "x@y.z", password: "p" });
    expect(getToken()).toBe("new-login-token");
  });
});

describe("affiliate endpoints", () => {
  it("getAffiliateStatus faz GET /api/affiliate", async () => {
    fetch.mockResolvedValueOnce(makeResponse({ body: { configured: false } }));
    const r = await getAffiliateStatus();
    expect(r.configured).toBe(false);
    expect(fetch.mock.calls[0][0]).toBe("/api/affiliate");
    expect(fetch.mock.calls[0][1].method).toBe("GET");
  });

  it("saveAffiliate faz PUT com payload", async () => {
    fetch.mockResolvedValueOnce(makeResponse({ body: { configured: true, tag: "minha-tag" } }));
    const r = await saveAffiliate({ tag: "minha-tag", cookie: "sess123" });
    expect(r.configured).toBe(true);
    expect(fetch.mock.calls[0][1].method).toBe("PUT");
    expect(fetch.mock.calls[0][1].body).toContain("minha-tag");
  });

  it("clearAffiliate faz DELETE /api/affiliate", async () => {
    fetch.mockResolvedValueOnce(makeResponse({ body: { configured: false } }));
    await clearAffiliate();
    expect(fetch.mock.calls[0][1].method).toBe("DELETE");
    expect(fetch.mock.calls[0][0]).toBe("/api/affiliate");
  });
});

describe("admin scraper filter endpoints", () => {
  it("adminScraperMLFilters faz GET /api/admin/scraper/ml/filters", async () => {
    const filters = { minRating: 4, minSales: 50, minPrice: 20, maxPrice: 0, maxDiscount: 95 };
    fetch.mockResolvedValueOnce(makeResponse({ body: { filters } }));
    const r = await adminScraperMLFilters();
    expect(r.filters).toEqual(filters);
    expect(fetch.mock.calls[0][0]).toBe("/api/admin/scraper/ml/filters");
    expect(fetch.mock.calls[0][1].method).toBe("GET");
  });

  it("adminScraperMLFiltersSave faz PUT com filtros", async () => {
    const filters = { minRating: 4, minSales: 100, minPrice: 30, maxPrice: 5000, maxDiscount: 90 };
    fetch.mockResolvedValueOnce(makeResponse({ body: { ok: true, filters } }));
    const r = await adminScraperMLFiltersSave(filters);
    expect(r.ok).toBe(true);
    expect(fetch.mock.calls[0][1].method).toBe("PUT");
    expect(fetch.mock.calls[0][1].body).toContain('"minRating"');
  });

  it("adminScraperAmazonFilters faz GET /api/admin/scraper/amazon/filters", async () => {
    const filters = { minRating: 4, minReviews: 20, minPrice: 20, maxPrice: 0, maxDiscount: 90 };
    fetch.mockResolvedValueOnce(makeResponse({ body: { filters } }));
    const r = await adminScraperAmazonFilters();
    expect(r.filters).toEqual(filters);
    expect(fetch.mock.calls[0][0]).toBe("/api/admin/scraper/amazon/filters");
    expect(fetch.mock.calls[0][1].method).toBe("GET");
  });

  it("adminScraperAmazonFiltersSave faz PUT com filtros", async () => {
    const filters = { minRating: 4.5, minReviews: 50, minPrice: 0, maxPrice: 0, maxDiscount: 0 };
    fetch.mockResolvedValueOnce(makeResponse({ body: { ok: true, filters } }));
    const r = await adminScraperAmazonFiltersSave(filters);
    expect(r.ok).toBe(true);
    expect(fetch.mock.calls[0][1].method).toBe("PUT");
  });

  it("adminScraperShopeeFilters faz GET /api/admin/scraper/shopee/filters", async () => {
    fetch.mockResolvedValueOnce(makeResponse({ body: { filters: { minRating: 0 } } }));
    const r = await adminScraperShopeeFilters();
    expect(r.filters).toBeDefined();
    expect(fetch.mock.calls[0][0]).toBe("/api/admin/scraper/shopee/filters");
  });

  it("adminScraperShopeeFiltersSave faz PUT /api/admin/scraper/shopee/filters", async () => {
    fetch.mockResolvedValueOnce(makeResponse({ body: { ok: true, filters: { minRating: 4 } } }));
    const r = await adminScraperShopeeFiltersSave({ minRating: 4 });
    expect(r.ok).toBe(true);
    expect(fetch.mock.calls[0][1].method).toBe("PUT");
  });
});

describe("billing endpoints", () => {
  it("billingMe faz GET em /api/billing/me", async () => {
    fetch.mockResolvedValueOnce(makeResponse({ status: 200, body: { planId: "pro" } }));
    const r = await billingMe();
    expect(r.planId).toBe("pro");
    const call = fetch.mock.calls[0];
    expect(call[0]).toBe("/api/billing/me");
    expect(call[1].method).toBe("GET");
  });

  it("billingCheckout envia planId no body e devolve url", async () => {
    fetch.mockResolvedValueOnce(makeResponse({ status: 200, body: { url: "https://stripe.test/cs_x" } }));
    const r = await billingCheckout("pro");
    expect(r.url).toMatch(/stripe/);
    expect(fetch.mock.calls[0][1].body).toContain('"planId":"pro"');
  });

  it("billingPortal sem body retorna url", async () => {
    fetch.mockResolvedValueOnce(makeResponse({ status: 200, body: { url: "https://portal" } }));
    const r = await billingPortal();
    expect(r.url).toMatch(/portal/);
  });
});
