import { describe, expect, it } from "vitest";
import {
  deployHref,
  errorRateDelta,
  exploreHref,
  formatDeployTime,
  minuteOffsetText,
  p95LinePath,
  p95Scale,
  formatRate,
  minutesSoFar,
  p95Delta,
  parseChangesFilter,
  rangeCovering,
  reportLag,
  shortCommit,
  sideP95,
  sideRate,
  splitEndpoints,
  verdict,
  windowText,
} from "./changes";
import type { DeployEndpoint } from "./identity";

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

  it("links to Explore over one side of the deploy, in its environment", () => {
    const d = { deployed_at: "2026-11-05T10:37:20Z", environment: "production" };
    const now = Date.parse("2026-11-05T12:00:00Z");
    expect(exploreHref("shop", d, now)).toBe("/shop/explore?range=6h&from=2026-11-05T10%3A38%3A00Z&to=2026-11-05T11%3A38%3A00Z&env=production");
    expect(exploreHref("shop", d, now, "before")).toBe("/shop/explore?range=6h&from=2026-11-05T09%3A37%3A00Z&to=2026-11-05T10%3A37%3A00Z&env=production");
    // An open after window ends with the current minute.
    const soon = Date.parse("2026-11-05T10:50:30Z");
    expect(exploreHref("shop", { ...d, environment: "" }, soon)).toBe("/shop/explore?range=1h&from=2026-11-05T10%3A38%3A00Z&to=2026-11-05T10%3A51%3A00Z");
  });

  it("picks the smallest range that reaches back far enough", () => {
    const now = Date.parse("2026-11-05T12:00:00Z");
    expect(rangeCovering(now - 30 * 60_000, now)).toBe("1h");
    expect(rangeCovering(now - 5 * 3600_000, now)).toBe("6h");
    expect(rangeCovering(now - 20 * 3600_000, now)).toBe("24h");
    expect(rangeCovering(now - 30 * 3600_000, now)).toBe("7d");
    expect(rangeCovering(now - 30 * 86400_000, now)).toBe("7d");
  });

  it("links to the deploy page", () => {
    expect(deployHref("shop", "9f3a1b2c")).toBe("/shop/changes/9f3a1b2c");
  });

  it("formats the deploy time and how late the report came", () => {
    expect(formatDeployTime("2026-11-05T10:37:20Z")).toBe("Nov 5, 10:37:20 UTC");
    expect(formatDeployTime("nope")).toBe("");
    expect(reportLag("2026-11-05T10:37:20Z", "2026-11-05T10:37:21Z")).toBe("");
    expect(reportLag("2026-11-05T10:37:20Z", "2026-11-05T10:38:00Z")).toBe("40 s later");
    expect(reportLag("2026-11-05T10:37:20Z", "2026-11-05T11:07:20Z")).toBe("30 min later");
  });

  it("counts the after window's elapsed minutes", () => {
    const deployed = "2026-11-05T10:37:20Z";
    expect(minutesSoFar(deployed, Date.parse("2026-11-05T10:37:50Z"))).toBe(0);
    expect(minutesSoFar(deployed, Date.parse("2026-11-05T10:58:10Z"))).toBe(20);
    expect(minutesSoFar("nope", 0)).toBe(0);
  });
});

describe("parseChangesFilter", () => {
  it("keeps a UUID app and a short environment", () => {
    expect(parseChangesFilter({ app: "0E6C53B2-6C55-4B8A-9C4B-2C9E2C2C2C2C", env: "production" })).toEqual({ app: "0e6c53b2-6c55-4b8a-9c4b-2c9e2c2c2c2c", env: "production" });
    expect(parseChangesFilter({ app: "storefront", env: "x".repeat(65) })).toEqual({ app: "", env: "" });
    expect(parseChangesFilter({})).toEqual({ app: "", env: "" });
  });
});

describe("verdict", () => {
  it("refuses to call it with too little traffic, and says how much there was", () => {
    const v = verdict(side(500, 0.01, 100), side(12, 0.5, 900), true);
    expect(v.tone).toBe("insufficient");
    expect(v.headline).toBe("Not enough traffic to compare yet");
    expect(v.detail).toBe("500 requests before, 12 after so far. A verdict needs at least 20 on each side.");
    expect(verdict(side(1, 0, 10), side(300, 0, 10), false).detail).toMatch(/^1 request before, 300 after\./);
  });

  it("calls it worse when either metric got worse", () => {
    expect(verdict(side(100, 0.01, 100), side(100, 0.05, 100), false)).toMatchObject({ tone: "worse", detail: "Error rate went up." });
    expect(verdict(side(100, 0.05, 100), side(100, 0.01, 200), false)).toMatchObject({ tone: "worse", detail: "p95 latency went up." });
  });

  it("calls it better when one improved and none got worse, else no change", () => {
    expect(verdict(side(100, 0.05, 100), side(100, 0.01, 50), false)).toMatchObject({ tone: "better", detail: "Error rate and p95 latency went down." });
    expect(verdict(side(100, 0.01, 100), side(100, 0.012, 102), false).tone).toBe("flat");
  });
});

describe("windowText", () => {
  it("says how much of the after window there is", () => {
    expect(windowText(60, 60, false)).toBe("1 h before vs 1 h after");
    expect(windowText(60, 12, true)).toBe("1 h before vs the 12 min after so far");
    expect(windowText(60, 0, true)).toBe("1 h before; the after window has just opened");
  });
});

describe("splitEndpoints", () => {
  it("keeps the API order within compared, new and gone", () => {
    const ep = (path: string, change: DeployEndpoint["change"]) => ({ method: "GET", path, change }) as DeployEndpoint;
    const out = splitEndpoints([ep("/a", "compared"), ep("/n", "new"), ep("/b", "compared"), ep("/g", "gone")]);
    expect(out.compared.map((e) => e.path)).toEqual(["/a", "/b"]);
    expect(out.added.map((e) => e.path)).toEqual(["/n"]);
    expect(out.gone.map((e) => e.path)).toEqual(["/g"]);
  });
});

describe("chart helpers", () => {
  it("places a minute relative to the deploy", () => {
    const m = "2026-11-05T10:37:00Z";
    expect(minuteOffsetText("2026-11-05T10:37:00Z", m)).toBe("Deploy minute");
    expect(minuteOffsetText("2026-11-05T10:25:00Z", m)).toBe("12 min before");
    expect(minuteOffsetText("2026-11-05T10:42:00Z", m)).toBe("5 min after");
  });

  it("draws the p95 line through slot centres, broken where there was no traffic", () => {
    expect(p95LinePath([10, 20, 0, 5], [true, true, false, true], 40, 12, 20)).toBe("M5 6 L15 1 M35 8.5 l0.01 0");
    expect(p95LinePath([0, 0], [false, false], 40, 12, 1)).toBe("");
    expect(p95LinePath([], [], 40, 12, 1)).toBe("");
  });

  it("scales p95 to the busy minutes and counts the sparse ones above it", () => {
    const pt = (requests: number, p95_ms: number) => ({ requests, p95_ms });
    expect(p95Scale([pt(45, 534), pt(2, 50_959), pt(100, 6), pt(0, 0)])).toEqual({ max: 534, offScale: 1 });
    expect(p95Scale([pt(1, 30), pt(2, 90)])).toEqual({ max: 90, offScale: 0 });
    expect(p95Scale([pt(0, 0)])).toEqual({ max: 0, offScale: 0 });
  });
});
