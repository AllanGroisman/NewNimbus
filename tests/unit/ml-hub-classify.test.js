// Leitura do que aconteceu ao abrir o Hub de Afiliados do ML.
// classifyHubResult é pura: recebe o que a página mostrou (url final, título,
// texto, nº de cards) e diz se a sessão entrou ou por que não. Sem navegador.

import "../helpers/env.js";
import { describe, it, expect } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { classifyHubResult } = require(path.resolve(__dirname, "..", "..", "backend", "scraping", "ml-hub.js"));

const HUB = "https://www.mercadolivre.com.br/afiliados/hub";

describe("classifyHubResult", () => {
  it("entrou: Hub com ofertas visíveis", () => {
    const r = classifyHubResult({ finalUrl: HUB, title: "Hub de Afiliados", bodyText: "Ofertas", cardCount: 24 });
    expect(r.ok).toBe(true);
    expect(r.kind).toBe("ok");
    expect(r.reason).toContain("24");
  });

  it("muro de login pela URL de redirecionamento", () => {
    const r = classifyHubResult({ finalUrl: "https://www.mercadolivre.com.br/jms/mlb/lgz/login?go=hub", cardCount: 0 });
    expect(r.ok).toBe(false);
    expect(r.kind).toBe("login");
    expect(r.reason).toMatch(/login/i);
  });

  it("muro de login pelo texto da página, mesmo com a URL do Hub", () => {
    const r = classifyHubResult({ finalUrl: HUB, bodyText: "Para continuar, acesse sua conta", cardCount: 0 });
    expect(r.ok).toBe(false);
    expect(r.kind).toBe("login");
  });

  it("CAPTCHA", () => {
    const r = classifyHubResult({ finalUrl: "https://www.mercadolivre.com.br/captcha/wall", title: "Seguridad", cardCount: 0 });
    expect(r.ok).toBe(false);
    expect(r.kind).toBe("captcha");
  });

  it("desvio pra outra página do ML conta como sessão inválida", () => {
    const r = classifyHubResult({ finalUrl: "https://www.mercadolivre.com.br/", cardCount: 30 });
    expect(r.ok).toBe(false);
    expect(r.kind).toBe("login");
  });

  it("entrou mas sem ofertas — sucesso com aviso, não falha", () => {
    const r = classifyHubResult({ finalUrl: HUB, title: "Hub de Afiliados", cardCount: 0 });
    expect(r.ok).toBe(true);
    expect(r.kind).toBe("empty");
    expect(r.reason).toMatch(/nenhuma oferta/i);
  });

  it("sem nenhum dado não passa por sucesso", () => {
    expect(classifyHubResult().ok).toBe(false);
  });
});
