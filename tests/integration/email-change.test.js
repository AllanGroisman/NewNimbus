// Troca de email confirmada no endereço novo.
//
// A regra que importa: o email da conta NÃO muda no pedido — só quando alguém
// clica no link enviado para o endereço novo. Isso é o que impede um erro de
// digitação de trancar a pessoa fora do login.
//
// Mailer e Stripe são mockados (tests/helpers/*-mock.js).

import { describe, it, expect, beforeEach } from "vitest";
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";
import {
  app, request, createTestUser, uniqueEmail, mailerCalls, resetMailer,
} from "../helpers/app.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const requireCjs = createRequire(import.meta.url);
const backendDir = path.resolve(__dirname, "..", "..", "backend");
const { prisma } = requireCjs(path.join(backendDir, "db.js"));

// O token de confirmação nunca sai na resposta da API (é o que dá posse do
// endereço), então os testes leem direto do banco — como já fazem com o token
// de verificação de email em helpers/app.js.
async function pendingTokenOf(userId) {
  const row = await prisma().user.findUnique({
    where: { id: userId },
    select: { pendingEmail: true, pendingEmailToken: true },
  });
  return row;
}

describe("Troca de email — pedido (POST /api/account/email)", () => {
  beforeEach(() => resetMailer());

  it("guarda o email novo como pendente e manda o link PARA ELE, sem mexer no login", async () => {
    const u = await createTestUser();
    const novo = uniqueEmail("novo");

    const res = await u.auth("post", "/api/account/email").send({ password: u.password, newEmail: novo });
    expect(res.status).toBe(200);
    expect(res.body.pendingEmail).toBe(novo);

    // O email da conta continua o antigo — nada mudou ainda.
    const me = await u.auth("get", "/api/auth/me");
    expect(me.body.user.email).toBe(u.email);
    expect(me.body.user.pendingEmail).toBe(novo);

    // E o login antigo segue valendo.
    const login = await request(app).post("/api/auth/login").send({ email: u.email, password: u.password });
    expect(login.status).toBe(200);

    // O link foi para o endereço novo, não para o atual.
    expect(mailerCalls.sendEmailChangeEmail).toHaveLength(1);
    expect(mailerCalls.sendEmailChangeEmail[0].to).toBe(novo);
  });

  it("recusa sem a senha certa", async () => {
    const u = await createTestUser();
    const res = await u.auth("post", "/api/account/email").send({ password: "ErradaAAA1", newEmail: uniqueEmail("novo") });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_password");
    expect(mailerCalls.sendEmailChangeEmail).toHaveLength(0);
  });

  it("recusa email inválido e o próprio email da conta", async () => {
    const u = await createTestUser();
    const invalido = await u.auth("post", "/api/account/email").send({ password: u.password, newEmail: "arroba-nenhum" });
    expect(invalido.status).toBe(400);

    const mesmo = await u.auth("post", "/api/account/email").send({ password: u.password, newEmail: u.email });
    expect(mesmo.status).toBe(400);
  });

  it("recusa endereço que já é de outra conta (409)", async () => {
    const u = await createTestUser();
    const outro = await createTestUser();
    const res = await u.auth("post", "/api/account/email").send({ password: u.password, newEmail: outro.email });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("email_taken");
  });

  it("exige login", async () => {
    const res = await request(app).post("/api/account/email").send({ password: "x", newEmail: uniqueEmail("novo") });
    expect(res.status).toBe(401);
  });
});

describe("Troca de email — confirmação (POST /api/account/email/confirm)", () => {
  beforeEach(() => resetMailer());

  it("efetiva a troca, derruba as sessões abertas e o login passa a ser o novo", async () => {
    const u = await createTestUser();
    const novo = uniqueEmail("novo");
    await u.auth("post", "/api/account/email").send({ password: u.password, newEmail: novo });
    const { pendingEmailToken } = await pendingTokenOf(u.user.id);

    const res = await request(app).post("/api/account/email/confirm").send({ token: pendingEmailToken });
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(novo);
    expect(res.body.user.pendingEmail).toBeNull();
    // O token não pode voltar na resposta.
    expect(res.body.user.pendingEmailToken).toBeUndefined();

    // A sessão que pediu a troca caiu (tokenVersion subiu).
    const me = await u.auth("get", "/api/auth/me");
    expect(me.status).toBe(401);

    // Login com o endereço novo funciona; com o antigo, não.
    const novoLogin = await request(app).post("/api/auth/login").send({ email: novo, password: u.password });
    expect(novoLogin.status).toBe(200);
    const antigoLogin = await request(app).post("/api/auth/login").send({ email: u.email, password: u.password });
    expect(antigoLogin.status).toBe(401);
  });

  it("token é de uso único", async () => {
    const u = await createTestUser();
    const novo = uniqueEmail("novo");
    await u.auth("post", "/api/account/email").send({ password: u.password, newEmail: novo });
    const { pendingEmailToken } = await pendingTokenOf(u.user.id);

    expect((await request(app).post("/api/account/email/confirm").send({ token: pendingEmailToken })).status).toBe(200);
    expect((await request(app).post("/api/account/email/confirm").send({ token: pendingEmailToken })).status).toBe(400);
  });

  it("recusa token inexistente e link expirado", async () => {
    const inexistente = await request(app).post("/api/account/email/confirm").send({ token: "nao-existe" });
    expect(inexistente.status).toBe(400);

    const u = await createTestUser();
    const novo = uniqueEmail("novo");
    await u.auth("post", "/api/account/email").send({ password: u.password, newEmail: novo });
    const { pendingEmailToken } = await pendingTokenOf(u.user.id);
    await prisma().user.update({
      where: { id: u.user.id },
      data: { pendingEmailExpires: new Date(Date.now() - 1000) },
    });

    const res = await request(app).post("/api/account/email/confirm").send({ token: pendingEmailToken });
    expect(res.status).toBe(400);
    // Expirado limpa o pedido: a conta não fica com uma troca pendente eterna.
    const depois = await pendingTokenOf(u.user.id);
    expect(depois.pendingEmail).toBeNull();
    // E o email da conta segue o antigo.
    const login = await request(app).post("/api/auth/login").send({ email: u.email, password: u.password });
    expect(login.status).toBe(200);
  });

  it("recusa se alguém tomou o endereço entre o pedido e o clique (409)", async () => {
    const u = await createTestUser();
    const novo = uniqueEmail("disputado");
    await u.auth("post", "/api/account/email").send({ password: u.password, newEmail: novo });
    const { pendingEmailToken } = await pendingTokenOf(u.user.id);

    // Outra pessoa cria conta com esse mesmo endereço antes do clique.
    await createTestUser({ email: novo });

    const res = await request(app).post("/api/account/email/confirm").send({ token: pendingEmailToken });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("email_taken");
    // O dono original continua entrando com o email antigo.
    const login = await request(app).post("/api/auth/login").send({ email: u.email, password: u.password });
    expect(login.status).toBe(200);
  });
});
