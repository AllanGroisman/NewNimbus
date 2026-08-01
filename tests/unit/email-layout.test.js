// Layout e registry dos e-mails transacionais.
//
// O teste que mais paga é o loop sobre TODOS os kinds: um template novo que
// esqueça o subject, ou que quebre com um payload mínimo, cai aqui na hora de
// ser adicionado — e não no dia em que um cliente deixaria de receber o aviso.

import { describe, it, expect } from "vitest";
import "../helpers/env.js";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const backendDir = path.resolve(__dirname, "..", "..", "backend");

const layout = require(path.join(backendDir, "notifications", "email", "layout.js"));
const registry = require(path.join(backendDir, "notifications", "email", "registry.js"));

describe("email — esc()", () => {
  it("neutraliza tags e aspas", () => {
    expect(layout.esc('<script>alert("x")</script>'))
      .toBe("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  });

  it("null/undefined viram string vazia, não 'null'", () => {
    expect(layout.esc(null)).toBe("");
    expect(layout.esc(undefined)).toBe("");
  });
});

describe("email — baseLayout / baseText", () => {
  it("monta html com botão e texto puro equivalente", () => {
    const block = {
      title: "Título",
      greeting: "Ana",
      paragraphs: ["Primeiro <strong>parágrafo</strong>."],
      cta: { label: "Abrir", url: "https://exemplo.test/assinatura" },
      footnote: "Rodapé.",
    };
    const html = layout.baseLayout(block);
    const text = layout.baseText(block);

    expect(html).toContain("https://exemplo.test/assinatura");
    expect(html).toContain("Abrir");
    // No texto puro as tags dos parágrafos somem, o conteúdo fica.
    expect(text).toContain("Primeiro parágrafo.");
    expect(text).not.toContain("<strong>");
    expect(text).toContain("Abrir: https://exemplo.test/assinatura");
  });

  it("nome do usuário é escapado no corpo", () => {
    const html = layout.baseLayout({ title: "T", greeting: '<img src=x onerror=1>', paragraphs: [] });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("não vaza 'undefined' quando faltam campos opcionais", () => {
    const html = layout.baseLayout({ title: "T" });
    expect(html).not.toContain("undefined");
    expect(layout.baseText({ title: "T" })).not.toContain("undefined");
  });
});

describe("email — registry", () => {
  // Payload com todos os campos que qualquer template pode pedir. Um template
  // não pode explodir só porque recebeu um campo a mais.
  const payload = {
    to: "cliente@test.local",
    name: "Ana Souza",
    userId: "u-1",
    newEmail: "novo@test.local",
    planLabel: "Pro",
    fromPlanLabel: "Básico",
    toPlanLabel: "Pro",
    deadline: new Date("2026-08-04T12:00:00Z"),
    periodEnd: new Date("2026-08-15T12:00:00Z"),
    daysLeft: 3,
    pausedGroups: 2,
    pausedNumbers: 1,
  };

  it("tem pelo menos um template registrado", () => {
    expect(registry.kinds().length).toBeGreaterThan(0);
  });

  it("todo kind renderiza subject, html e text", () => {
    for (const kind of registry.kinds()) {
      const out = registry.get(kind)(payload);
      expect(out.subject, `subject de ${kind}`).toBeTruthy();
      expect(out.html, `html de ${kind}`).toContain("<div");
      expect(out.text, `text de ${kind}`).toBeTruthy();
      expect(out.html, `${kind} não pode vazar undefined`).not.toContain("undefined");
    }
  });

  it("kind desconhecido devolve null", () => {
    expect(registry.get("nao_existe")).toBeNull();
  });
});
