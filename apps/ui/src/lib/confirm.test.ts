import { describe, expect, it } from "vitest";
import { confirmMatches } from "./confirm";

describe("confirmMatches", () => {
  it("ignores surrounding whitespace on both sides", () => {
    expect(confirmMatches("acme", "  acme ")).toBe(true);
    expect(confirmMatches(" acme ", "acme")).toBe(true);
    expect(confirmMatches("acme", "acme\n")).toBe(true);
  });

  it("compares case exactly by default", () => {
    expect(confirmMatches("acme", "Acme")).toBe(false);
    expect(confirmMatches("Shop API", "shop api")).toBe(false);
    expect(confirmMatches("Shop API", "Shop API")).toBe(true);
  });

  it("ignores case only when asked", () => {
    expect(confirmMatches("you@example.com", " YOU@example.com ", { ignoreCase: true })).toBe(true);
    expect(confirmMatches("you@example.com", "you@example.co", { ignoreCase: true })).toBe(false);
  });

  it("keeps inner differences", () => {
    expect(confirmMatches("my-shop", "my shop")).toBe(false);
    expect(confirmMatches("acme", "acm")).toBe(false);
    expect(confirmMatches("acme", "acmee")).toBe(false);
  });

  it("never matches an empty expected value", () => {
    expect(confirmMatches("", "")).toBe(false);
    expect(confirmMatches("   ", "   ")).toBe(false);
    expect(confirmMatches("acme", "")).toBe(false);
  });
});
