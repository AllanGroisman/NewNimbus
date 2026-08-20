// Tutoriais — o parsing do link de vídeo (task 102).
//
// É a parte frágil da tela: o admin cola a URL da barra do navegador, e o que
// vem de lá varia (watch?v=, youtu.be, shorts, com ?t= e ?si= colados). Errar
// aqui mostra um iframe quebrado pra toda a base, então cada formato que as
// pessoas realmente copiam tem um caso abaixo.

import { describe, it, expect } from "vitest";
import { youtubeEmbedUrl, hasTutorial, TUTORIAL_IDS } from "../pages/Tutoriais";

const EMBED = "https://www.youtube.com/embed/VIecfv5IlL0";

describe("youtubeEmbedUrl", () => {
  it("reconhece os formatos que as pessoas copiam", () => {
    expect(youtubeEmbedUrl("https://www.youtube.com/watch?v=VIecfv5IlL0")).toBe(EMBED);
    expect(youtubeEmbedUrl("https://youtube.com/watch?v=VIecfv5IlL0&t=30s")).toBe(EMBED);
    expect(youtubeEmbedUrl("https://m.youtube.com/watch?v=VIecfv5IlL0")).toBe(EMBED);
    expect(youtubeEmbedUrl("https://youtu.be/VIecfv5IlL0")).toBe(EMBED);
    expect(youtubeEmbedUrl("https://youtu.be/VIecfv5IlL0?si=AbC_123")).toBe(EMBED);
    expect(youtubeEmbedUrl("https://www.youtube.com/embed/VIecfv5IlL0")).toBe(EMBED);
    expect(youtubeEmbedUrl("https://www.youtube.com/shorts/VIecfv5IlL0")).toBe(EMBED);
  });

  it("devolve null pro que não dá pra embutir", () => {
    // null (e não uma URL chutada) é o que faz a tela cair no link
    // "Assistir o vídeo ↗" em vez de renderizar um iframe quebrado.
    for (const v of ["", null, undefined, "nao-e-url", "https://vimeo.com/123456",
                     "https://www.youtube.com/", "https://www.youtube.com/watch"]) {
      expect(youtubeEmbedUrl(v)).toBeNull();
    }
  });
});

describe("TUTORIAL_IDS", () => {
  it("os slugs linkados por outras telas continuam existindo", () => {
    // AffiliateML/Amazon/Shopee chamam onOpenTutorial(TUTORIAL_IDS.AFILIADO_*).
    // Renomear qualquer um destes quebra aqueles botões silenciosamente.
    expect(TUTORIAL_IDS.AFILIADO_ML).toBe("afiliado-ml");
    expect(TUTORIAL_IDS.AFILIADO_AMAZON).toBe("afiliado-amazon");
    expect(TUTORIAL_IDS.AFILIADO_SHOPEE).toBe("afiliado-shopee");
  });

  it("hasTutorial valida contra os ids conhecidos", () => {
    expect(hasTutorial("afiliado-ml")).toBe(true);
    expect(hasTutorial("tutorial-que-nao-existe")).toBe(false);
  });
});
