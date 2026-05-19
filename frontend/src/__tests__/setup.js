// Setup global pra testes RTL — registra matchers do jest-dom e mock de localStorage
// quando necessário.

import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// Cleanup automático entre testes (desmonta componentes renderizados, limpa DOM)
afterEach(() => {
  cleanup();
});
