import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react({ jsxRuntime: "automatic" })],
  esbuild: {
    jsx: "automatic",
  },
  test: {
    environment: "jsdom",
    globals: false,
    setupFiles: ["./src/__tests__/setup.js"],
    include: ["src/**/*.test.js", "src/**/*.test.jsx"],
    testTimeout: 10000,
    reporters: ["default"],
  },
});
