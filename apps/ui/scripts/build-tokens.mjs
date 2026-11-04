// design/tokens.json (exported from the APILens design system) -> src/styles/tokens.css
// Dark is the first theme, so it is :root; light is [data-theme="light"].
import { readFileSync, writeFileSync } from "node:fs";

const t = JSON.parse(readFileSync(new URL("../design/tokens.json", import.meta.url), "utf8"));
const [first, ...rest] = t.color.themes.map((x) => x.id);
const val = (tok, theme) => (typeof tok.value === "string" ? tok.value : (tok.value[theme] ?? tok.value[first]));
const block = (theme) =>
  [...t.color.tokens, ...(t.shadow?.tokens ?? [])].map((k) => `  --${k.name}: ${val(k, theme)};`).join("\n");

let css = `/* APILens: generated from design/tokens.json by scripts/build-tokens.mjs. Do not edit. */\n`;
css += `:root, [data-theme="${first}"] {\n  color-scheme: ${first};\n${block(first)}\n}\n`;
for (const id of rest) css += `[data-theme="${id}"] {\n  color-scheme: ${id};\n${block(id)}\n}\n`;
css += `:root {\n`;
for (const k of [...t.spacing.tokens, ...t.radius.tokens]) css += `  --${k.name}: ${k.value};\n`;
// next/font injects --f-sans and --f-mono on <html>.
css += `  --font-sans: var(--f-sans), "Inter", system-ui, -apple-system, "Segoe UI", sans-serif;\n`;
css += `  --font-mono: var(--f-mono), "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;\n}\n`;
writeFileSync(new URL("../src/styles/tokens.css", import.meta.url), css);
console.log("wrote src/styles/tokens.css");
