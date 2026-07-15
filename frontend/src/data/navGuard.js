import { createContext, useContext, useEffect } from "react";

// Guard de navegação: telas com formulário registram { dirty, save, discard };
// os pontos de navegação (menu, Voltar, trocar de aba) passam por requestNavigation,
// que abre um diálogo "Salvar / Descartar / Cancelar" quando há alterações não salvas.
export const NavGuardContext = createContext({
  register: () => {},
  requestNavigation: (navFn) => navFn(),
});

// Registra o guard da tela ativa. Sem lista de deps: re-registra a cada render,
// mantendo dirty/save/discard sempre atuais (custo irrelevante nesta escala).
export function useUnsavedGuard(guard) {
  const { register } = useContext(NavGuardContext);
  useEffect(() => {
    register(guard);
    return () => register(null);
  });
}

// Atalho pra disparar uma navegação passando pelo guard.
export function useRequestNavigation() {
  return useContext(NavGuardContext).requestNavigation;
}
