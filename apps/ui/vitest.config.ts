import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // `server-only` throws outside a React Server build; tests import server modules directly.
    alias: {
      "server-only": fileURLToPath(new URL("./node_modules/server-only/empty.js", import.meta.url)),
      // Mirrors tsconfig `paths` so Route Handlers can be imported by tests.
      "@/": fileURLToPath(new URL("./src/", import.meta.url)),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
