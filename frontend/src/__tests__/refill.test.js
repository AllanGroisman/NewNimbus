// Mensagem do "Completar fila agora" (src/data/refill.js).

import { describe, it, expect } from "vitest";
import { refillResultMsg, queueMax, DEFAULT_BATCH, MAX_BATCH } from "../data/refill";

// A mensagem do "Completar fila agora". O número que importa é onde a fila
// FICOU contra o máximo da campanha — e, quando entra menos do que cabia, o
// motivo, que é o que evita o "por que só entraram 3?".
describe("refillResultMsg", () => {
  it("fila cheia não é erro, é aviso, e diz onde a fila está", () => {
    const m = refillResultMsg({ full: true, target: "queue", queueSize: 20, limit: 20, added: 0 });
    expect(m.type).toBe("warn");
    expect(m.text).toMatch(/já está cheia/i);
    expect(m.text).toMatch(/fila em 20 de 20/);
  });

  it("conta o que entrou e por que entrou menos do que cabia", () => {
    const m = refillResultMsg({
      target: "queue", added: 8, queueSize: 20, limit: 20,
      skippedSent: 3, skippedAffiliate: 1, removed: 0,
    });
    expect(m.type).toBe("ok");
    expect(m.text).toMatch(/\+8 na fila/);
    expect(m.text).toMatch(/fila em 20 de 20/);
    expect(m.text).toMatch(/3 já na fila ou enviados/);
    expect(m.text).toMatch(/1 sem link de afiliado/);
  });

  it("sem nada novo, explica em vez de mostrar '+0'", () => {
    const m = refillResultMsg({ target: "queue", added: 0, queueSize: 4, limit: 20, removed: 2 });
    expect(m.type).toBe("warn");
    expect(m.text).toMatch(/Nada novo no catálogo/i);
    expect(m.text).toMatch(/2 duplicados removidos/);
  });

  it("campanha de revisão manual fala de 'aguardando revisão', não de fila", () => {
    const m = refillResultMsg({ target: "pending", added: 5, pendingSize: 5, queueSize: 0, limit: 20 });
    expect(m.text).toMatch(/\+5 aguardando revisão/);
    expect(m.text).toMatch(/5 de 20 aguardando revisão/);
  });
});

// O máximo da fila é o mesmo número em toda tela que mostra "na fila": aba,
// visão geral, card da campanha e o botão de preencher.
describe("queueMax", () => {
  it("usa o que a campanha escolheu", () => {
    expect(queueMax({ batchSize: 12 })).toBe(12);
    expect(queueMax({ batchSize: "12" })).toBe(12);
  });

  it("campanha sem o campo (ou com valor inválido) cai no padrão", () => {
    expect(queueMax({})).toBe(DEFAULT_BATCH);
    expect(queueMax(undefined)).toBe(DEFAULT_BATCH);
    expect(queueMax({ batchSize: 0 })).toBe(DEFAULT_BATCH);
    expect(queueMax({ batchSize: "abc" })).toBe(DEFAULT_BATCH);
  });

  it("não passa do teto do sistema", () => {
    expect(queueMax({ batchSize: 999 })).toBe(MAX_BATCH);
  });
});
