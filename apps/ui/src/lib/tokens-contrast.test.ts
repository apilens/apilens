// Contrast of the status tokens in design/tokens.json (#999): `ok` is a green, not the indigo
// accent, and reads at 4.5:1 or better on every ground it sits on, in both themes.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type Token = { name: string; value: string | Record<string, string> };
const tokens = (JSON.parse(readFileSync(new URL("../../design/tokens.json", import.meta.url), "utf8")) as { color: { tokens: Token[] } }).color.tokens;

const get = (name: string, theme: "dark" | "light"): string => {
  const t = tokens.find((k) => k.name === name);
  if (!t) throw new Error(`no token ${name}`);
  return typeof t.value === "string" ? t.value : t.value[theme];
};

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
const luminance = (hex: string) => {
  const [r, g, b] = rgb(hex).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

describe.each(["dark", "light"] as const)("%s theme", (theme) => {
  it.each(["bg", "surface-1", "surface-2", "ok-soft"])("ok text reads at 4.5:1 or better on %s", (ground) => {
    expect(contrast(get("ok", theme), get(ground, theme))).toBeGreaterThanOrEqual(4.5);
  });

  it("ok is green, not the accent", () => {
    const [r, g, b] = rgb(get("ok", theme));
    expect(g).toBeGreaterThan(r);
    expect(g).toBeGreaterThan(b);
    expect(get("ok", theme)).not.toBe(get("accent-ink", theme));
  });

  it("muted text on a disabled primary button (surface-2) reads at 4.5:1 or better", () => {
    expect(contrast(get("ink-muted", theme), get("surface-2", theme))).toBeGreaterThanOrEqual(4.5);
  });
});
