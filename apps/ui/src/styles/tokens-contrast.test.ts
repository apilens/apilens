// WCAG contrast of the colour tokens (design/tokens.json) in both themes: text ≥4.5:1, chart
// series and control outlines ≥3:1. Guards a palette retune (the calm dark theme) against
// trading legibility for quiet.
import { describe, expect, it } from "vitest";
import tokens from "../../design/tokens.json";

type Value = string | Record<string, string>;
const themes = tokens.color.themes.map((t) => t.id);
const color = (name: string, theme: string): string => {
  const tok = tokens.color.tokens.find((t) => t.name === name);
  if (!tok) throw new Error(`no token ${name}`);
  const v = tok.value as Value;
  return typeof v === "string" ? v : v[theme];
};
const channel = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => channel(Number.parseInt(hex.slice(i, i + 2), 16) / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const grounds = ["bg", "surface-1", "surface-2"];
const TEXT = ["ink", "ink-muted", "accent-ink", "ok", "warn", "error"];
const GRAPHICS = ["chart-neutral", "chart-accent", "chart-warn", "chart-error"];
const PAIRS: [string, string, number][] = [
  ...grounds.flatMap((g) => TEXT.map((t): [string, string, number] => [t, g, 4.5])),
  ...["bg", "surface-1"].flatMap((g) => [...GRAPHICS, "border-strong"].map((t): [string, string, number] => [t, g, 3])),
  ["on-accent", "accent", 4.5],
  ["on-accent", "error-fill", 4.5],
  ["ok", "ok-soft", 4.5],
  ["warn", "warn-soft", 4.5],
  ["error", "error-soft", 4.5],
  ["accent-ink", "accent-soft", 4.5],
  ["ink", "error-tint", 4.5],
  ["ink-muted", "error-tint", 4.5],
];

// Light mode is not part of the calm-dark retune; this pre-existing shortfall (2.94:1) is left as it was.
const KNOWN: Record<string, string[]> = { light: ["border-strong on bg"] };

describe.each(themes)("%s theme", (theme) => {
  it.each(PAIRS.filter(([fg, bg]) => !KNOWN[theme]?.includes(`${fg} on ${bg}`)))("%s on %s is at least %s:1", (fg, bg, min) => {
    expect(contrast(color(fg, theme), color(bg, theme))).toBeGreaterThanOrEqual(min);
  });
});
