import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Tests get supertest with servers bound to 127.0.0.1; see tests/supertest.ts.
    alias: [{ find: /^supertest$/, replacement: fileURLToPath(new URL("./tests/supertest.ts", import.meta.url)) }],
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    setupFiles: ["tests/setup.ts"],
  },
});
