import { useRef } from "react";

// Undo/redo pra <textarea> controlado pelo React.
//
// O undo nativo do navegador não serve aqui: sempre que um botão da barra
// (formatar, inserir variável) reescreve o texto por fora do onChange, o React
// troca o `value` e o histórico interno do textarea vai junto. Então guardamos
// o nosso: uma pilha de { text, start, end } em ref (não precisa re-renderizar).

const LIMIT = 100;
// Digitação corrida vira UMA entrada; passou disso, começa entrada nova.
const COALESCE_MS = 600;

// `taRef` é o ref do textarea, `value` o texto atual e `setValue` quem grava.
export function useTextHistory(taRef, value, setValue) {
  const undoRef = useRef([]);
  const redoRef = useRef([]);
  const lastPushRef = useRef(0);

  const pushEntry = (text, start, end) => {
    const stack = undoRef.current;
    stack.push({ text, start, end });
    if (stack.length > LIMIT) stack.shift();
    redoRef.current = [];
  };

  // Antes de qualquer mutação programática (botões da barra).
  const push = (prevText, ta) => {
    const pos = ta && typeof ta.selectionStart === "number" ? ta.selectionStart : prevText.length;
    const end = ta && typeof ta.selectionEnd === "number" ? ta.selectionEnd : pos;
    pushEntry(prevText, pos, end);
    // Zera o coalescing: o que for digitado depois é uma entrada separada.
    lastPushRef.current = 0;
  };

  // onChange do textarea: decide se funde com a última entrada ou abre uma nova.
  const handleChange = (nextText, ta) => {
    const prev = value || "";
    const now = Date.now();
    const diff = nextText.length - prev.length;
    // Colar/apagar seleção (mais de um caractere de uma vez) sempre vira entrada
    // própria; espaço e quebra de linha fecham a "palavra" atual.
    const bulk = Math.abs(diff) !== 1;
    const caret = ta && typeof ta.selectionStart === "number" ? ta.selectionStart : nextText.length;
    const boundary = diff === 1 && /\s/.test(nextText[caret - 1] || "");
    if (bulk || boundary || now - lastPushRef.current > COALESCE_MS) {
      // O caret vem do texto NOVO; no texto antigo ele estava `diff` antes.
      const start = Math.max(0, Math.min(prev.length, caret - diff));
      pushEntry(prev, start, start);
      lastPushRef.current = now;
    } else {
      redoRef.current = [];
    }
    setValue(nextText);
  };

  // Foco + cursor voltam junto com o texto, senão o undo "pula" pro fim.
  const restoreSelection = (start, end) => {
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      if (typeof ta.setSelectionRange === "function") {
        const max = ta.value.length;
        ta.setSelectionRange(Math.min(start, max), Math.min(end, max));
      }
    });
  };

  const currentEntry = () => {
    const ta = taRef.current;
    const start = ta && typeof ta.selectionStart === "number" ? ta.selectionStart : (value || "").length;
    const end = ta && typeof ta.selectionEnd === "number" ? ta.selectionEnd : start;
    return { text: value || "", start, end };
  };

  const undo = () => {
    const entry = undoRef.current.pop();
    if (!entry) return;
    redoRef.current.push(currentEntry());
    lastPushRef.current = 0;
    setValue(entry.text);
    restoreSelection(entry.start, entry.end);
  };

  const redo = () => {
    const entry = redoRef.current.pop();
    if (!entry) return;
    undoRef.current.push(currentEntry());
    lastPushRef.current = 0;
    setValue(entry.text);
    restoreSelection(entry.start, entry.end);
  };

  // Documento novo (trocou de modelo, descartou edições): histórico do texto
  // antigo não pode ressuscitar num Ctrl+Z.
  const reset = () => {
    undoRef.current = [];
    redoRef.current = [];
    lastPushRef.current = 0;
  };

  const onKeyDown = (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const key = String(e.key || "").toLowerCase();
    if (key === "z") {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    } else if (key === "y") {
      e.preventDefault();
      redo();
    }
  };

  return { onKeyDown, handleChange, push, reset, undo, redo };
}
