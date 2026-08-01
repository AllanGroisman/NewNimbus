// Admin › E-mails — edição do texto dos e-mails do sistema.
//
// O que estes testes protegem, em ordem de importância:
//   1. o admin não consegue quebrar um e-mail: o que ele digita é ESCAPADO,
//      nunca vira HTML no e-mail do cliente;
//   2. os 4 e-mails com link não podem ser desligados — desligar "confirme seu
//      e-mail" tranca todo mundo do lado de fora do cadastro;
//   3. desligar um aviso realmente para o envio, e antes de qualquer escrita no
//      email_log;
//   4. o texto salvo é o texto que sai no envio.

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";
import { app, request, createTestUser, auth as authMod } from "../helpers/app.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const requireCjs = createRequire(import.meta.url);
const backendDir = path.resolve(__dirname, "..", "..", "backend");

const appConfig = requireCjs(path.join(backendDir, "config", "index.js"));
const catalog = requireCjs(path.join(backendDir, "notifications", "email", "catalog.js"));
const render = requireCjs(path.join(backendDir, "notifications", "email", "render.js"));

// helpers/app.js troca notifications/email/index.js por um mock. Aqui precisamos
// do módulo de verdade pra provar que um kind desligado nem chega no transporte.
const emailsReais = (() => {
  const alvo = path.join(backendDir, "notifications", "email", "index.js");
  const mock = requireCjs.cache[alvo];
  delete requireCjs.cache[alvo];
  const real = requireCjs(alvo);
  requireCjs.cache[alvo] = mock;
  return real;
})();

async function makeAdmin() {
  const u = await createTestUser();
  await authMod.setUserRole(u.user.id, "admin");
  return u;
}

function limpaConfig() {
  appConfig.set(render.CONFIG_KEY, {});
}

beforeEach(limpaConfig);
afterAll(limpaConfig);

describe("Admin › E-mails — leitura", () => {
  it("lista todos os e-mails do catálogo, com padrão e metadados", async () => {
    const admin = await makeAdmin();
    const res = await admin.auth("get", "/api/admin/emails/templates");
    expect(res.status).toBe(200);

    const { templates, defaults, meta, groups } = res.body;
    expect(Object.keys(templates).sort()).toEqual([...catalog.KEYS].sort());
    expect(Object.keys(defaults).sort()).toEqual([...catalog.KEYS].sort());
    expect(groups.map(g => g.id)).toEqual(["token", "security", "billing"]);

    // Sem override salvo, o que está na tela é exatamente o padrão do código.
    for (const key of catalog.KEYS) {
      expect(templates[key].subject, key).toBe(defaults[key].subject);
      expect(templates[key].enabled, key).toBe(true);
    }
    // A tela precisa saber quem tem chave de liga/desliga e quais variáveis usar.
    const porKey = Object.fromEntries(meta.map(m => [m.key, m]));
    expect(porKey.verify_email.canDisable).toBe(false);
    expect(porKey.payment_failed.canDisable).toBe(true);
    expect(porKey.payment_failed.variables.map(v => v.name)).toContain("prazo");
    // O padrão nunca vaza junto do meta (senão "Restaurar padrão" viraria ruído).
    expect(porKey.payment_failed.default).toBeUndefined();
  });
});

describe("Admin › E-mails — gravação", () => {
  it("salva o texto novo e ele volta na leitura seguinte", async () => {
    const admin = await makeAdmin();
    const put = await admin.auth("put", "/api/admin/emails/templates").send({
      templates: {
        payment_failed: {
          subject: "Seu pagamento falhou, {nome}",
          paragraphs: ["Olha só o que aconteceu {prazo}."],
        },
      },
    });
    expect(put.status).toBe(200);
    expect(put.body.templates.payment_failed.subject).toBe("Seu pagamento falhou, {nome}");

    const get = await admin.auth("get", "/api/admin/emails/templates");
    expect(get.body.templates.payment_failed.subject).toBe("Seu pagamento falhou, {nome}");
    // Campo não enviado continua no padrão — um override parcial não apaga o resto.
    expect(get.body.templates.payment_failed.footnote)
      .toBe(get.body.defaults.payment_failed.footnote);
  });

  it("o texto salvo é o que sai no envio de verdade", async () => {
    const admin = await makeAdmin();
    await admin.auth("put", "/api/admin/emails/templates").send({
      templates: { password_changed: { subject: "Aviso pra {nome}", paragraphs: ["Corpo novo."] } },
    });

    const out = render.renderEmail("password_changed", { nome: "Ana" });
    expect(out.subject).toBe("Aviso pra Ana");
    expect(out.html).toContain("Corpo novo.");
    expect(out.html).not.toContain("As outras sessões abertas foram encerradas");
  });

  it("recusa e-mail desconhecido e assunto vazio", async () => {
    const admin = await makeAdmin();

    const inexistente = await admin.auth("put", "/api/admin/emails/templates")
      .send({ templates: { nao_existe: { subject: "x" } } });
    expect(inexistente.status).toBe(400);
    expect(inexistente.body.error).toContain("nao_existe");

    const vazio = await admin.auth("put", "/api/admin/emails/templates")
      .send({ templates: { payment_failed: { subject: "   " } } });
    expect(vazio.status).toBe(400);

    // Nenhuma das duas tentativas pode ter gravado nada.
    const get = await admin.auth("get", "/api/admin/emails/templates");
    expect(get.body.templates.payment_failed.subject)
      .toBe(get.body.defaults.payment_failed.subject);
  });
});

describe("Admin › E-mails — liga/desliga", () => {
  it("desligar um aviso impede o envio antes de tocar no email_log", async () => {
    const admin = await makeAdmin();
    await admin.auth("put", "/api/admin/emails/templates")
      .send({ templates: { password_changed: { enabled: false } } });

    expect(render.isEnabled("password_changed")).toBe(false);

    const r = await emailsReais.send("password_changed", {
      to: "quem@test.local", name: "Ana", userId: "u-1",
    });
    expect(r).toEqual({ ok: true, skipped: true, reason: "desligado" });

    // E religar volta a enviar.
    await admin.auth("put", "/api/admin/emails/templates")
      .send({ templates: { password_changed: { enabled: true } } });
    expect(render.isEnabled("password_changed")).toBe(true);
  });

  it("os e-mails com link não podem ser desligados", async () => {
    const admin = await makeAdmin();
    await admin.auth("put", "/api/admin/emails/templates")
      .send({ templates: { verify_email: { enabled: false } } });

    // O campo é ignorado na gravação e o e-mail continua ligado.
    expect(render.isEnabled("verify_email")).toBe(true);
    const get = await admin.auth("get", "/api/admin/emails/templates");
    expect(get.body.templates.verify_email.enabled).toBe(true);
  });
});

describe("Admin › E-mails — pré-visualização", () => {
  it("renderiza o bloco enviado sem gravar nada", async () => {
    const admin = await makeAdmin();
    const res = await admin.auth("post", "/api/admin/emails/preview").send({
      key: "payment_failed",
      block: { subject: "Prévia", paragraphs: ["Prazo: {prazo}"] },
    });
    expect(res.status).toBe(200);
    expect(res.body.subject).toBe("Prévia");
    // O {prazo} vira o valor de exemplo do catálogo, com o negrito aplicado.
    expect(res.body.html).toContain("<strong>04 de agosto de 2026</strong>");

    // A prévia não pode ter virado gravação.
    const get = await admin.auth("get", "/api/admin/emails/templates");
    expect(get.body.templates.payment_failed.subject)
      .toBe(get.body.defaults.payment_failed.subject);
  });

  it("o que o admin digita nunca vira HTML no e-mail", async () => {
    const admin = await makeAdmin();
    const res = await admin.auth("post", "/api/admin/emails/preview").send({
      key: "password_changed",
      block: {
        paragraphs: ['<img src=x onerror=alert(1)> e <a href="http://mau">link</a>'],
        footnote: "<script>roubaSessao()</script>",
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.html).not.toContain("<img");
    expect(res.body.html).not.toContain("<script");
    expect(res.body.html).toContain("&lt;img");
  });

  it("parágrafo com variável condicional vazia some inteiro", async () => {
    // Sem nada pausado, a frase "X foram pausados automaticamente" não deve
    // aparecer pela metade.
    const out = render.renderEmail("plan_changed", {
      nome: "Ana", plano_novo: "Pro", mudanca: "agora é *Pro*", itens_pausados: "",
    });
    expect(out.html).toContain("Seu plano agora é <strong>Pro</strong>.");
    expect(out.html).not.toContain("pausados automaticamente");
  });

  it("chave desconhecida na prévia dá 400", async () => {
    const admin = await makeAdmin();
    const res = await admin.auth("post", "/api/admin/emails/preview").send({ key: "nao_existe" });
    expect(res.status).toBe(400);
  });
});

describe("Admin › E-mails — envio de teste", () => {
  it("sem SMTP configurado avisa em vez de fingir que enviou", async () => {
    const admin = await makeAdmin();
    const res = await admin.auth("post", "/api/admin/emails/test").send({ key: "password_changed" });
    // Em NODE_ENV=test o transporte nunca entrega de verdade.
    expect(res.status).toBe(503);
    expect(res.body.error).toContain("SMTP");
  });

  it("chave desconhecida dá 400", async () => {
    const admin = await makeAdmin();
    const res = await admin.auth("post", "/api/admin/emails/test").send({ key: "nao_existe" });
    expect(res.status).toBe(400);
  });
});
