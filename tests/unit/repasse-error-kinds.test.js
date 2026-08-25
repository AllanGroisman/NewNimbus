// Catálogo fechado de motivos de descarte do repasse.
//
// O ponto destes testes é impedir que a lista volte a virar texto livre: todo
// motivo precisa de rótulo, de "o que aconteceu" e de "o que fazer" separados, e
// os motivos que o scraper emite de dentro do navegador (literais, porque
// page.evaluate não enxerga o require) têm que existir no catálogo.

import "../helpers/env.js";
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const backend = path.resolve(__dirname, "..", "..", "backend");
const { KIND, ERROR_KINDS, STAGE, STAGE_ORDER, classifyFromText } = require(path.join(backend, "repasse", "error-kinds.js"));

describe("ERROR_KINDS", () => {
  it("cobre todos os motivos da lista fechada", () => {
    for (const kind of Object.values(KIND)) {
      expect(ERROR_KINDS[kind], `faltou entrada para ${kind}`).toBeTruthy();
    }
  });

  it("todo motivo separa o que aconteceu do que fazer", () => {
    for (const [kind, info] of Object.entries(ERROR_KINDS)) {
      expect(info.label, kind).toBeTruthy();
      expect(info.what, kind).toBeTruthy();
      expect(info.action, kind).toBeTruthy();
      // Se os dois textos fossem iguais, a separação seria só aparência.
      expect(info.what, kind).not.toBe(info.action);
      expect([true, false, null], kind).toContain(info.transient);
    }
  });

  it("cookie vencido pede ação; CAPTCHA é só esperar", () => {
    expect(ERROR_KINDS[KIND.LOGIN_WALL].transient).toBe(false);
    expect(ERROR_KINDS[KIND.LOGIN_WALL].action).toMatch(/cookie/i);
    expect(ERROR_KINDS[KIND.CAPTCHA].transient).toBe(true);
    // O conselho do cookie NÃO pode aparecer no CAPTCHA: era exatamente a mistura
    // que deixava o admin sem saber se devia esperar ou agir.
    expect(ERROR_KINDS[KIND.CAPTCHA].action).not.toMatch(/cookie/i);
  });

  it("STAGE_ORDER cobre toda etapa e é estritamente crescente na ordem do pipeline", () => {
    const seq = [STAGE.STORE, STAGE.AFFILIATE_CONFIG, STAGE.SCRAPE, STAGE.VALIDATE, STAGE.SOURCE, STAGE.QUEUE, STAGE.SEND];
    for (const st of Object.values(STAGE)) expect(STAGE_ORDER[st]).toBeTypeOf("number");
    for (let i = 1; i < seq.length; i++) {
      expect(STAGE_ORDER[seq[i]]).toBeGreaterThan(STAGE_ORDER[seq[i - 1]]);
    }
  });
});

describe("classifyFromText", () => {
  it("mapeia as mensagens reais de bloqueio para o motivo certo", () => {
    expect(classifyFromText("Mercado Livre pediu verificação (CAPTCHA) — bloqueio passageiro, tente daqui a alguns minutos.")).toBe(KIND.CAPTCHA);
    expect(classifyFromText("Amazon retornou CAPTCHA — bloqueio passageiro, tente daqui a alguns minutos.")).toBe(KIND.CAPTCHA);
    expect(classifyFromText("Mercado Livre pediu login — verifique o cookie de afiliado nas Configurações.")).toBe(KIND.LOGIN_WALL);
    expect(classifyFromText("Produto não encontrado na Amazon (o link pode estar quebrado).")).toBe(KIND.NAO_E_PRODUTO);
  });

  it("separa timeout do desconhecido", () => {
    expect(classifyFromText("Navigation timeout of 30000 ms exceeded")).toBe(KIND.TIMEOUT);
    expect(classifyFromText("connect ETIMEDOUT 1.2.3.4:443")).toBe(KIND.TIMEOUT);
    expect(classifyFromText("socket hang up")).toBe(KIND.DESCONHECIDO);
    expect(classifyFromText("")).toBe(KIND.DESCONHECIDO);
    expect(classifyFromText(null)).toBe(KIND.DESCONHECIDO);
  });

  it("reconhece os textos que o próprio capture.js monta", () => {
    expect(classifyFromText("loja não suportada")).toBe(KIND.LOJA_NAO_SUPORTADA);
    expect(classifyFromText("afiliado Amazon não configurado")).toBe(KIND.AFILIADO_AUSENTE);
    expect(classifyFromText("dados insuficientes (sem nome/foto) — provavelmente não é uma página de produto")).toBe(KIND.NAO_E_PRODUTO);
  });
});

describe("paridade com o resto do código", () => {
  // detectBlockPage devolve `kind` como string literal porque parte dele roda
  // dentro do navegador. Sem este teste, um motivo escrito errado lá só apareceria
  // como um selo sem nome no painel, muito depois.
  it("todo kind literal do scraper existe no catálogo", () => {
    const src = fs.readFileSync(path.join(backend, "scraping", "scraper.js"), "utf8");
    const found = [...src.matchAll(/kind:\s*"([a-z-]+)"/g)].map(m => m[1]);
    expect(found.length).toBeGreaterThan(0);
    for (const k of found) expect(ERROR_KINDS[k], `kind "${k}" não está em error-kinds.js`).toBeTruthy();
  });

  // O backfill da migration classifica as linhas antigas pelo texto. Se ele e o
  // classifyFromText discordassem, o histórico contaria diferente do que passa a
  // ser gravado daqui pra frente — e o resumo misturaria as duas contagens.
  it("o backfill da migration só usa motivos do catálogo", () => {
    const sql = fs.readFileSync(
      path.join(backend, "prisma", "migrations", "20260825120000_repasse_log_error_kind", "migration.sql"),
      "utf8",
    );
    const found = [...sql.matchAll(/SET "errorKind" = '([a-z-]+)'/g)].map(m => m[1]);
    expect(found.length).toBeGreaterThan(0);
    for (const k of found) expect(ERROR_KINDS[k], `kind "${k}" do SQL não está em error-kinds.js`).toBeTruthy();
  });
});
