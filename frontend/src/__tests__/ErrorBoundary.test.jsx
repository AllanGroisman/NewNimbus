// ErrorBoundary — a rede que impede a tela branca (task 43).
// Antes, qualquer exceção durante o render desmontava a árvore inteira do React
// e o usuário ficava olhando uma página em branco, sem saber que deu erro.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import ErrorBoundary from "../components/ErrorBoundary";

function Explode() {
  throw new Error("boom interno em inglês");
}

let consoleError;
beforeEach(() => {
  // O React loga o erro capturado; silencia pra não poluir a saída do teste.
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => consoleError.mockRestore());

describe("ErrorBoundary", () => {
  it("mostra o fallback em português quando o filho estoura", () => {
    render(<ErrorBoundary><Explode /></ErrorBoundary>);
    expect(screen.getByText("Algo deu errado nesta tela")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Recarregar a página/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Voltar ao painel/i })).toBeInTheDocument();
  });

  it("não vaza a mensagem técnica do erro no corpo da página", () => {
    const { container } = render(<ErrorBoundary><Explode /></ErrorBoundary>);
    // Em DEV o detalhe existe dentro de um <details> fechado; o que não pode é
    // a mensagem crua aparecer como texto principal da tela.
    const heading = container.querySelector("h1");
    expect(heading.textContent).not.toMatch(/boom interno/);
  });

  it("renderiza os filhos normalmente quando não há erro", () => {
    render(<ErrorBoundary><p>conteúdo normal</p></ErrorBoundary>);
    expect(screen.getByText("conteúdo normal")).toBeInTheDocument();
    expect(screen.queryByText("Algo deu errado nesta tela")).toBeNull();
  });
});
