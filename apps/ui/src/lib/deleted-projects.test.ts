import { describe, expect, it } from "vitest";
import { agoText, inText, restoreError } from "./deleted-projects";

const NOW = Date.parse("2026-11-13T12:00:00Z");
const at = (ms: number) => new Date(NOW + ms).toISOString();
const H = 3_600_000;

describe("agoText", () => {
  it("counts back in minutes, hours, then days", () => {
    expect(agoText(at(-20_000), NOW)).toBe("just now");
    expect(agoText(at(-60_000), NOW)).toBe("1 minute ago");
    expect(agoText(at(-25 * 60_000), NOW)).toBe("25 minutes ago");
    expect(agoText(at(-3 * H), NOW)).toBe("3 hours ago");
    expect(agoText(at(-24 * H), NOW)).toBe("1 day ago");
    expect(agoText(at(-50 * H), NOW)).toBe("2 days ago");
  });

  it("is empty for a value that is not a date", () => {
    expect(agoText("soon", NOW)).toBe("");
  });
});

describe("inText", () => {
  it("counts forward to the purge", () => {
    expect(inText(at(5 * 24 * H), NOW)).toBe("in 5 days");
    expect(inText(at(1 * H), NOW)).toBe("in 1 hour");
    expect(inText(at(10 * 60_000), NOW)).toBe("in 10 minutes");
    expect(inText(at(30_000), NOW)).toBe("in a minute or less");
    expect(inText(at(-H), NOW)).toBe("in a minute or less");
    expect(inText("", NOW)).toBe("");
  });
});

describe("restoreError", () => {
  it("explains the API's codes in a sentence", () => {
    expect(restoreError("not_found")).toMatch(/can’t be restored any more/);
    expect(restoreError("forbidden")).toBe("Only organization owners and admins can restore projects.");
    expect(restoreError("authz_unavailable")).toMatch(/Try again in a moment/);
    expect(restoreError(undefined)).toBe("Couldn’t restore the project. Try again in a moment.");
  });
});
