// Health check + métricas Prometheus.
// /healthz é público (sem auth) e devolve 200/503 com diagnóstico dos subsystems.
// /metrics expõe contadores/gauges em texto Prometheus.

import { describe, it, expect } from "vitest";
import { app, request, createTestUser } from "../helpers/app.js";

describe("GET /healthz", () => {
  it("é público (sem auth) e retorna 200 quando tudo ok", async () => {
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(typeof res.body.uptime).toBe("number");
    expect(res.body.checks).toBeDefined();
  });

  it("checks inclui storage, scheduler, whatsapp, queue e adminScraper", async () => {
    const res = await request(app).get("/healthz");
    expect(res.body.checks.storage).toBeDefined();
    expect(res.body.checks.scheduler).toBeDefined();
    expect(res.body.checks.whatsapp).toBeDefined();
    expect(res.body.checks.queue).toBeDefined();
    expect(res.body.checks.adminScraper).toBeDefined();
  });

  it("storage check identifica backend=pg", async () => {
    const res = await request(app).get("/healthz");
    expect(res.body.checks.storage.ok).toBe(true);
    expect(res.body.checks.storage.backend).toBe("pg");
  });

  it("queue check identifica backend=memory (sem Redis configurado)", async () => {
    const res = await request(app).get("/healthz");
    expect(res.body.checks.queue.backend).toBe("memory");
  });

  it("não exige queue.ok=true em modo memory (não falha health)", async () => {
    // Modo memory não tem o conceito de "alive"; só redis levanta esse bit.
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
  });
});

describe("GET /metrics", () => {
  it("é público e retorna texto Prometheus", async () => {
    const res = await request(app).get("/metrics");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/plain/);
    expect(res.text).toMatch(/# HELP/);
    expect(res.text).toMatch(/# TYPE/);
  });

  it("inclui contadores nimbus_ esperados", async () => {
    // Faz uma chamada pra incrementar nimbus_http_requests_total
    await request(app).get("/healthz");
    const res = await request(app).get("/metrics");
    expect(res.text).toContain("nimbus_http_requests_total");
    expect(res.text).toContain("nimbus_http_request_duration_seconds");
    expect(res.text).toContain("nimbus_scheduler_ticks_total");
    expect(res.text).toContain("nimbus_sends_total");
    expect(res.text).toContain("nimbus_queue_depth");
    expect(res.text).toContain("nimbus_billing_webhook_events_total");
    expect(res.text).toContain("nimbus_billing_checkout_total");
  });

  it("registra contagem de requests com label de status", async () => {
    // Sucesso em /healthz incrementa label status=200
    await request(app).get("/healthz");
    const res = await request(app).get("/metrics");
    // Espera ver uma linha com label status="200" na contagem
    expect(res.text).toMatch(/nimbus_http_requests_total\{[^}]*status="200"[^}]*\}\s+\d+/);
  });

  it("contador de webhook eventos cresce após processar evento", async () => {
    const before = await request(app).get("/metrics");
    const beforeMatch = before.text.match(/nimbus_billing_webhook_events_total\{[^}]*type="customer\.created"[^}]*\}\s+(\d+)/);
    const beforeCount = beforeMatch ? Number(beforeMatch[1]) : 0;

    // Dispara um webhook (já configurado em billing.test.js usa o mock)
    await request(app)
      .post("/api/billing/webhook")
      .set("stripe-signature", "t=1,v1=fake")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ id: "evt_metrics_1", type: "customer.created", data: { object: {} } }));

    const after = await request(app).get("/metrics");
    const afterMatch = after.text.match(/nimbus_billing_webhook_events_total\{[^}]*type="customer\.created"[^}]*\}\s+(\d+)/);
    const afterCount = afterMatch ? Number(afterMatch[1]) : 0;
    expect(afterCount).toBeGreaterThan(beforeCount);
  });
});

describe("Rate limiting", () => {
  it("login limiter está em no-op no NODE_ENV=test", async () => {
    // Dispara 20 logins (> limite normal de 10/min) sem ser bloqueado
    const results = [];
    for (let i = 0; i < 20; i++) {
      const r = await request(app).post("/api/auth/login").send({ email: "naoexiste@x.com", password: "x" });
      results.push(r.status);
    }
    // Todos devem ser 401 (credencial inválida), nenhum 429
    expect(results.every(s => s === 401)).toBe(true);
  });

  it("register limiter também é no-op em test", async () => {
    const results = [];
    for (let i = 0; i < 12; i++) {
      const r = await request(app).post("/api/auth/register").send({ name: "x", email: "x", password: "x" });
      results.push(r.status);
    }
    // 400 por email inválido, nunca 429
    expect(results.every(s => s === 400)).toBe(true);
  });

  it("global /api limiter é no-op em test", async () => {
    const { auth } = await createTestUser();
    // Dispara 50 requests autenticados — global cap é 300/min em prod
    const promises = Array.from({ length: 50 }, () => auth("get", "/api/auth/me"));
    const responses = await Promise.all(promises);
    expect(responses.every(r => r.status === 200)).toBe(true);
  });
});
