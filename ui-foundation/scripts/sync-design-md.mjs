#!/usr/bin/env node
// Regenerates the YAML front matter of DESIGN.md (Google Labs DESIGN.md
// format, alpha) from src/styles/tokens.css, so the agent-readable token file
// can never drift from the CSS that ships. The prose below the front matter
// is hand-written and preserved.
//
//   pnpm design:sync           rewrite the front matter
//   pnpm design:sync --check   exit 1 if DESIGN.md is stale (CI)

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parse, formatHex, formatHex8 } from "culori";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(path.join(root, "src/styles/tokens.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const dark = css.match(/:root,\s*\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/)[1];
const vars = Object.fromEntries([...dark.matchAll(/--ap-([a-z0-9-]+)\s*:\s*([^;]+);/g)].map(([, k, v]) => [k, v.trim()]));

const hex = (name) => {
  const c = parse(vars[name]);
  if (!c) throw new Error(`--ap-${name} missing or unparseable`);
  return (c.alpha ?? 1) < 1 ? formatHex8(c) : formatHex(c);
};

// DESIGN.md has one theme; it documents the primary (dark) one. Light values
// live in tokens.css and are contrast-checked by pnpm ui:contrast.
const COLORS = [
  ["primary", "brand"],
  ["on-primary", "brand-foreground"],
  ["background", "background"],
  ["surface", "card"],
  ["surface-raised", "popover"],
  ["surface-hover", "muted"],
  ["surface-selected", "accent"],
  ["field", "field"],
  ["on-surface", "foreground"],
  ["on-surface-secondary", "muted-foreground"],
  ["on-surface-tertiary", "subtle-foreground"],
  ["link", "brand-text"],
  ["border", "border"],
  ["border-input", "input"],
  ["action", "primary"],
  ["on-action", "primary-foreground"],
  ["destructive", "destructive"],
  ["on-destructive", "destructive-foreground"],
  ["success", "success"],
  ["warning", "warning"],
  ["danger", "danger"],
  ["info", "info"],
];

const yaml = `---
version: alpha
name: Aperture
description: APILens product UI. Dark-first, dense, calm developer tooling with a single teal signal color.
colors:
${COLORS.map(([k, v]) => `  ${k}: "${hex(v)}"`).join("\n")}
typography:
  hero-figure:
    fontFamily: IBM Plex Sans
    fontSize: 32px
    fontWeight: 600
    lineHeight: 40px
    letterSpacing: -0.02em
  stat-value:
    fontFamily: IBM Plex Sans
    fontSize: 24px
    fontWeight: 600
    lineHeight: 32px
    letterSpacing: -0.015em
  page-title:
    fontFamily: IBM Plex Sans
    fontSize: 20px
    fontWeight: 600
    lineHeight: 28px
    letterSpacing: -0.01em
  section-title:
    fontFamily: IBM Plex Sans
    fontSize: 16px
    fontWeight: 500
    lineHeight: 24px
  body:
    fontFamily: IBM Plex Sans
    fontSize: 14px
    fontWeight: 400
    lineHeight: 22px
  ui:
    fontFamily: IBM Plex Sans
    fontSize: 13px
    fontWeight: 400
    lineHeight: 20px
  ui-strong:
    fontFamily: IBM Plex Sans
    fontSize: 13px
    fontWeight: 500
    lineHeight: 20px
  caption:
    fontFamily: IBM Plex Sans
    fontSize: 12px
    fontWeight: 400
    lineHeight: 16px
  micro:
    fontFamily: IBM Plex Sans
    fontSize: 11px
    fontWeight: 500
    lineHeight: 16px
  code:
    fontFamily: IBM Plex Mono
    fontSize: 12px
    fontWeight: 400
    lineHeight: 16px
rounded:
  sm: 4px
  md: 6px
  lg: 8px
  xl: 10px
  full: 9999px
spacing:
  "1": 4px
  "2": 8px
  "3": 12px
  "4": 16px
  "6": 24px
  "8": 32px
components:
  page:
    backgroundColor: "{colors.background}"
    textColor: "{colors.on-surface}"
    typography: "{typography.ui}"
  panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.lg}"
    padding: 16px
  panel-description:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface-tertiary}"
    typography: "{typography.caption}"
  menu:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.lg}"
    padding: 4px
  table-row-hover:
    backgroundColor: "{colors.surface-hover}"
    textColor: "{colors.on-surface}"
    height: 36px
  table-row-selected:
    backgroundColor: "{colors.surface-selected}"
    textColor: "{colors.on-surface}"
    height: 36px
  table-header:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface-tertiary}"
    typography: "{typography.caption}"
    height: 32px
  secondary-text:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface-secondary}"
  input:
    backgroundColor: "{colors.field}"
    textColor: "{colors.on-surface}"
    typography: "{typography.ui}"
    rounded: "{rounded.md}"
    height: 32px
    padding: 10px
  input-border:
    backgroundColor: "{colors.border-input}"
  divider:
    backgroundColor: "{colors.border}"
  link:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.link}"
  button-primary:
    backgroundColor: "{colors.action}"
    textColor: "{colors.on-action}"
    typography: "{typography.ui-strong}"
    rounded: "{rounded.md}"
    height: 32px
    padding: 12px
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    typography: "{typography.ui-strong}"
    rounded: "{rounded.md}"
    height: 32px
    padding: 12px
  button-destructive:
    backgroundColor: "{colors.destructive}"
    textColor: "{colors.on-destructive}"
    typography: "{typography.ui-strong}"
    rounded: "{rounded.md}"
    height: 32px
    padding: 12px
  brand-fill:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
  badge:
    backgroundColor: "{colors.surface-hover}"
    textColor: "{colors.on-surface-secondary}"
    typography: "{typography.micro}"
    rounded: "{rounded.sm}"
    height: 20px
  status-success:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.success}"
  status-warning:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.warning}"
  status-danger:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.danger}"
  status-info:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.info}"
  stat-tile:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    typography: "{typography.stat-value}"
    padding: 16px
  hero:
    backgroundColor: "{colors.background}"
    textColor: "{colors.on-surface}"
    typography: "{typography.hero-figure}"
  page-heading:
    backgroundColor: "{colors.background}"
    textColor: "{colors.on-surface}"
    typography: "{typography.page-title}"
  dialog-title:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.on-surface}"
    typography: "{typography.section-title}"
    rounded: "{rounded.xl}"
  prose:
    backgroundColor: "{colors.background}"
    textColor: "{colors.on-surface-secondary}"
    typography: "{typography.body}"
  code:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    typography: "{typography.code}"
    rounded: "{rounded.sm}"
  avatar:
    rounded: "{rounded.full}"
---`;

const file = path.join(root, "DESIGN.md");
const current = readFileSync(file, "utf8");
const body = current.replace(/^---\n[\s\S]*?\n---/, "").replace(/^\n*/, "\n\n");
const next = yaml + body;

if (process.argv.includes("--check")) {
  if (next !== current) {
    console.error("DESIGN.md is out of date with src/styles/tokens.css. Run: pnpm design:sync");
    process.exit(1);
  }
  console.log("DESIGN.md is in sync with tokens.css.");
} else {
  writeFileSync(file, next);
  console.log("DESIGN.md front matter regenerated from tokens.css.");
}
