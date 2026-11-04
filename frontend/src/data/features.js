// Interruptores de função do admin (aba Gerais), vistos pela tela de qualquer
// usuário. Busca uma vez por carregamento e guarda aqui no módulo — evita passar
// prop por várias camadas até quem esconde a função (ex.: GroupDashboard).
import { useEffect, useState } from "react";
import { featuresGet } from "./api";

// Espelha DEFAULTS de backend/feature-flags.js. Se a busca falhar, vale isto.
export const FEATURE_DEFAULTS = { repasseWordFilter: true };

let cache = null;
let pending = null;
const listeners = new Set();

function publish(flags) {
  cache = { ...FEATURE_DEFAULTS, ...(flags || {}) };
  for (const fn of listeners) fn(cache);
}

export function loadFeatures({ force = false } = {}) {
  if (cache && !force) return Promise.resolve(cache);
  if (pending && !force) return pending;
  // Promise.resolve().then: um erro síncrono da chamada (ex.: mock de teste sem
  // featuresGet) também cai no catch e vira "usa os padrões".
  pending = Promise.resolve().then(() => featuresGet())
    .then(r => { publish(r?.flags); return cache; })
    .catch(() => { if (!cache) publish(null); return cache; })
    .finally(() => { pending = null; });
  return pending;
}

// A aba Gerais chama isto depois de salvar, pra o resto da tela já refletir.
export function setFeaturesCache(flags) {
  publish(flags);
}

export function useFeatures() {
  const [flags, setFlags] = useState(cache || FEATURE_DEFAULTS);
  useEffect(() => {
    listeners.add(setFlags);
    // Lê o `cache` na hora (e não o valor que a promise trouxe): um save da aba
    // Gerais no meio do caminho não pode ser sobrescrito pelo valor antigo.
    loadFeatures().then(() => { if (cache) setFlags(cache); });
    return () => { listeners.delete(setFlags); };
  }, []);
  return flags;
}
