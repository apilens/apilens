import { describe, expect, it } from "vitest";
import { errorRateDelta, exploreHref, formatRate, minutesSoFar, p95Delta, shortCommit, sideP95, sideRate } from "./changes";

const side = (requests: number, error_rate: number, p95_ms: number) => ({ requests, error_rate, p95_ms });

describe("errorRateDelta", () => {
  it("calls a rise of half a point or more worse and a drop better", () => {
    expect(errorRateDelta(side(100, 0.01, 0), side(100, 0.034, 0))).toEqual({ tone: "worse", text: "+2.4 pp" });
    expect(errorRateDelta(side(100, 0.05, 0), side(100, 0.01, 0))).toEqual({ tone: "better", text: "−4.0 pp" });
  });

  it("calls smaller moves flat", () => {
    expect(errorRateDelta(side(100, 0.01, 0), side(100, 0.012, 0))).toEqual({ tone: "flat", text: "+0.2 pp" });
    expect(errorRateDelta(side(100, 0.01, 0), side(100, 0.01, 0))).toEqual({ tone: "flat", text: "±0.0 pp" });
  });

  it("compares nothing when a side has no traffic", () => {
    expect(errorRateDelta(side(0, 0, 0), side(100, 0.5, 0))).toEqual({ tone: "none", text: "" });
    expect(errorRateDelta(side(100, 0, 0), side(0, 0, 0))).toEqual({ tone: "none", text: "" });
  });
});

describe("p95Delta", () => {
  it("needs both 10% and 5 ms to call a move", () => {
    expect(p95Delta(side(10, 0, 120), side(10, 0, 168))).toEqual({ tone: "worse", text: "+48 ms (+40%)" });
    expect(p95Delta(side(10, 0, 200), side(10, 0, 150))).toEqual({ tone: "better", text: "−50 ms (−25%)" });
    // 50% slower but only 2 ms: flat.
    expect(p95Delta(side(10, 0, 4), side(10, 0, 6)).tone).toBe("flat");
    // 6 ms slower but only 3%: flat.
    expect(p95Delta(side(10, 0, 200), side(10, 0, 206)).tone).toBe("flat");
  });

  it("compares nothing without traffic or a before p95", () => {
    expect(p95Delta(side(0, 0, 0), side(10, 0, 100)).tone).toBe("none");
    expect(p95Delta(side(10, 0, 0), side(10, 0, 100)).tone).toBe("none");
  });
});

describe("formatting", () => {
  it("formats rates and sides", () => {
    expect(formatRate(0)).toBe("0%");
    expect(formatRate(0.0004)).toBe("<0.1%");
    expect(formatRate(0.0237)).toBe("2.4%");
    expect(sideRate(side(0, 0, 0))).toBe("–");
    expect(sideRate(side(5, 0.2, 0))).toBe("20.0%");
    expect(sideP95(side(0, 0, 0))).toBe("–");
    expect(sideP95(side(5, 0, 0.4))).toBe("<1 ms");
    expect(sideP95(side(5, 0, 312.6))).toBe("313 ms");
    expect(sideP95(side(5, 0, 1530))).toBe("1.53 s");
  });

  it("shortens SHAs only", () => {
    expect(shortCommit("4bf92f3577b34da6a3ce")).toBe("4bf92f3");
    expect(shortCommit("main@42")).toBe("main@42");
    expect(shortCommit("")).toBe("");
  });

  it("links to Explore filtered by release and environment", () => {
    expect(exploreHref("shop", { release: "v2.4.0+build 7", environment: "production" })).toBe("/shop/explore?release=v2.4.0%2Bbuild+7&env=production");
    expect(exploreHref("shop", { release: "v1", environment: "" })).toBe("/shop/explore?release=v1");
  });

  it("counts the after window's elapsed minutes", () => {
    const deployed = "2026-11-05T10:37:20Z";
    expect(minutesSoFar(deployed, Date.parse("2026-11-05T10:37:50Z"))).toBe(0);
    expect(minutesSoFar(deployed, Date.parse("2026-11-05T10:58:10Z"))).toBe(20);
    expect(minutesSoFar("nope", 0)).toBe(0);
  });
});
