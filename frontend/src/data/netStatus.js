import { useEffect, useState } from "react";

// Estado de conexão com o Nimbus, num lugar só.
//
// Quem alimenta é o http() do api.js: toda resposta bem-sucedida chama
// reportSuccess() e todo erro de rede chama reportFailure(). Como o http() é o
// único ponto de rede do app, isso cobre até as telas que engolem o erro.
//
// Não importa nada do api.js de propósito — o api.js importa daqui, e um
// import de volta criaria ciclo.

// Uma falha isolada acontece (aba dormindo, wifi piscando). Duas seguidas já
// é o servidor fora.
const FAILURES_TO_OFFLINE = 2;
// Enquanto offline, sonda o /healthz com intervalo crescente. Essa rota tem
// access_log off no nginx e não passa pelo rate limiter de /api/.
const PROBE_STEPS = [5000, 10000, 20000, 30000];

let online = true;
let failures = 0;
let probeTimer = null;
let probeStep = 0;
const listeners = new Set();

function emit() {
  for (const cb of listeners) {
    try { cb(online); } catch (err) { console.warn("[nimbus] listener de netStatus falhou:", err); }
  }
}

function setOnline(next) {
  if (next === online) return;
  online = next;
  if (online) { failures = 0; stopProbe(); } else { startProbe(); }
  emit();
}

// ─── API pro resto do app ───────────────────────────────────────────────
export function isOnline() { return online; }

export function subscribe(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function reportSuccess() {
  failures = 0;
  setOnline(true);
}

// Só erro de conexão conta. Um 400 ou 500 do backend significa que o servidor
// está de pé — não é caso de banner de offline.
export function reportFailure(err) {
  if (!err?.offline) return;
  failures += 1;
  if (failures >= FAILURES_TO_OFFLINE) setOnline(false);
}

// ─── Sonda de recuperação ───────────────────────────────────────────────
function stopProbe() {
  if (probeTimer) { clearTimeout(probeTimer); probeTimer = null; }
  probeStep = 0;
}

function scheduleProbe() {
  const delay = PROBE_STEPS[Math.min(probeStep, PROBE_STEPS.length - 1)];
  probeStep += 1;
  probeTimer = setTimeout(runProbe, delay);
}

function startProbe() {
  stopProbe();
  scheduleProbe();
}

async function runProbe() {
  probeTimer = null;
  try {
    const res = await fetch("/healthz", { cache: "no-store" });
    if (res.ok) { setOnline(true); return; }
    // O nginx responde 503 com code server_offline quando o backend não sobe.
    // Já um 503 "degraded" vem do próprio backend — ou seja, ele está de pé.
    let body = null;
    try { body = await res.json(); } catch { /* HTML: backend fora */ }
    if (body && body.code !== "server_offline") { setOnline(true); return; }
  } catch { /* continua fora */ }
  if (!online) scheduleProbe();
}

// ─── Sinal do navegador ─────────────────────────────────────────────────
// navigator.onLine só sabe se a máquina tem rede — não sabe se o Nimbus
// respondeu. Serve pra ficar offline na hora; voltar quem decide é a sonda.
if (typeof window !== "undefined") {
  window.addEventListener("offline", () => setOnline(false));
  window.addEventListener("online", () => { stopProbe(); startProbe(); });
  if (navigator?.onLine === false) online = false;
}

// ─── Hook ───────────────────────────────────────────────────────────────
export function useNetStatus() {
  const [state, setState] = useState(() => ({ online: isOnline(), recovered: false }));

  useEffect(() => {
    let recoveredTimer = null;
    const unsub = subscribe((nowOnline) => {
      setState((prev) => {
        // Voltou do offline: mostra o "conexão restabelecida" por alguns
        // segundos, senão o banner some sem o usuário perceber que voltou.
        const recovered = nowOnline && prev.online === false;
        return { online: nowOnline, recovered };
      });
      if (nowOnline) {
        clearTimeout(recoveredTimer);
        recoveredTimer = setTimeout(() => setState((p) => ({ ...p, recovered: false })), 3000);
      }
    });
    return () => { unsub(); clearTimeout(recoveredTimer); };
  }, []);

  return state;
}

// Só pros testes: zera o singleton entre casos.
export function __resetNetStatus() {
  stopProbe();
  online = true;
  failures = 0;
  listeners.clear();
}
