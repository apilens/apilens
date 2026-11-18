import { describe, expect, it } from "vitest";
import { compare } from "./compare";

describe("compare (#1000)", () => {
  it("writes a rate change in percentage points, up being bad for errors", () => {
    expect(compare(0.25, 0.126, { kind: "rate", better: "down", range: "24h" })).toEqual({ text: "▲ 12.4 pts vs previous 24h", tone: "bad" });
    expect(compare(0.02, 0.05, { kind: "rate", better: "down", range: "1h" })).toEqual({ text: "▼ 3.0 pts vs previous 1h", tone: "good" });
  });

  it("writes a latency change relative to the previous value, up being bad", () => {
    expect(compare(240, 200, { kind: "relative", better: "down", range: "6h" })).toEqual({ text: "▲ 20.0% vs previous 6h", tone: "bad" });
    expect(compare(150, 200, { kind: "relative", better: "down", range: "6h" })).toEqual({ text: "▼ 25.0% vs previous 6h", tone: "good" });
  });

  it("colours a score up as good and requests as neither", () => {
    expect(compare(0.95, 0.9, { kind: "score", better: "up", range: "7d" })).toEqual({ text: "▲ 0.05 vs previous 7d", tone: "good" });
    expect(compare(1200, 1000, { kind: "relative", better: "neither", range: "24h" })).toEqual({ text: "▲ 20.0% vs previous 24h", tone: "neutral" });
  });

  it("says no change when the rounded change is zero", () => {
    expect(compare(0.1001, 0.1, { kind: "rate", better: "down", range: "24h" })).toEqual({ text: "No change vs previous 24h", tone: "flat" });
  });

  it("is null without a previous value to compare with", () => {
    expect(compare(0.1, undefined, { kind: "rate", better: "down", range: "24h" })).toBeNull();
    expect(compare(0.9, null, { kind: "score", better: "up", range: "24h" })).toBeNull();
    expect(compare(120, 0, { kind: "relative", better: "down", range: "24h" })).toBeNull();
  });
});
