// Admin › Downloader › editor de templates: o que vai para o backend quando o
// usuário mexe no tamanho do vídeo e liga o retângulo atrás do tweet, e a
// prévia ampliada.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../data/api", () => ({
  errText: (err, fallback) => err?.message || fallback,
  adminDlTemplates: vi.fn(),
  adminDlTemplateSave: vi.fn(),
  adminDlTemplateRemove: vi.fn(),
  adminDlTemplatesRestore: vi.fn(),
}));

import TemplateEditor from "../components/admin/downloader/TemplateEditor.jsx";
import { OUTRO, TWEET_CARD } from "../components/admin/downloader/overlay";
import { adminDlTemplates, adminDlTemplateSave } from "../data/api";

// Como o TwitterReact ficou salvo antes de existir o retângulo e o left/width.
const LEGADO = {
  id: "tw", name: "TwitterReact", format: "vertical",
  video: { top: 620, height: 1000, background: "#ffffff", fit: "contain" },
  layers: [{
    type: "tweet", x: 84, y: 150, w: 912, size: 56, avatar: "", name: "Nome da Conta",
    handle: "suaconta", verified: true, text: "oi", date: "17:00", theme: "light", opacity: 1,
  }],
};

const abrir = () => render(
  <TemplateEditor templates={[LEGADO]} initialId="tw" refVideo={null} onClose={vi.fn()} onSaved={vi.fn()} />,
);

const salvo = async () => {
  await userEvent.click(screen.getByRole("button", { name: /salvar template/i }));
  await waitFor(() => expect(adminDlTemplateSave).toHaveBeenCalled());
  return adminDlTemplateSave.mock.calls[0][1];
};

beforeEach(() => {
  vi.clearAllMocks();
  adminDlTemplateSave.mockResolvedValue({});
  adminDlTemplates.mockResolvedValue({ templates: [LEGADO] });
});

describe("tamanho do vídeo", () => {
  it("encolhe largura e altura juntas, mantendo o topo e o centro", async () => {
    abrir();
    fireEvent.change(screen.getByLabelText(/tamanho do vídeo/i), { target: { value: "0.5" } });
    expect((await salvo()).video).toMatchObject({ width: 540, height: 500, left: 270, top: 620 });
  });

  it("centralizar recoloca o vídeo no meio do quadro", async () => {
    abrir();
    fireEvent.change(screen.getByLabelText(/esquerda do vídeo/i), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText(/largura do vídeo/i), { target: { value: "600" } });
    await userEvent.click(screen.getByRole("button", { name: /centralizar/i }));
    expect((await salvo()).video).toMatchObject({ width: 600, left: 240 });
  });
});

describe("retângulo atrás do tweet", () => {
  it("tweet antigo ganha o retângulo padrão ao ligar, e a cor do contorno é editável", async () => {
    abrir();
    await userEvent.click(screen.getByText("Nome da Conta"));
    expect(screen.queryByLabelText(/cor do contorno/i)).toBeNull();
    await userEvent.click(screen.getByLabelText(/retângulo atrás do tweet/i));
    fireEvent.change(screen.getByLabelText(/cor do contorno/i), { target: { value: "#ff0000" } });
    expect((await salvo()).layers[0].card).toEqual({ ...TWEET_CARD, borderColor: "#ff0000" });
  });
});

describe("prévia ampliada", () => {
  it("abre pelo botão e fecha com Esc", async () => {
    abrir();
    await userEvent.click(screen.getByRole("button", { name: /ampliar/i }));
    expect(screen.getByRole("button", { name: /reduzir/i })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(await screen.findByRole("button", { name: /ampliar/i })).toBeTruthy();
  });
});

describe("sumir depois de alguns segundos", () => {
  it("liga com 5s e 1s de sumiço, aceita outro tempo e oferece a animação", async () => {
    abrir();
    await userEvent.click(screen.getByText("Nome da Conta"));
    expect(screen.queryByRole("button", { name: /ver animação/i })).toBeNull();
    await userEvent.click(screen.getByLabelText(/sumir depois de alguns segundos/i));
    fireEvent.change(screen.getByLabelText(/some aos/i), { target: { value: "3" } });
    expect(screen.getByRole("button", { name: /ver animação/i })).toBeTruthy();
    expect((await salvo()).layers[0].exit).toEqual({ at: 3, fade: 1 });
  });

  it("desligar tira o sumiço da camada", async () => {
    render(
      <TemplateEditor
        templates={[{ ...LEGADO, layers: [{ ...LEGADO.layers[0], exit: { at: 2, fade: 0.5 } }] }]}
        initialId="tw" refVideo={null} onClose={vi.fn()} onSaved={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByText("Nome da Conta"));
    await userEvent.click(screen.getByLabelText(/sumir depois de alguns segundos/i));
    expect((await salvo()).layers[0].exit).toBeNull();
  });
});

describe("tela final", () => {
  it("template antigo ganha a tela final padrão ao ligar, com o texto editável", async () => {
    abrir();
    expect(screen.queryByRole("button", { name: /ver tela final/i })).toBeNull();
    await userEvent.click(screen.getByLabelText(/tela final \(entra depois/i));
    fireEvent.change(screen.getByLabelText(/^botão$/i), { target: { value: "ENTRE JÁ" } });
    expect((await salvo()).outro).toEqual({ ...OUTRO, cta: "ENTRE JÁ" });
  });

  it("ligar mostra a tela final na prévia, e o botão volta para o vídeo", async () => {
    abrir();
    await userEvent.click(screen.getByLabelText(/tela final \(entra depois/i));
    await userEvent.click(screen.getByRole("button", { name: /ver vídeo/i }));
    expect(screen.getByRole("button", { name: /ver tela final/i })).toBeTruthy();
  });

  it("desligar mantém os textos, só com show falso", async () => {
    abrir();
    const caixa = screen.getByLabelText(/tela final \(entra depois/i);
    await userEvent.click(caixa);
    await userEvent.click(caixa);
    expect(screen.queryByRole("button", { name: /tela final|ver vídeo/i })).toBeNull();
    expect((await salvo()).outro).toEqual({ ...OUTRO, show: false });
  });
});
