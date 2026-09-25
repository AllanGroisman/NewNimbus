// Preferência de tela do admin — filtros, modo de teste, caixinhas — lembrada no
// servidor e igual para todos os admins (data/preferenciasAdmin.js). O que o
// servidor precisa LER para trabalhar continua em app_config próprio (limites,
// robô, palavras); aqui é só como a tela abre.
//
// Valor de tipo errado ou que o `sanear` recusa: vale o padrão, e a tela funciona
// igual — uma chave velha de uma versão anterior da tela não a quebra.
import { useCallback, useMemo, useState, useEffect } from "react";
import { ler, gravar, usePreferencia, recarregarSeVelho } from "./preferenciasAdmin";

// Com `sanear`, é ele quem decide o tipo (um campo numérico guarda o texto do
// input enquanto se digita); sem ele, vale o tipo do padrão.
function normalizar(v, padrao, sanear) {
  if (v === undefined || v === null) return padrao;
  if (sanear) return sanear(v) ?? padrao;
  if (typeof padrao !== "object" && typeof v !== typeof padrao) return padrao;
  if (Array.isArray(padrao) !== Array.isArray(v)) return padrao;
  return v;
}

export function lerLembrado(chave, padrao, sanear = null) {
  return normalizar(ler(chave), padrao, sanear);
}

export function gravarLembrado(chave, v) {
  gravar(chave, v);
}

// `sanear(v)` devolve o valor aceito ou null/undefined para cair no padrão.
// O padrão e o `sanear` valem os da primeira renderização: a tela costuma passá-los
// como literal, e um objeto novo a cada render viraria busca nova a cada render.
export function useLembrado(chave, padrao, sanear = null) {
  const [inicial] = useState(() => ({ padrao, sanear }));
  const bruto = usePreferencia(chave);
  const valor = useMemo(() => normalizar(bruto, inicial.padrao, inicial.sanear), [bruto, inicial]);
  const setValor = useCallback((v) => {
    const atual = normalizar(ler(chave), inicial.padrao, inicial.sanear);
    gravar(chave, typeof v === "function" ? v(atual) : v);
  }, [chave, inicial]);
  // Tela montando é a hora de ver se outro admin mudou alguma coisa.
  useEffect(() => { recarregarSeVelho(); }, []);
  return [valor, setValor];
}

// O `sanear` mais comum: só aceita um dos valores de uma lista de opções.
export const umDe = (opcoes) => (v) => (opcoes.includes(v) ? v : null);
