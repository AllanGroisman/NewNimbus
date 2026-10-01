import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Modal from "../components/ui/Modal";

afterEach(cleanup);

describe("Modal — fechar", () => {
  it("ESC fecha o modal", async () => {
    const onClose = vi.fn();
    render(<Modal title="Teste" onClose={onClose}><p>conteúdo</p></Modal>);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("o ✕ fecha o modal e tem rótulo acessível", async () => {
    const onClose = vi.fn();
    render(<Modal title="Teste" onClose={onClose}><p>conteúdo</p></Modal>);
    await userEvent.click(screen.getByRole("button", { name: "Fechar" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("por padrão, clicar fora fecha", async () => {
    const onClose = vi.fn();
    const { container } = render(<Modal title="Teste" onClose={onClose}><p>conteúdo</p></Modal>);
    await userEvent.click(container.firstChild);
    expect(onClose).toHaveBeenCalled();
  });

  it("com confirmOnClickOutside, clicar fora NÃO fecha (não perde o que foi digitado)", async () => {
    const onClose = vi.fn();
    const { container } = render(
      <Modal title="Nova campanha" onClose={onClose} confirmOnClickOutside>
        <input aria-label="Nome" defaultValue="rascunho" />
      </Modal>
    );
    await userEvent.click(container.firstChild);
    expect(onClose).not.toHaveBeenCalled();
    // ESC continua funcionando como saída explícita
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});

describe("Modal — acessibilidade e foco", () => {
  it("expõe role=dialog rotulado pelo título", () => {
    render(<Modal title="Pausar campanha?" onClose={() => {}}><p>x</p></Modal>);
    expect(screen.getByRole("dialog", { name: "Pausar campanha?" })).toBeInTheDocument();
  });

  it("foca o primeiro campo ao abrir", () => {
    render(
      <Modal title="Teste" onClose={() => {}}>
        <input aria-label="Nome" />
      </Modal>
    );
    expect(document.activeElement).toBe(screen.getByLabelText("Nome"));
  });

  it("no toque foca a caixa, não o campo (o teclado abriria por cima do modal)", () => {
    const original = window.matchMedia;
    window.matchMedia = (q) => ({ matches: q === "(pointer: coarse)", media: q, addEventListener() {}, removeEventListener() {} });
    try {
      render(
        <Modal title="Teste" onClose={() => {}}>
          <input aria-label="Nome" />
        </Modal>
      );
      expect(document.activeElement).toBe(screen.getByRole("dialog"));
    } finally {
      window.matchMedia = original;
    }
  });

  it("trava o scroll do fundo enquanto aberto e restaura ao fechar", () => {
    const { unmount } = render(<Modal title="Teste" onClose={() => {}}><p>x</p></Modal>);
    expect(document.body.style.overflow).toBe("hidden");
    unmount();
    expect(document.body.style.overflow).not.toBe("hidden");
  });
});
