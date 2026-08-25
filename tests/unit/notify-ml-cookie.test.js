// Aviso de cookie de afiliado do ML vencido.
//
// A regra que importa: NUNCA um aviso por link. O createLink roda a cada envio, e
// um 401 isolado no meio de uma rajada não pode virar mensagem — só um período
// ruim contínuo avisa, e a volta ao normal avisa de novo.
import "../helpers/env.js";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const backend = (...p) => path.resolve(__dirname, "..", "..", "backend", ...p);

const alert = require(backend("notifications", "affiliate-alert.js"));
const adminNotifier = require(backend("notifications", "admin-notifier.js"));
const userNotifier = require(backend("notifications", "user-notifier.js"));

let expired, recovered;

beforeEach(() => {
  vi.useFakeTimers();
  userNotifier.__clearAlertState();
  expired = vi.spyOn(adminNotifier, "notifyMLCookieExpired").mockResolvedValue();
  recovered = vi.spyOn(adminNotifier, "notifyMLCookieRecovered").mockResolvedValue();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("mlCookieState", () => {
  it("401 isolado dentro da carência não vira aviso", async () => {
    alert.mlCookieState("u1", false, "tag1");
    vi.advanceTimersByTime(alert.GRACE_MS - 1000);
    alert.mlCookieState("u1", true, "tag1");
    vi.advanceTimersByTime(alert.GRACE_MS * 2);
    await Promise.resolve();

    expect(expired).not.toHaveBeenCalled();
    expect(recovered).not.toHaveBeenCalled();
  });

  it("cookie ruim durante toda a carência avisa uma vez só", async () => {
    alert.mlCookieState("u2", false, "tag2");
    alert.mlCookieState("u2", false, "tag2");
    alert.mlCookieState("u2", false, "tag2");
    vi.advanceTimersByTime(alert.GRACE_MS + 1000);
    await Promise.resolve();

    expect(expired).toHaveBeenCalledTimes(1);
    expect(expired).toHaveBeenCalledWith({ tag: "tag2" });
  });

  it("depois do aviso, o primeiro sucesso manda o 'voltou ao normal'", async () => {
    alert.mlCookieState("u3", false, "tag3");
    vi.advanceTimersByTime(alert.GRACE_MS + 1000);
    await Promise.resolve();
    expect(expired).toHaveBeenCalledTimes(1);

    alert.mlCookieState("u3", true, "tag3");
    await Promise.resolve();
    expect(recovered).toHaveBeenCalledWith({ tag: "tag3" });
  });

  it("cada usuário tem seu próprio estado", async () => {
    alert.mlCookieState("u4", false, "tag4");
    alert.mlCookieState("u5", false, "tag5");
    vi.advanceTimersByTime(alert.GRACE_MS + 1000);
    await Promise.resolve();

    expect(expired).toHaveBeenCalledTimes(2);
    expect(expired.mock.calls.map(c => c[0].tag).sort()).toEqual(["tag4", "tag5"]);
  });
});
