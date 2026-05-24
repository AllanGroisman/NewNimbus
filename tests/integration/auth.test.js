// Jornada de autenticacao: registro, login, /me, troca de senha, gating admin.

import { describe, it, expect } from "vitest";
import { app, request, createTestUser, uniqueEmail, auth as authMod } from "../helpers/app.js";

describe("Auth — registro e login", () => {
  it("rejeita email invalido", async () => {
    const res = await request(app).post("/api/auth/register").send({ name: "X", email: "naoeemail", password: "senha123" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/email/i);
  });

  it("rejeita senha curta", async () => {
    const res = await request(app).post("/api/auth/register").send({ name: "X", email: uniqueEmail(), password: "123" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/senha/i);
  });

  it("cria usuario, exige verificacao de email e nao devolve token direto", async () => {
    const email = uniqueEmail();
    const res = await request(app).post("/api/auth/register").send({ name: "Joao", email, password: "Senha123" });
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(email);
    expect(res.body.user.role).toBe("user");
    expect(res.body.requiresVerification).toBe(true);
    // Sem token — precisa verificar email primeiro
    expect(res.body.token).toBeUndefined();
    expect(res.body.user.passwordHash).toBeUndefined();
  });

  it("nao permite cadastrar mesmo email duas vezes", async () => {
    const email = uniqueEmail();
    await request(app).post("/api/auth/register").send({ name: "A", email, password: "Senha123" });
    const dup = await request(app).post("/api/auth/register").send({ name: "B", email, password: "Senha123" });
    expect(dup.status).toBe(400);
    expect(dup.body.error).toMatch(/j[áa] existe/i);
  });

  it("login com senha errada devolve 401", async () => {
    const { email } = await createTestUser();
    const res = await request(app).post("/api/auth/login").send({ email, password: "senhaerrada" });
    expect(res.status).toBe(401);
  });

  it("login com sucesso devolve token novo", async () => {
    const { email, password } = await createTestUser();
    const res = await request(app).post("/api/auth/login").send({ email, password });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
  });
});

describe("Auth — /me e middleware", () => {
  it("sem token retorna 401", async () => {
    const res = await request(app).get("/api/auth/me");
    expect(res.status).toBe(401);
  });

  it("token invalido retorna 401", async () => {
    const res = await request(app).get("/api/auth/me").set("Authorization", "Bearer not.a.real.jwt");
    expect(res.status).toBe(401);
  });

  it("token valido devolve user", async () => {
    const { user, auth } = await createTestUser();
    const res = await auth("get", "/api/auth/me");
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(user.id);
  });

  it("PATCH /me atualiza nome", async () => {
    const { auth } = await createTestUser();
    const res = await auth("patch", "/api/auth/me").send({ name: "Novo Nome" });
    expect(res.status).toBe(200);
    expect(res.body.user.name).toBe("Novo Nome");
  });
});

describe("Auth — troca de senha", () => {
  it("rejeita troca com senha atual errada", async () => {
    const { auth } = await createTestUser();
    const res = await auth("post", "/api/auth/password").send({ currentPassword: "errada", newPassword: "outranova" });
    expect(res.status).toBe(400);
  });

  it("aceita troca com senha atual correta e permite login com a nova", async () => {
    const u = await createTestUser();
    const r = await u.auth("post", "/api/auth/password").send({ currentPassword: u.password, newPassword: "Novasenha456" });
    expect(r.status).toBe(200);
    const login = await request(app).post("/api/auth/login").send({ email: u.email, password: "Novasenha456" });
    expect(login.status).toBe(200);
  });
});

describe("Auth — gating de admin", () => {
  it("user comum recebe 403 em rota admin", async () => {
    const { auth } = await createTestUser();
    const res = await auth("get", "/api/admin/users");
    expect(res.status).toBe(403);
  });

  it("promocao a admin via setUserRole libera rotas admin", async () => {
    const { user, auth } = await createTestUser();
    await authMod.setUserRole(user.id, "admin");
    const me = await auth("get", "/api/auth/me");
    expect(me.body.user.role).toBe("admin");
    const adminRes = await auth("get", "/api/admin/users");
    expect(adminRes.status).toBe(200);
    expect(Array.isArray(adminRes.body.users)).toBe(true);
  });
});
