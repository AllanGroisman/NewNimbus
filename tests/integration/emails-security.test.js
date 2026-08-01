// Avisos de segurança da conta por e-mail.
//
// O que estes testes protegem: toda mexida sensível numa conta (senha, e-mail
// de login, suspensão) tem que avisar o dono. Se um invasor trocar a senha, o
// e-mail é o único canal que ainda pertence à vítima — por isso o aviso não
// pode depender de a pessoa abrir o painel.
//
// O módulo notifications/email é mockado (helpers/email-mock.js): aqui checamos
// QUE o aviso foi disparado, para QUEM e de que tipo. A dedupe real tem teste
// próprio em emails-reminders.test.js.

import { describe, it, expect } from "vitest";
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";
import {
  app, request, createTestUser, uniqueEmail, auth, emailByKind, emailCalls,
} from "../helpers/app.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const requireCjs = createRequire(import.meta.url);
const backendDir = path.resolve(__dirname, "..", "..", "backend");
const { prisma } = requireCjs(path.join(backendDir, "db.js"));

describe("E-mails de segurança — senha", () => {
  it("troca de senha logado avisa o dono da conta", async () => {
    const u = await createTestUser();

    const res = await u.auth("post", "/api/auth/password")
      .send({ currentPassword: u.password, newPassword: "NovaSenha123" });
    expect(res.status).toBe(200);

    const avisos = emailByKind("password_changed");
    expect(avisos).toHaveLength(1);
    expect(avisos[0].payload.to).toBe(u.email);
    expect(avisos[0].payload.userId).toBe(u.user.id);
    // Sem throttle, trocar a senha 3x viraria 3 e-mails iguais.
    expect(avisos[0].opts.throttleMs).toBeGreaterThan(0);
  });

  it("senha errada não gera aviso", async () => {
    const u = await createTestUser();
    const res = await u.auth("post", "/api/auth/password")
      .send({ currentPassword: "ErradaTotal1", newPassword: "NovaSenha123" });
    expect(res.status).toBe(400);
    expect(emailByKind("password_changed")).toHaveLength(0);
  });

  it("reset por link avisa que a senha foi redefinida", async () => {
    const u = await createTestUser();

    await request(app).post("/api/auth/forgot-password").send({ email: u.email });
    const row = await prisma().user.findUnique({
      where: { id: u.user.id }, select: { passwordResetToken: true },
    });
    const res = await request(app).post("/api/auth/reset-password")
      .send({ token: row.passwordResetToken, newPassword: "OutraSenha123" });
    expect(res.status).toBe(200);

    const avisos = emailByKind("password_reset_done");
    expect(avisos).toHaveLength(1);
    expect(avisos[0].payload.to).toBe(u.email);
  });

  it("admin redefinindo a senha avisa o dono da conta", async () => {
    const alvo = await createTestUser();
    const admin = await createTestUser();
    await auth.setUserRole(admin.user.id, "admin");

    const res = await admin.auth("patch", `/api/admin/users/${alvo.user.id}/password`)
      .send({ newPassword: "SenhaDoSuporte1" });
    expect(res.status).toBe(200);

    const avisos = emailByKind("admin_password_set");
    expect(avisos).toHaveLength(1);
    expect(avisos[0].payload.to).toBe(alvo.email);
  });
});

describe("E-mails de segurança — suspensão", () => {
  it("suspender avisa o usuário; reativar avisa de novo", async () => {
    const alvo = await createTestUser();
    const admin = await createTestUser();
    await auth.setUserRole(admin.user.id, "admin");

    await admin.auth("patch", `/api/admin/users/${alvo.user.id}/suspend`).send({ suspended: true });
    expect(emailByKind("account_suspended")).toHaveLength(1);
    expect(emailByKind("account_suspended")[0].payload.to).toBe(alvo.email);
    // A chave de dedupe leva o instante da suspensão: repetir a mesma suspensão
    // não repete o aviso, mas uma suspensão nova depois de reativar avisa.
    expect(emailByKind("account_suspended")[0].opts.dedupeKey).toContain(alvo.user.id);

    await admin.auth("patch", `/api/admin/users/${alvo.user.id}/suspend`).send({ suspended: false });
    expect(emailByKind("account_reactivated")).toHaveLength(1);
    expect(emailByKind("account_reactivated")[0].payload.to).toBe(alvo.email);
  });
});

describe("E-mails de segurança — troca de e-mail", () => {
  it("o endereço ANTIGO é avisado do pedido, e de novo quando a troca se efetiva", async () => {
    const u = await createTestUser();
    const novo = uniqueEmail("novo");

    const pedido = await u.auth("post", "/api/account/email")
      .send({ password: u.password, newEmail: novo });
    expect(pedido.status).toBe(200);

    // O link de confirmação vai pro endereço NOVO (auth/mailer, testado em
    // email-change.test.js). Aqui o que importa é o aviso ao endereço ANTIGO.
    const aviso = emailByKind("email_change_requested");
    expect(aviso).toHaveLength(1);
    expect(aviso[0].payload.to).toBe(u.email);
    expect(aviso[0].payload.newEmail).toBe(novo);

    const row = await prisma().user.findUnique({
      where: { id: u.user.id }, select: { pendingEmailToken: true },
    });
    const confirma = await request(app).post("/api/account/email/confirm")
      .send({ token: row.pendingEmailToken });
    expect(confirma.status).toBe(200);

    const efetivada = emailByKind("email_changed");
    expect(efetivada).toHaveLength(1);
    expect(efetivada[0].payload.to).toBe(u.email);      // endereço antigo
    expect(efetivada[0].payload.newEmail).toBe(novo);
  });

  it("cadastro comum não dispara nenhum aviso de segurança", async () => {
    await createTestUser();
    expect(emailCalls).toHaveLength(0);
  });
});
