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
  refillQueueNow,
  NimbusError, errText, MSG_OFFLINE, MSG_INTERNAL,
} from "../data/api.js";

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

  it("500 sem body.error vira mensagem genérica em português (nunca o statusText)", async () => {
    fetch.mockResolvedValueOnce({
      status: 500, statusText: "Internal Server Error", ok: false,
      json: async () => { throw new Error("invalid json"); },
    });
    const err = await authMe().catch((e) => e);
    expect(err.message).toBe(MSG_INTERNAL);
    expect(err.message).not.toMatch(/Internal Server Error/);
    expect(err.code).toBe("internal");
    expect(err.offline).toBe(false);
  });

  it("402 (plan-gating) também joga Error", async () => {
    fetch.mockResolvedValueOnce(makeResponse({
      status: 402, body: { error: "limite", limit: 1, current: 2, planRequired: "pro" }
    }));
    await expect(saveAppState({})).rejects.toThrow(/limite/);
  });

  it("402/409 preservam body e code pras telas que dependem deles", async () => {
    fetch.mockResolvedValueOnce(makeResponse({
      status: 402, body: { error: "limite", code: "plan_limit", limit: 1, current: 2, planRequired: "pro" }
    }));
    const err = await saveAppState({}).catch((e) => e);
    expect(err.status).toBe(402);
    expect(err.code).toBe("plan_limit");
    expect(err.body.planRequired).toBe("pro");
  });

  it("retryAfterSeconds continua chegando na tela (cooldown de reenvio)", async () => {
    fetch.mockResolvedValueOnce(makeResponse({
      status: 429, body: { error: "Aguarde", code: "resend_cooldown", retryAfterSeconds: 42 }
    }));
    const err = await authMe().catch((e) => e);
    expect(err.retryAfterSeconds).toBe(42);
  });
});

describe("http() — sistema fora do ar", () => {
  it("backend caído (fetch rejeita com TypeError) vira mensagem de conexão", async () => {
    fetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const err = await authMe().catch((e) => e);
    expect(err).toBeInstanceOf(NimbusError);
    expect(err.message).toBe(MSG_OFFLINE);
    expect(err.offline).toBe(true);
    expect(err.code).toBe("server_offline");
    // A mensagem técnica fica guardada, mas fora da tela.
    expect(err.raw).toMatch(/Failed to fetch/);
    expect(err.message).not.toMatch(/fetch/);
  });

  it('502 com HTML do nginx NÃO mostra "Bad Gateway" ao usuário', async () => {
    fetch.mockResolvedValueOnce({
      status: 502, statusText: "Bad Gateway", ok: false,
      json: async () => { throw new SyntaxError("Unexpected token '<'"); },
    });
    const err = await loadAppState().catch((e) => e);
    expect(err.message).toBe(MSG_OFFLINE);
    expect(err.message).not.toMatch(/Bad Gateway/i);
    expect(err.offline).toBe(true);
  });

  it("503 do error_page do nginx (JSON com code server_offline) é tratado como offline", async () => {
    fetch.mockResolvedValueOnce(makeResponse({
      status: 503, body: { error: "O Nimbus está temporariamente indisponível.", code: "server_offline" }
    }));
    const err = await loadAppState().catch((e) => e);
    expect(err.offline).toBe(true);
    expect(err.code).toBe("server_offline");
  });

  it("504 (gateway timeout) também vira mensagem de conexão", async () => {
    fetch.mockResolvedValueOnce({
      status: 504, statusText: "Gateway Time-out", ok: false,
      json: async () => { throw new SyntaxError("html"); },
    });
    const err = await loadAppState().catch((e) => e);
    expect(err.message).toBe(MSG_OFFLINE);
    expect(err.message).not.toMatch(/Time-out/i);
  });

  it("200 com corpo não-JSON não estoura SyntaxError cru", async () => {
    fetch.mockResolvedValueOnce({
      status: 200, statusText: "OK", ok: true,
      json: async () => { throw new SyntaxError("Unexpected token '<'"); },
    });
    const err = await loadAppState().catch((e) => e);
    expect(err).toBeInstanceOf(NimbusError);
    expect(err.code).toBe("bad_response");
    expect(err.message).toBe(MSG_INTERNAL);
  });

  it("cancelamento do chamador (AbortController da tela) é repassado cru", async () => {
    const ctrl = new AbortController();
    fetch.mockImplementationOnce(() => {
      ctrl.abort();
      const e = new Error("aborted");
      e.name = "AbortError";
      return Promise.reject(e);
    });
    const err = await refillQueueNow("g1", {}, { signal: ctrl.signal }).catch((e) => e);
    expect(err.name).toBe("AbortError");
    expect(err).not.toBeInstanceOf(NimbusError);
  });

  it("errText devolve fallback quando o erro não tem mensagem", () => {
    expect(errText(new NimbusError("erro do backend"), "fallback")).toBe("erro do backend");
    expect(errText(null, "fallback")).toBe("fallback");
    expect(errText({}, "fallback")).toBe("fallback");
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
