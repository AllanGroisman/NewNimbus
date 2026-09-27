// Admin › Downloader.
//
// O que estes testes seguram é o `?k=` dos links de download. Os botões
// "Salvar" e "Baixar tudo (.zip)" são <a href> puros — não passam pelo
// data/api.js e portanto não levam o header Authorization. Quem autoriza é a
// chave do job. Se alguém "limpar" esses href, o download volta a dar 404 e
// nenhum outro teste percebe, porque a tela continua renderizando igual.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../data/api", () => ({
  errText: (err, fallback) => err?.message || fallback,
  adminDlList: vi.fn(),
  adminDlVideo: vi.fn(),
  adminDlTemplatesRestore: vi.fn(),
  adminDlProducts: vi.fn(),
  adminDlTemplates: vi.fn(),
  adminDlJobCreate: vi.fn(),
  adminDlJob: vi.fn(),
  adminDlTemplateSave: vi.fn(),
  adminDlTemplateRemove: vi.fn(),
}));

import PageAdminDownloader from "../pages/AdminDownloader.jsx";
import { adminDlList, adminDlVideo, adminDlProducts, adminDlTemplates, adminDlJob } from "../data/api";
import { _zerarParaTestes as zerarPrefsAdmin } from "../data/preferenciasAdmin";

// As preferências de tela do admin vivem num módulo que dura a suíte inteira.
beforeEach(() => zerarPrefsAdmin());

const VIDEOS = [
  { id: "aaa", title: "Primeiro vídeo", url: "https://www.youtube.com/watch?v=aaa", thumbnail: null, duration: 61, views: 1000, uploadDate: "20260101" },
  { id: "bbb", title: "Segundo vídeo", url: "https://www.youtube.com/watch?v=bbb", thumbnail: null, duration: 30, views: 20, uploadDate: "20260102" },
];

const CHAVE = "f".repeat(48);

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  adminDlTemplates.mockResolvedValue({ templates: [] });
});

describe("estado inicial", () => {
  it("convida a colar um link em vez de mostrar tela vazia", async () => {
    render(<PageAdminDownloader />);
    expect(await screen.findByText(/Cole o link de um perfil para listar/i)).toBeInTheDocument();
  });
});

describe("listagem", () => {
  it("mostra um card por vídeo e o canal", async () => {
    adminDlList.mockResolvedValue({ platform: "youtube", url: "https://www.youtube.com/@canal/videos", channel: "Canal de Teste", videos: VIDEOS });

    render(<PageAdminDownloader />);
    await userEvent.type(screen.getByLabelText(/Link do perfil ou do vídeo/i), "https://www.youtube.com/@canal");
    await userEvent.click(screen.getByRole("button", { name: /Listar vídeos/i }));

    expect(await screen.findByText("Canal de Teste")).toBeInTheDocument();
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    expect(screen.getByText("Primeiro vídeo")).toBeInTheDocument();
  });

  it("avisa quando o perfil não tem vídeo, em vez de ficar em silêncio", async () => {
    adminDlList.mockResolvedValue({ platform: "youtube", url: "u", channel: null, videos: [] });

    render(<PageAdminDownloader />);
    await userEvent.type(screen.getByLabelText(/Link do perfil ou do vídeo/i), "https://www.youtube.com/@vazio");
    await userEvent.click(screen.getByRole("button", { name: /Listar vídeos/i }));

    expect(await screen.findByText(/Nenhum vídeo encontrado/i)).toBeInTheDocument();
  });

  it("mostra a mensagem do backend quando a listagem falha", async () => {
    adminDlList.mockRejectedValue(new Error("Não foi possível listar os vídeos: canal privado"));

    render(<PageAdminDownloader />);
    await userEvent.type(screen.getByLabelText(/Link do perfil ou do vídeo/i), "https://www.youtube.com/@privado");
    await userEvent.click(screen.getByRole("button", { name: /Listar vídeos/i }));

    expect(await screen.findByText(/canal privado/i)).toBeInTheDocument();
  });
});

describe("perfil × vídeo avulso", () => {
  it("manda a ordem 'mais vistos' para o backend", async () => {
    adminDlList.mockResolvedValue({ platform: "youtube", url: "u", channel: "Canal", videos: VIDEOS });

    render(<PageAdminDownloader />);
    await userEvent.type(screen.getByLabelText(/Link do perfil ou do vídeo/i), "https://www.youtube.com/@canal");
    await userEvent.click(screen.getByRole("button", { name: /Mais vistos/i }));
    await userEvent.click(screen.getByRole("button", { name: /Listar vídeos/i }));

    await waitFor(() => expect(adminDlList).toHaveBeenCalledWith(expect.objectContaining({ sort: "views" })));
  });

  it("link de vídeo vira lista avulsa que mistura plataformas", async () => {
    adminDlProducts.mockResolvedValue({ products: [] });
    adminDlVideo
      .mockResolvedValueOnce({ video: { id: "yt1", platform: "youtube", title: "Vídeo do YouTube", url: "https://www.youtube.com/shorts/yt1", vertical: true } })
      .mockResolvedValueOnce({ video: { id: "sp1", platform: "shopee", title: "Vídeo da Shopee", url: "https://sv.shopee.com.br/web/@x/video/sp1", vertical: true } });

    render(<PageAdminDownloader />);
    const input = screen.getByLabelText(/Link do perfil ou do vídeo/i);
    await userEvent.type(input, "https://www.youtube.com/shorts/yt1");
    await userEvent.click(screen.getByRole("button", { name: /Adicionar à lista/i }));
    expect(await screen.findByText("Vídeo do YouTube")).toBeInTheDocument();

    await userEvent.type(input, "https://sv.shopee.com.br/web/@x/video/sp1");
    await userEvent.click(screen.getByRole("button", { name: /Adicionar à lista/i }));
    expect(await screen.findByText("Vídeo da Shopee")).toBeInTheDocument();

    expect(adminDlList).not.toHaveBeenCalled();
    expect(screen.getByText("Lista de vídeos")).toBeInTheDocument();
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
  });
});

describe("links de download", () => {
  // O teste que carrega o peso: sem o ?k= o backend responde 404.
  it("carrega a chave do job no .zip e em cada arquivo", async () => {
    sessionStorage.setItem("nimbus_dl_state", JSON.stringify({
      params: { url: "https://www.youtube.com/@canal", limit: 50, tab: "videos" },
      result: { platform: "youtube", url: "https://www.youtube.com/@canal/videos", channel: "Canal", videos: VIDEOS },
      products: {}, selected: [], onlyWithProduct: false, jobId: "job-1", templateId: "",
    }));
    adminDlJob.mockResolvedValue({
      id: "job-1",
      key: CHAVE,
      finished: true,
      hasTemplate: false,
      items: [{ id: "aaa", title: "Primeiro vídeo", status: "done", percent: 100, error: null, warning: null, filename: "a.mp4", raw: false }],
    });

    render(<PageAdminDownloader />);

    const zip = await screen.findByRole("link", { name: /Baixar tudo/i });
    expect(zip).toHaveAttribute("href", `/api/admin/downloader/jobs/job-1/zip?k=${CHAVE}`);

    const salvar = screen.getByRole("link", { name: /^Salvar$/ });
    expect(salvar).toHaveAttribute("href", `/api/admin/downloader/jobs/job-1/file/aaa?k=${CHAVE}`);
  });

  it("oferece o original com raw=1 junto da chave quando houve template", async () => {
    sessionStorage.setItem("nimbus_dl_state", JSON.stringify({
      params: null,
      result: { platform: "youtube", url: "u", channel: "Canal", videos: VIDEOS },
      products: {}, selected: [], onlyWithProduct: false, jobId: "job-2", templateId: "",
    }));
    adminDlJob.mockResolvedValue({
      id: "job-2",
      key: CHAVE,
      finished: true,
      hasTemplate: true,
      items: [{ id: "aaa", title: "Primeiro vídeo", status: "done", percent: 100, error: null, warning: null, filename: "a.mp4", raw: true }],
    });

    render(<PageAdminDownloader />);

    const original = await screen.findByRole("link", { name: "Original" });
    expect(original).toHaveAttribute("href", `/api/admin/downloader/jobs/job-2/file/aaa?k=${CHAVE}&raw=1`);
    expect(screen.getByRole("link", { name: /\.zip sem template/i }))
      .toHaveAttribute("href", `/api/admin/downloader/jobs/job-2/zip?k=${CHAVE}&raw=1`);
  });

  it("some sem alarde quando o backend já esqueceu o job (restart do PM2)", async () => {
    // A fila é em memória: reiniciar o backend apaga os lotes. O painel some,
    // mas isso não é erro pro usuário — ele não fez nada errado.
    sessionStorage.setItem("nimbus_dl_state", JSON.stringify({
      params: null,
      result: { platform: "youtube", url: "u", channel: "Canal", videos: VIDEOS },
      products: {}, selected: [], onlyWithProduct: false, jobId: "job-morto", templateId: "",
    }));
    adminDlJob.mockRejectedValue(new Error("Download não encontrado (pode ter expirado)."));

    render(<PageAdminDownloader />);

    await waitFor(() => expect(adminDlJob).toHaveBeenCalled());
    expect(screen.queryByText(/Download não encontrado/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Baixar tudo/i })).not.toBeInTheDocument();
  });
});
