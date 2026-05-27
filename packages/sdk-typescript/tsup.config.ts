import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/express.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  bundle: true,
  platform: "node",
});
