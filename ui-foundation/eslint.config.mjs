import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import { plugin as shadcn } from "@shadcn/lint";

// Two layers of design enforcement:
//   1. @shadcn/lint: class-level rules that understand our Tailwind theme
//      (reads components.json → src/app/globals.css) and our components'
//      variants. It catches restyling a primitive at the call site.
//   2. scripts/ui-guard.mjs: everything ESLint can't see (CSS files, copy,
//      fonts, motion, icon sets). Runs in the Claude Code hook and in `pnpm check`.
export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["**/*.{ts,tsx}"],
    plugins: { shadcn },
    settings: {
      shadcn: {
        ui: "src/components/ui",
        note: "Aperture rules: see DESIGN.md and .claude/skills/aperture-ui.",
      },
    },
    rules: {
      // Call sites may position a primitive (layout, spacing), never re-color or re-shape it.
      "shadcn/no-restyle": ["error", { allow: ["layout", "spacing"] }],
      "shadcn/no-raw-colors": ["error", { allow: [], deny: ["*-white", "*-black"] }],
      "shadcn/no-arbitrary-values": "error",
      "shadcn/no-inline-styles": "error",
      "shadcn/no-unknown-classes": "error",
      "shadcn/require-static-classes": "warn",
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "lucide-react", message: "Icons come from @/components/ui/icon (Phosphor)." },
            { name: "@phosphor-icons/react", message: "Import icons from @/components/ui/icon (RSC-safe, curated set)." },
            { name: "framer-motion", message: "Motion is CSS transitions with the token easing." },
          ],
          patterns: [{ group: ["react-icons", "react-icons/*", "@heroicons/*"], message: "Icons come from @/components/ui/icon." }],
        },
      ],
    },
  },
  {
    // Primitives are where styling is defined, so restyle rules don't apply inside them.
    files: ["src/components/ui/**"],
    rules: {
      "shadcn/no-restyle": "off",
      "shadcn/require-static-classes": "off",
      "no-restricted-imports": "off",
    },
  },
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", "node_modules/**", "test-results/**", "playwright-report/**"]),
]);
