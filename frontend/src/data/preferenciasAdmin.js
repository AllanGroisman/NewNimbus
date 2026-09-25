// As preferências de tela do admin — filtros, modos, caixinhas — guardadas no
// SERVIDOR e iguais para todos os admins (backend/admin-prefs.js). Quem usa é o
// `useLembrado` (data/useLembrado.js); as telas não falam com este módulo direto.
//
// Como anda:
//   - `carregar()` busca o mapa inteiro uma vez no login do admin (App.jsx), e de
//     novo quando uma tela monta e a última leitura tem mais de 30s — é assim que
//     a escolha de um admin chega à tela do outro.
//   - `gravar()` muda na hora (a tela não espera rede) e manda o PUT daquela chave
//     com uma espera de 600ms: a busca por texto grava uma vez, não uma por tecla.
//   - O localStorage virou só cópia: é o que vale enquanto o GET não voltou, ou se
//     ele falhar. E é de lá que saem, uma vez, as preferências que cada navegador
//     guardava antes deste módulo existir (LEGADO).
import { useSyncExternalStore } from "react";
import { adminPrefsGet, adminPrefSet } from "./api";

const CHAVE_CACHE = "nimbus.adminPrefs";
const ESPERA_MS = 600;
const VELHO_MS = 30_000;

// As chaves que moravam soltas no localStorage de cada navegador. Os booleanos
// eram "1"/"0"; o resto, JSON.
const LEGADO = [
  "cupons.soSemProdutos", "cupons.listaSemTeto", "cupons.mlFiltros",
  "cupons.testeModo", "cupons.importarComProdutos",
  "nimbus.repasse.checkoutDepurar", "nimbus.repasse.filtroDias",
  "nimbus.repasse.filtroStatus", "nimbus.repasse.filtroBusca",
];

function lerCache() {
  try {
    const v = JSON.parse(localStorage.getItem(CHAVE_CACHE));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}
function gravarCache(p) {
  try { localStorage.setItem(CHAVE_CACHE, JSON.stringify(p)); } catch { /* sem storage */ }
}
function lerLegado(chave) {
  try {
    const raw = localStorage.getItem(chave);
    if (raw == null) return undefined;
    if (raw === "1") return true;
    if (raw === "0") return false;
    return JSON.parse(raw);
  } catch { return undefined; }
}
const igual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

let prefs = lerCache();
let pronto = false;          // o primeiro carregar() terminou (bem ou mal)
let ativo = false;           // há sessão de admin: só então grava no servidor
let lidoEm = 0;
let emVoo = null;
const esperas = new Map();   // chave → timer do PUT
const pendentes = new Map(); // chave → valor ainda não confirmado pelo servidor
const ouvintes = new Set();

const avisar = () => ouvintes.forEach(f => f());

function assinar(f) {
  ouvintes.add(f);
  return () => ouvintes.delete(f);
}

export function ler(chave) {
  return prefs[chave];
}

async function enviar(chave) {
  esperas.delete(chave);
  if (!pendentes.has(chave)) return;
  const valor = pendentes.get(chave);
  try {
    await adminPrefSet(chave, valor === undefined ? null : valor);
    if (pendentes.get(chave) === valor) pendentes.delete(chave);
  } catch (err) {
    // Fica valendo aqui e no cache; o próximo gravar() da chave tenta de novo.
    console.warn(`[prefs] não deu pra salvar "${chave}":`, err?.message || err);
  }
}

function agendar(chave) {
  clearTimeout(esperas.get(chave));
  esperas.set(chave, setTimeout(() => enviar(chave), ESPERA_MS));
}

export function gravar(chave, valor) {
  if (igual(prefs[chave], valor)) return;
  prefs = { ...prefs, [chave]: valor };
  gravarCache(prefs);
  pendentes.set(chave, valor);
  if (ativo) agendar(chave);
  avisar();
}

export function carregar() {
  ativo = true;
  if (emVoo) return emVoo;
  // O que foi mexido antes do login virar sessão de admin sobe agora.
  for (const chave of pendentes.keys()) if (!esperas.has(chave)) agendar(chave);
  emVoo = (async () => {
    try {
      const r = await adminPrefsGet();
      const doServidor = r?.prefs && typeof r.prefs === "object" ? r.prefs : {};
      const next = {};
      for (const [k, v] of Object.entries(doServidor)) {
        // Mesmo conteúdo, mesmo objeto: a tela não refaz busca à toa.
        next[k] = igual(prefs[k], v) ? prefs[k] : v;
      }
      // O que ainda não subiu ganha do servidor — senão a releitura desfaria o
      // clique de um segundo atrás.
      for (const [k, v] of pendentes) next[k] = v;
      for (const chave of LEGADO) {
        if (chave in next) continue;
        const v = lerLegado(chave);
        if (v === undefined) continue;
        next[chave] = v;
        pendentes.set(chave, v);
        agendar(chave);
      }
      prefs = next;
      gravarCache(prefs);
      lidoEm = Date.now();
    } catch (err) {
      // Sem servidor, vale o cache: a tela funciona, só não compartilha.
      console.warn("[prefs] não deu pra carregar as preferências do admin:", err?.message || err);
    } finally {
      pronto = true;
      emVoo = null;
      avisar();
    }
  })();
  return emVoo;
}

export function recarregarSeVelho() {
  if (!ativo || emVoo) return;
  if (Date.now() - lidoEm > VELHO_MS) carregar();
}

// Logout: o que estava esperando os 600ms sobe já (chamar ANTES de soltar o
// token), e o resto é esquecido, o cache junto — o próximo login pode nem ser admin.
export function zerar() {
  for (const [chave, t] of esperas) {
    clearTimeout(t);
    if (ativo) enviar(chave);
  }
  esperas.clear();
  pendentes.clear();
  prefs = {};
  pronto = false;
  ativo = false;
  lidoEm = 0;
  emVoo = null;
  try { localStorage.removeItem(CHAVE_CACHE); } catch { /* sem storage */ }
  avisar();
}

export function _zerarParaTestes() {
  ativo = false;
  zerar();
}

export function usePreferencia(chave) {
  return useSyncExternalStore(assinar, () => prefs[chave]);
}

export function usePreferenciasProntas() {
  return useSyncExternalStore(assinar, () => pronto);
}
