#!/usr/bin/env node
// Contrast gate for src/styles/tokens.css.
//
// Parses both theme blocks, flattens alpha colors over the surface they sit
// on, and checks every text/surface pair the components actually use against
// WCAG 2.x. Exit 1 on any failure, so a token change can't silently drop
// secondary text below 4.5:1.
//
//   pnpm ui:contrast

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parse, converter, wcagContrast, formatHex } from "culori";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(path.join(root, "src/styles/tokens.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

function block(selectorPattern) {
  const m = css.match(new RegExp(selectorPattern + "\\s*\\{([\\s\\S]*?)\\n\\}"));
  if (!m) throw new Error(`theme block not found: ${selectorPattern}`);
  const vars = {};
  for (const [, name, value] of m[1].matchAll(/--ap-([a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    vars[name] = value.trim().replace(/\s+/g, " ");
  }
  return vars;
}

const dark = block(':root,\\s*\\[data-theme="dark"\\]');
const light = { ...dark, ...block('\\[data-theme="light"\\]') };

const rgb = converter("rgb");
function flatten(color, over) {
  const c = rgb(parse(color));
  if (!c) throw new Error(`unparseable color: ${color}`);
  const a = c.alpha ?? 1;
  if (a === 1 || !over) return c;
  const b = rgb(parse(over));
  return { mode: "rgb", r: c.r * a + b.r * (1 - a), g: c.g * a + b.g * (1 - a), b: c.b * a + b.b * (1 - a) };
}

// [foreground token, surface token, minimum ratio, what it is]
const PAIRS = [
  ["foreground", "background", 7, "primary text on page"],
  ["foreground", "muted", 7, "primary text on hover row"],
  ["muted-foreground", "background", 4.5, "secondary text on page"],
  ["muted-foreground", "card", 4.5, "secondary text on panel"],
  ["muted-foreground", "muted", 4.5, "secondary text on hover row"],
  ["subtle-foreground", "background", 4.5, "tertiary text on page"],
  ["subtle-foreground", "card", 4.5, "tertiary text on panel"],
  ["subtle-foreground", "popover", 4.5, "tertiary text in menus"],
  ["subtle-foreground", "muted", 4.5, "tertiary text on hover row"],
  ["foreground", "field", 7, "input value"],
  ["subtle-foreground", "field", 4.5, "input placeholder"],
  ["foreground", "sidebar-active", 7, "active nav item"],
  ["muted-foreground", "sidebar", 4.5, "nav item at rest"],
  ["muted-foreground", "sidebar-hover", 4.5, "nav item hovered"],
  ["subtle-foreground", "sidebar", 4.5, "nav group label, counts"],
  // Counts step up to muted ink on hovered/active rows (tertiary fails there in light).
  ["muted-foreground", "sidebar-active", 4.5, "count on active nav item"],
  ["brand", "sidebar-active", 3, "active nav icon"],
  ["brand-text", "background", 4.5, "link on page"],
  ["brand-text", "card", 4.5, "link on panel"],
  ["brand", "card", 3, "brand mark / focus outline on panel"],
  ["primary-foreground", "primary", 7, "primary button label"],
  ["brand-foreground", "brand", 4.5, "label on brand fill"],
  ["destructive-foreground", "destructive", 4.5, "destructive button label"],
  ["success", "card", 4.5, "success text on panel"],
  ["warning", "card", 4.5, "warning text on panel"],
  ["danger", "card", 4.5, "danger text on panel"],
  ["info", "card", 4.5, "info text on panel"],
  ["input", "card", 1.45, "input border on panel (non-text)"],
];

let failures = 0;
for (const [theme, t] of [["dark", dark], ["light", light]]) {
  console.log(`\n${theme}`);
  for (const [fg, bg, min, label] of PAIRS) {
    if (!t[fg] || !t[bg]) {
      console.log(`  MISSING  --ap-${fg} or --ap-${bg}`);
      failures++;
      continue;
    }
    const surface = flatten(t[bg], t.background);
    const ink = flatten(t[fg], formatHex(surface));
    const ratio = wcagContrast(ink, surface);
    const ok = ratio >= min;
    if (!ok) failures++;
    console.log(
      `  ${ok ? "pass" : "FAIL"}  ${ratio.toFixed(2).padStart(5)} ≥ ${String(min).padEnd(4)} ${label}  (${fg} on ${bg})`,
    );
  }
}

if (failures) {
  console.error(`\n${failures} contrast check(s) failed. Adjust src/styles/tokens.css.`);
  process.exit(1);
}
console.log("\nAll contrast checks pass.");
