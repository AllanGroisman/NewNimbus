// Tratador de erro global + 404 (task 43).
//
// A regra que estes testes protegem: nenhuma resposta de erro sai em HTML e
// nenhuma mensagem de exceção interna chega ao cliente. Antes disso, uma rota
// async que rejeitasse fora de try/catch caía no handler default do Express e
// devolvia HTML com stack trace; e ~47 rotas respondiam `{error: err.message}`,
// vazando texto de biblioteca em inglês (incluindo host e porta do Postgres).

import { describe, it, expect } from "vitest";
import { app, request } from "../helpers/app.js";
import httpErrors from "../../backend/infra/httpErrors.js";

describe("404 de API", () => {
  it("rota inexistente sob /api devolve JSON, não HTML", async () => {
    const res = await request(app).get("/api/rota-que-nao-existe");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body.code).toBe("not_found");
    expect(res.body.error).toBe("Rota não encontrada.");
  });

  it("método errado numa rota existente também cai no 404 JSON", async () => {
    const res = await request(app).patch("/api/state");
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("not_found");
  });
});

describe("erros de parsing do body", () => {
  it("JSON malformado vira 400 em português", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .set("Content-Type", "application/json")
      .send('{"email": "quebrado');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("bad_request");
    expect(res.body.error).toBe("Requisição inválida.");
  });
});

describe("erro interno não vaza detalhe técnico", () => {
  it("serverError responde mensagem genérica + requestId, guardando o err.message", () => {
    const captured = {};
    const res = {
      status(code) { captured.status = code; return this; },
      json(body) { captured.body = body; return this; },
    };
    const err = new Error("Can't reach database server at localhost:5432");
    httpErrors.serverError(res, err, { ctx: "teste" });

    expect(captured.status).toBe(500);
    expect(captured.body.code).toBe("internal");
    expect(captured.body.error).toBe(httpErrors.MSG_INTERNAL);
    // O que interessa: nada do erro original chega ao cliente.
    expect(JSON.stringify(captured.body)).not.toMatch(/localhost:5432/);
    expect(JSON.stringify(captured.body)).not.toMatch(/database server/);
    // ...mas há um código pro usuário citar no suporte.
    expect(captured.body.requestId).toMatch(/^[0-9a-f]{8}$/);
  });

  it("com expose: true a mensagem de domínio (em português) passa", () => {
    const captured = {};
    const res = {
      status(code) { captured.status = code; return this; },
      json(body) { captured.body = body; return this; },
    };
    httpErrors.serverError(res, new Error("Backblaze não configurado"), { ctx: "teste", expose: true });
    expect(captured.body.error).toBe("Backblaze não configurado");
  });

  it("errorHandler devolve 403 JSON para origem barrada pelo CORS", () => {
    const captured = {};
    const res = {
      headersSent: false,
      status(code) { captured.status = code; return this; },
      json(body) { captured.body = body; return this; },
    };
    const err = new Error("Origin não permitido: https://malicioso.example");
    httpErrors.errorHandler(err, { headers: {}, path: "/api/state" }, res, () => {});
    expect(captured.status).toBe(403);
    expect(captured.body.code).toBe("cors_denied");
    expect(captured.body.error).toBe("Origem não autorizada.");
  });

  it("errorHandler delega quando a resposta já começou a sair", () => {
    let delegated = null;
    const err = new Error("tarde demais");
    httpErrors.errorHandler(err, {}, { headersSent: true }, (e) => { delegated = e; });
    expect(delegated).toBe(err);
  });
});
