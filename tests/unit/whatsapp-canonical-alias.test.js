// Corrida da canonicalização: quando a sessão do id provisório (Date.now()) vira
// a sessão do id-telefone, o id provisório deixava de existir e o painel — que só
// tinha os 3s agendados no connection.open pra ver "connected" — passava a receber
// 404 pra sempre. Quem vincula pelo CÓDIGO DE 8 DÍGITOS precisa sair do navegador
// pra digitar no celular, a aba é suspensa, e o número acabava conectado no worker
// e ausente de whatsapp_numbers (o painel mostrava "nenhum número").
//
// O conserto é deixar um ALIAS de vida curta no lugar do id provisório.

import "../helpers/env.js";
import { describe, it, expect, beforeEach } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const local = require(path.resolve(__dirname, "..", "..", "backend", "whatsapp", "local.js"));
const { decaySnapshot } =
  require(path.resolve(__dirname, "..", "..", "backend", "infra", "session-status.js"));

const USER = "u-monica";
const TMP = "1788791690052";      // id provisório do frontend
const PHONE = "5511943658656";    // id canônico
const INFO = { id: `${PHONE}:6@s.whatsapp.net`, name: "Monica Marinho", phone: PHONE };

describe("alias de canonicalização (local.js)", () => {
  beforeEach(() => local.clearAlias(USER, TMP));

  it("sem alias, o id provisório não existe (é o 404 da rota)", () => {
    expect(local.getSession(USER, TMP)).toBeUndefined();
  });

  it("com alias, o id provisório responde connected com o info do telefone", () => {
    local.setAlias(USER, TMP, { info: INFO, canonicalNumberId: PHONE });
    const s = local.getSession(USER, TMP);
    expect(s.status).toBe("connected");
    expect(s.info.phone).toBe(PHONE);
    expect(s.canonicalNumberId).toBe(PHONE);
    // Sem sock: quem for USAR a sessão passa por ensureConnected e não deve
    // enxergar o alias como socket utilizável.
    expect(s.sock).toBeUndefined();
  });

  it("alias expirado some (TTL de 10 min)", () => {
    local.setAlias(USER, TMP, { info: INFO, canonicalNumberId: PHONE });
    const a = local.getAlias(USER, TMP);
    a.expiresAt = Date.now() - 1;
    expect(local.getAlias(USER, TMP)).toBeNull();
    expect(local.getSession(USER, TMP)).toBeUndefined();
  });

  it("clearAlias derruba o redirecionamento (DELETE do modal cancelado)", () => {
    local.setAlias(USER, TMP, { info: INFO, canonicalNumberId: PHONE });
    local.clearAlias(USER, TMP);
    expect(local.getSession(USER, TMP)).toBeUndefined();
  });
});

describe("alias no snapshot do Redis (session-status.js)", () => {
  const NOW = Date.parse("2026-09-07T15:00:00.000Z");
  const alias = () => ({
    userId: USER, numberId: TMP, status: "connected", info: INFO,
    lastError: null, stuck: false, terminal: false, alias: true,
    canonicalNumberId: PHONE,
    // Bem mais velho que STALE_SNAPSHOT_MS (180s): ninguém republica um alias.
    updatedAt: new Date(NOW - 600_000).toISOString(),
  });

  it("não é rebaixado por idade nem por worker morto", () => {
    const s = alias();
    expect(decaySnapshot(s, { now: NOW, workerAgeSeconds: null })).toBe(s);
    expect(decaySnapshot(s, { now: NOW, workerAgeSeconds: 9999 })).toBe(s);
    expect(decaySnapshot(s, { now: NOW, workerAgeSeconds: 2 }).status).toBe("connected");
  });

  it("snapshot normal com a mesma idade continua sendo rebaixado", () => {
    const normal = { ...alias(), alias: false, canonicalNumberId: null };
    expect(decaySnapshot(normal, { now: NOW, workerAgeSeconds: 2 }).status).toBe("disconnected");
  });
});
