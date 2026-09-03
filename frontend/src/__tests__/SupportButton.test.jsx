// Botão de suporte no canto (task 34): era um "?" que abria um menu de ajuda e
// virou um atalho direto pra conversa de suporte no WhatsApp.

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import SupportButton from "../components/onboarding/SupportButton";

describe("SupportButton", () => {
  it("é um link para o WhatsApp do suporte, com a mensagem já escrita", () => {
    render(<SupportButton />);
    const link = screen.getByRole("link", { name: /suporte no WhatsApp/i });
    const href = link.getAttribute("href");
    expect(href.startsWith("https://wa.me/55997140686?text=")).toBe(true);
    expect(decodeURIComponent(href.split("?text=")[1])).toContain("Nimbus");
  });

  it("abre em outra aba sem dar acesso à janela do painel", () => {
    render(<SupportButton />);
    const link = screen.getByRole("link", { name: /suporte no WhatsApp/i });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  it("não tem mais o menu de ajuda nem o botão de interrogação", () => {
    const { container } = render(<SupportButton />);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.textContent).not.toContain("?");
  });

  it("mantém o alvo do tour que ilumina o botão", () => {
    const { container } = render(<SupportButton />);
    expect(container.querySelector('[data-tour="support-button"]')).not.toBeNull();
  });
});
