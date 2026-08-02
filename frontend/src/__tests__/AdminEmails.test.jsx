// Admin › E-mails — a tela de edição do texto dos e-mails.
//
// O que estes testes protegem: digitar num campo não pode perder o foco (o
// editor tem 6 campos e uma lista de parágrafos — se o input remontar a cada
// tecla, editar vira tortura), o chip precisa inserir a variável no cursor, e o
// "Salvar" só pode mandar pro backend o que a pessoa realmente mexeu.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("../data/api", () => ({
  // errText é helper puro (não faz rede) — usa a implementação de verdade.
  errText: (err, fallback) => err?.message || fallback,
  adminEmailTemplates: vi.fn(),
  adminEmailTemplatesSave: vi.fn(),
  adminEmailPreview: vi.fn(),
  adminEmailTest: vi.fn(),
}));

import PageAdminEmails from "../pages/AdminEmails.jsx";
import {
  adminEmailTemplates,
  adminEmailTemplatesSave,
  adminEmailPreview,
  adminEmailTest,
} from "../data/api";

const RESPOSTA = {
  groups: [
    { id: "token", label: "Links de conta" },
    { id: "security", label: "Segurança" },
  ],
  meta: [
    {
      key: "verify_email",
      group: "token",
      label: "Confirmar e-mail (conta nova)",
      description: "Enviado no cadastro.",
      canDisable: false,
      ctaUrl: null,
      variables: [{ name: "nome", desc: "Primeiro nome" }],
    },
    {
      key: "password_changed",
      group: "security",
      label: "Senha alterada",
      description: "Aviso de troca de senha.",
      canDisable: true,
      ctaUrl: "https://nimbus.test/",
      variables: [{ name: "nome", desc: "Primeiro nome" }],
    },
  ],
  defaults: {
    verify_email: { subject: "Confirme seu email", title: "Bem-vindo", greeting: "", paragraphs: ["Clique abaixo."], ctaLabel: "Confirmar", footnote: "", tone: "normal" },
    password_changed: { subject: "Senha alterada", title: "Senha alterada", greeting: "{nome}", paragraphs: ["Sua senha mudou."], ctaLabel: "Entrar", footnote: "", tone: "normal" },
  },
  templates: {
    verify_email: { subject: "Confirme seu email", title: "Bem-vindo", greeting: "", paragraphs: ["Clique abaixo."], ctaLabel: "Confirmar", footnote: "", tone: "normal", enabled: true },
    password_changed: { subject: "Senha alterada", title: "Senha alterada", greeting: "{nome}", paragraphs: ["Sua senha mudou."], ctaLabel: "Entrar", footnote: "", tone: "normal", enabled: true },
  },
};

function clone(o) {
  return JSON.parse(JSON.stringify(o));
}

async function montar() {
  const r = render(<PageAdminEmails />);
  // O rótulo aparece duas vezes (na lista e no cabeçalho do editor).
  await screen.findAllByText("Confirmar e-mail (conta nova)");
  return r;
}

beforeEach(() => {
  vi.clearAllMocks();
  adminEmailTemplates.mockResolvedValue(clone(RESPOSTA));
  adminEmailPreview.mockResolvedValue({ subject: "Confirme seu email", html: "<p>oi</p>", text: "oi" });
  adminEmailTemplatesSave.mockImplementation(async () => clone(RESPOSTA));
  adminEmailTest.mockResolvedValue({ ok: true, to: "admin@nimbus.test" });
});

describe("Admin › E-mails — lista", () => {
  it("agrupa os e-mails e abre o primeiro já selecionado", async () => {
    await montar();
    expect(screen.getByText("Links de conta")).toBeTruthy();
    expect(screen.getByText("Segurança")).toBeTruthy();
    expect(screen.getByText("Enviado no cadastro.")).toBeTruthy();
  });

  it("e-mail que não pode ser desligado não mostra a chave, e explica por quê", async () => {
    await montar();
    expect(screen.getByText(/não pode ser desligado/)).toBeTruthy();

    fireEvent.click(screen.getByText("Senha alterada", { selector: "span" }));
    expect(screen.queryByText(/não pode ser desligado/)).toBeNull();
    expect(screen.getByText("Ligado")).toBeTruthy();
  });
});

describe("Admin › E-mails — edição", () => {
  it("digitar no assunto mantém o foco no mesmo campo", async () => {
    await montar();
    const assunto = screen.getByDisplayValue("Confirme seu email");
    assunto.focus();
    fireEvent.change(assunto, { target: { value: "Confirme seu e-mail, por favor" } });

    const depois = screen.getByDisplayValue("Confirme seu e-mail, por favor");
    // Mesmo nó do DOM = o input não remontou; o cursor da pessoa continua onde estava.
    expect(depois).toBe(assunto);
    expect(document.activeElement).toBe(depois);
  });

  it("o chip insere a variável na posição do cursor do último campo focado", async () => {
    await montar();
    const titulo = screen.getByDisplayValue("Bem-vindo");
    titulo.focus();
    fireEvent.focus(titulo);
    titulo.setSelectionRange(3, 3);
    fireEvent.click(screen.getByText("{nome}", { selector: "span" }));

    await waitFor(() => expect(screen.getByDisplayValue("Bem{nome}-vindo")).toBeTruthy());
  });

  it("adiciona e remove parágrafos", async () => {
    await montar();
    fireEvent.click(screen.getByText("+ parágrafo"));
    await waitFor(() => {
      const vazios = screen.getAllByRole("textbox").filter(el => el.tagName === "TEXTAREA" && el.value === "");
      expect(vazios.length).toBeGreaterThan(0);
    });

    fireEvent.click(screen.getAllByTitle("Remover parágrafo")[0]);
    await waitFor(() => expect(screen.queryByDisplayValue("Clique abaixo.")).toBeNull());
  });

  it('"Restaurar padrão" desfaz a edição do e-mail aberto', async () => {
    await montar();
    fireEvent.change(screen.getByDisplayValue("Confirme seu email"), { target: { value: "outra coisa" } });
    fireEvent.click(screen.getByText("Restaurar padrão"));
    await waitFor(() => expect(screen.getByDisplayValue("Confirme seu email")).toBeTruthy());
  });
});

describe("Admin › E-mails — salvar", () => {
  it("Salvar fica desabilitado sem alteração e manda tudo depois de editar", async () => {
    await montar();
    const salvar = screen.getByText("Salvar");
    expect(salvar.disabled).toBe(true);

    fireEvent.change(screen.getByDisplayValue("Confirme seu email"), { target: { value: "Assunto novo" } });
    await waitFor(() => expect(salvar.disabled).toBe(false));
    expect(screen.getByText(/1 e-mail com alteração não salva/)).toBeTruthy();

    fireEvent.click(salvar);
    await waitFor(() => expect(adminEmailTemplatesSave).toHaveBeenCalled());
    const enviado = adminEmailTemplatesSave.mock.calls[0][0];
    expect(enviado.verify_email.subject).toBe("Assunto novo");
  });

  it('"Descartar alterações" volta pro que está no servidor', async () => {
    await montar();
    fireEvent.change(screen.getByDisplayValue("Confirme seu email"), { target: { value: "Assunto novo" } });
    await screen.findByText("Descartar alterações");
    fireEvent.click(screen.getByText("Descartar alterações"));

    await waitFor(() => expect(screen.getByDisplayValue("Confirme seu email")).toBeTruthy());
    expect(screen.getByText("Salvar").disabled).toBe(true);
  });

  it("erro do backend aparece na tela e não some sozinho", async () => {
    adminEmailTemplatesSave.mockRejectedValue(new Error("O assunto não pode ficar vazio"));
    await montar();
    fireEvent.change(screen.getByDisplayValue("Confirme seu email"), { target: { value: "x" } });
    fireEvent.click(screen.getByText("Salvar"));
    await screen.findByText("O assunto não pode ficar vazio");
  });
});

describe("Admin › E-mails — prévia e teste", () => {
  it("pede a prévia do e-mail aberto, com o texto ainda não salvo", async () => {
    await montar();
    // A prévia tem debounce de 400ms.
    await waitFor(() => expect(adminEmailPreview).toHaveBeenCalled(), { timeout: 2000 });

    const [key, block] = adminEmailPreview.mock.calls.at(-1);
    expect(key).toBe("verify_email");
    expect(block.subject).toBe("Confirme seu email");
    expect(block.paragraphs).toEqual(["Clique abaixo."]);
  });

  it("envio de teste confirma pra qual endereço foi", async () => {
    await montar();
    fireEvent.click(screen.getByText("Enviar teste pra mim"));
    await screen.findByText("Teste enviado para admin@nimbus.test.");
    expect(adminEmailTest.mock.calls[0][0]).toBe("verify_email");
  });
});
