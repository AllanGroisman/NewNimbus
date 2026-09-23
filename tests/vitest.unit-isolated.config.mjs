import { defineConfig } from "vitest/config";
import base, { ISOLATED_UNIT_FILES } from "./vitest.config.mjs";

// Segunda passada dos unitários: os arquivos que mexem em estado global do
// processo, cada um no seu. O porquê está na vitest.config.mjs.
//
// NIMBUS_UNIT_ALL=1 roda TODOS os unitários isolados — é o que o modo watch usa
// (scripts/unit.mjs --watch), já que o watch do vitest acompanha uma config só.

const ALL = process.env.NIMBUS_UNIT_ALL === "1";

export default defineConfig({
  test: {
    ...base.test,
    include: ALL ? ["unit/**/*.test.js"] : ISOLATED_UNIT_FILES,
    exclude: ["**/node_modules/**"],
    poolOptions: { forks: { isolate: true } },
  },
});
