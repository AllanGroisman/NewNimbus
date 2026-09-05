// Jornada de autenticacao: registro, login, /me, troca de senha, gating admin.

import { describe, it, expect } from "vitest";
import { app, request, createTestUser, uniqueEmail, auth as authMod, prisma } from "../helpers/app.js";

// Telefone é obrigatório no cadastro (backend/utils/phone.js): celular com DDD.
const PHONE = "11999999999";

describe("Auth — registro e login", () => {
  it("rejeita email invalido", async () => {
    const res = await request(app).post("/api/auth/register").send({ name: "X", email: "naoeemail", password: "senha123", phone: PHONE });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/email/i);
  });

  it("rejeita senha curta", async () => {
    const res = await request(app).post("/api/auth/register").send({ name: "X", email: uniqueEmail(), password: "123", phone: PHONE });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/senha/i);
  });

  it("cria usuario, exige verificacao de email e nao devolve token direto", async () => {
    const email = uniqueEmail();
    const res = await request(app).post("/api/auth/register").send({ name: "Joao", email, password: "Senha123", phone: PHONE });
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(email);
    expect(res.body.user.role).toBe("user");
    expect(res.body.requiresVerification).toBe(true);
    // Guardado com o 55 na frente, não como a pessoa digitou.
    expect(res.body.user.phone).toBe("5511999999999");
    expect(res.body.user.phoneRequired).toBe(false);
    // Sem token — precisa verificar email primeiro
    expect(res.body.token).toBeUndefined();
    expect(res.body.user.passwordHash).toBeUndefined();
  });

  it("recusa cadastro sem telefone", async () => {
    const res = await request(app).post("/api/auth/register").send({ name: "Sem Fone", email: uniqueEmail(), password: "Senha123" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/telefone/i);
  });

  it("recusa telefone que nao e celular brasileiro", async () => {
    for (const phone of ["1133334444", "(00) 99999-9999", "119999999"]) {
      const res = await request(app).post("/api/auth/register").send({ name: "Fone Torto", email: uniqueEmail(), password: "Senha123", phone });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/telefone/i);
    }
  });

  it("nao permite cadastrar mesmo email duas vezes", async () => {
    const email = uniqueEmail();
    await request(app).post("/api/auth/register").send({ name: "A", email, password: "Senha123", phone: PHONE });
    const dup = await request(app).post("/api/auth/register").send({ name: "B", email, password: "Senha123", phone: PHONE });
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
    const res = await auth("patch", "/api/auth/me").send({ name: "Novo Nome", phone: "11999999999" });
    expect(res.status).toBe(200);
    expect(res.body.user.name).toBe("Novo Nome");
  });

  it("PATCH /me recusa telefone torto — era por aqui que entrava lixo no campo", async () => {
    const { auth } = await createTestUser();
    const res = await auth("patch", "/api/auth/me").send({ name: "Nome", phone: "meu zap" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/telefone/i);
  });
});

describe("Auth — telefone das contas anteriores a regra", () => {
  // Conta sem telefone é o estado de quem entrou antes da regra, de quem criou
  // conta pelo Google e de quem foi provisionado por um pagamento sem o número.
  async function contaSemTelefone() {
    const u = await createTestUser();
    await prisma().user.update({ where: { id: u.user.id }, data: { phone: "" } });
    authMod.invalidateUser(u.user.id);
    return u;
  }

  it("/me marca phoneRequired quando a conta esta sem numero", async () => {
    const { auth } = await contaSemTelefone();
    const res = await auth("get", "/api/auth/me");
    expect(res.status).toBe(200);
    expect(res.body.user.phoneRequired).toBe(true);
  });

  it("POST /api/account/phone grava normalizado e desliga o phoneRequired", async () => {
    const { auth } = await contaSemTelefone();
    const res = await auth("post", "/api/account/phone").send({ phone: "(21) 98765-4321" });
    expect(res.status).toBe(200);
    expect(res.body.user.phone).toBe("5521987654321");
    expect(res.body.user.phoneRequired).toBe(false);

    const me = await auth("get", "/api/auth/me");
    expect(me.body.user.phoneRequired).toBe(false);
  });

  it("POST /api/account/phone recusa numero invalido", async () => {
    const { auth } = await contaSemTelefone();
    const res = await auth("post", "/api/account/phone").send({ phone: "1133334444" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_phone");
  });

  it("telefone nao e write-once como o CPF — pode ser corrigido", async () => {
    const { auth } = await createTestUser();
    const res = await auth("post", "/api/account/phone").send({ phone: "(31) 91234-5678" });
    expect(res.status).toBe(200);
    expect(res.body.user.phone).toBe("5531912345678");
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
