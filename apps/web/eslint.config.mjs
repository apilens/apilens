import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Native flat config (eslint-config-next 16). The previous FlatCompat setup
// relied on @eslint/eslintrc being hoisted, which pnpm 10+ no longer does.
export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // Pre-existing debt in the legacy dashboard (126 errors across 46 files
    // when lint became runnable again on v2). Lint was non-blocking in the old
    // CI, so these never surfaced. Kept as warnings so CI can gate on
    // everything else; burn them down while the data layer is re-pointed at
    // the v2 API (M3), then flip back to "error".
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
      "@typescript-eslint/no-explicit-any": "warn",
      "react/no-unescaped-entities": "warn",
      "@next/next/no-html-link-for-pages": "warn",
    },
  },
  globalIgnores(["node_modules/**", ".next/**", "out/**", "build/**", "next-env.d.ts"]),
]);
