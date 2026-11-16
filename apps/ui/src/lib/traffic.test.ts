import { describe, expect, it } from "vitest";
import {
  apdexRating,
  endpointHref,
  formatApdex,
  formatLatency,
  latencyTop,
  lineY,
  linePath,
  parseTrafficQuery,
  plotWidth,
  scopeText,
  statusRows,
  trafficHref,
} from "./traffic";

describe("parseTrafficQuery", () => {
  it("defaults to the last 24 hours in all environments", () => {
    expect(parseTrafficQuery({})).toEqual({ range: "24h", env: "" });
  });

  it("reads a known range and an environment", () => {
    expect(parseTrafficQuery({ range: "7d", env: "production" })).toEqual({ range: "7d", env: "production" });
    expect(parseTrafficQuery({ range: ["1h", "7d"], env: [" staging "] })).toEqual({ range: "1h", env: "staging" });
  });

  it("falls back on an unknown range or an environment name the API would refuse", () => {
    expect(parseTrafficQuery({ range: "30d", env: "x".repeat(65) })).toEqual({ range: "24h", env: "" });
  });
});

describe("trafficHref and endpointHref", () => {
  it("leaves defaults out of the URL", () => {
    expect(trafficHref("shop", { range: "24h", env: "" })).toBe("/shop/traffic");
    expect(trafficHref("shop", { range: "1h", env: "production" })).toBe("/shop/traffic?range=1h&env=production");
  });

  it("links an endpoint's detail with the path as one segment, keeping the scope", () => {
    expect(endpointHref("shop", { method: "get", path: "/orders/{id}" }, { range: "24h", env: "" })).toBe("/shop/endpoints/GET/%2Forders%2F%7Bid%7D");
    expect(endpointHref("shop", { method: "POST", path: "/charge" }, { range: "7d", env: "staging" })).toBe("/shop/endpoints/POST/%2Fcharge?range=7d&env=staging");
  });

  it("says the scope in words", () => {
    expect(scopeText({ range: "1h", env: "" })).toBe("the last 1 hour");
    expect(scopeText({ range: "7d", env: "production" })).toBe("the last 7 days in production");
  });
});

describe("formatting", () => {
  it("formats latencies in ms and seconds", () => {
    expect(formatLatency(0)).toBe("0 ms");
    expect(formatLatency(0.4)).toBe("<1 ms");
    expect(formatLatency(42.4)).toBe("42 ms");
    expect(formatLatency(999.7)).toBe("1.00 s");
    expect(formatLatency(1240)).toBe("1.24 s");
    expect(formatLatency(12_500)).toBe("12.5 s");
  });

  it("formats Apdex with two decimals and rates it", () => {
    expect(formatApdex(0.9412)).toBe("0.94");
    expect(formatApdex(1)).toBe("1.00");
    expect(formatApdex(null)).toBe("n/a");
    expect(formatApdex(undefined)).toBe("n/a");
    expect([0.97, 0.9, 0.75, 0.6, 0.2].map(apdexRating)).toEqual(["Excellent", "Good", "Fair", "Poor", "Unacceptable"]);
    expect(apdexRating(null)).toBeNull();
  });
});

describe("chart helpers", () => {
  it("splits each bucket into successful, 4xx and 5xx", () => {
    expect(statusRows([{ ts: "t", requests: 100, client_errors: 7, server_errors: 3, p95_ms: 12 }])).toEqual([
      { ts: "t", successful: 90, client_errors: 7, server_errors: 3 },
    ]);
  });

  it("uses a measured width only when it is a real one (no width(-1) race)", () => {
    expect(plotWidth(null)).toBeNull();
    expect(plotWidth(undefined)).toBeNull();
    expect(plotWidth(-1)).toBeNull();
    expect(plotWidth(0)).toBeNull();
    expect(plotWidth(Number.NaN)).toBeNull();
    expect(plotWidth(612.4)).toBe(612);
  });

  it("draws a line through the centre of each bucket against the axis top", () => {
    expect(linePath([], 100, 10, 10)).toBe("");
    expect(linePath([0, 5, 10], 300, 100, 10)).toBe("M50,100L150,50L250,0");
    // Values above the top are clamped to it; a zero top draws along the baseline.
    expect(linePath([20], 100, 100, 10)).toBe("M50,0");
    expect(linePath([0, 0], 100, 100, 0)).toBe("M25,100L75,100");
  });

  it("puts a hovered point's dot where the line is drawn", () => {
    expect(lineY(0, 100, 10)).toBe(100);
    expect(lineY(5, 100, 10)).toBe(50);
    expect(lineY(10, 100, 10)).toBe(0);
    // Clamped like the line: above the top, below zero, not a number, a zero top.
    expect(lineY(20, 100, 10)).toBe(0);
    expect(lineY(-3, 100, 10)).toBe(100);
    expect(lineY(Number.NaN, 100, 10)).toBe(100);
    expect(lineY(0, 100, 0)).toBe(100);
  });

  it("rounds the latency axis up", () => {
    expect(latencyTop([120, 380, 90])).toBe(500);
    expect(latencyTop([])).toBe(1);
  });
});
