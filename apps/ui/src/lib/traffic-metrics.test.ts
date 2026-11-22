import { describe, expect, it } from "vitest";
import type { EndpointTraffic } from "./identity";
import { meetsMetrics, metricParam, metricText, parseMetricInput, parseMetricParams } from "./traffic-metrics";

const ep = (o: Partial<EndpointTraffic>): EndpointTraffic =>
  ({ app_id: "", method: "GET", path: "/x", requests: 1000, client_errors: 30, server_errors: 5, error_rate: 0.035, p50_ms: 40, p95_ms: 520, apdex: 0.9, ...o }) as EndpointTraffic;

describe("parseMetricInput", () => {
  it("reads an operator (> when left out) and a number", () => {
    expect(parseMetricInput("client_errors", "> 10")).toEqual({ field: "client_errors", op: "gt", value: 10, pct: false });
    expect(parseMetricInput("server_errors", "=0")).toEqual({ field: "server_errors", op: "eq", value: 0, pct: false });
    expect(parseMetricInput("client_errors", "25")).toEqual({ field: "client_errors", op: "gt", value: 25, pct: false });
  });
  it("takes a share with % for 4xx and 5xx, never above 100", () => {
    expect(parseMetricInput("client_errors", "< 2.5%")).toEqual({ field: "client_errors", op: "lt", value: 2.5, pct: true });
    expect(parseMetricInput("server_errors", ">101%")).toBeNull();
  });
  it("reads latency in ms by default, or s", () => {
    expect(parseMetricInput("p95", ">500")).toEqual({ field: "p95", op: "gt", value: 500, pct: false });
    expect(parseMetricInput("p95", "> 1.5s")).toEqual({ field: "p95", op: "gt", value: 1500, pct: false });
    expect(parseMetricInput("p50", "<80 ms")).toEqual({ field: "p50", op: "lt", value: 80, pct: false });
  });
  it("reads requests as a count only", () => {
    expect(parseMetricInput("requests", "> 1000")).toEqual({ field: "requests", op: "gt", value: 1000, pct: false });
    expect(parseMetricInput("requests", "< 2%")).toBeNull();
    expect(parseMetricInput("requests", "> 5ms")).toBeNull();
  });
  it("refuses units that don't fit the field, and anything else", () => {
    expect(parseMetricInput("p95", "> 5%")).toBeNull();
    expect(parseMetricInput("client_errors", "> 5ms")).toBeNull();
    expect(parseMetricInput("p95", ">= 5")).toBeNull();
    expect(parseMetricInput("p95", "fast")).toBeNull();
    expect(parseMetricInput("p95", "")).toBeNull();
  });
});

describe("URL form", () => {
  it("round-trips through ?m=", () => {
    const conds = [parseMetricInput("p95", "> 1.5s"), parseMetricInput("client_errors", "< 2%"), parseMetricInput("server_errors", "= 0")].flatMap((c) => (c ? [c] : []));
    expect(parseMetricParams(conds.map(metricParam))).toEqual([conds[1], conds[2], conds[0]]);
  });
  it("drops unknown or malformed values, and keeps the last per field", () => {
    expect(parseMetricParams(["p99:gt:5", "p95:ge:5", "p95:gt:", "p95:gt:abc", "p95:gt:100", "p95:lt:900"])).toEqual([{ field: "p95", op: "lt", value: 900, pct: false }]);
    expect(parseMetricParams(undefined)).toEqual([]);
    expect(parseMetricParams("server_errors:eq:0")).toEqual([{ field: "server_errors", op: "eq", value: 0, pct: false }]);
  });
  it("says a condition in words", () => {
    expect(metricText({ field: "p95", op: "gt", value: 1500, pct: false })).toBe("p95 > 1.5 s");
    expect(metricText({ field: "p50", op: "lt", value: 80, pct: false })).toBe("p50 < 80 ms");
    expect(metricText({ field: "client_errors", op: "gt", value: 2, pct: true })).toBe("4xx > 2%");
    expect(metricText({ field: "server_errors", op: "eq", value: 0, pct: false })).toBe("5xx = 0");
  });
});

describe("meetsMetrics", () => {
  it("compares counts, shares and latencies", () => {
    const e = ep({});
    expect(meetsMetrics(e, [{ field: "client_errors", op: "gt", value: 20, pct: false }])).toBe(true);
    expect(meetsMetrics(e, [{ field: "client_errors", op: "gt", value: 3, pct: true }])).toBe(false);
    expect(meetsMetrics(e, [{ field: "client_errors", op: "eq", value: 3, pct: true }])).toBe(true);
    expect(meetsMetrics(e, [{ field: "server_errors", op: "eq", value: 5, pct: false }])).toBe(true);
    expect(meetsMetrics(e, [{ field: "p95", op: "lt", value: 500, pct: false }])).toBe(false);
    expect(meetsMetrics(e, [{ field: "p50", op: "lt", value: 50, pct: false }])).toBe(true);
    expect(meetsMetrics(e, [{ field: "requests", op: "gt", value: 999, pct: false }])).toBe(true);
    expect(meetsMetrics(e, [{ field: "requests", op: "lt", value: 1000, pct: false }])).toBe(false);
    expect(meetsMetrics(e, [{ field: "requests", op: "eq", value: 1000, pct: false }])).toBe(true);
  });
  it("needs every condition, and reads an endpoint without requests as a 0% share", () => {
    const e = ep({});
    expect(meetsMetrics(e, [])).toBe(true);
    expect(
      meetsMetrics(e, [
        { field: "p95", op: "gt", value: 500, pct: false },
        { field: "server_errors", op: "gt", value: 10, pct: false },
      ]),
    ).toBe(false);
    expect(meetsMetrics(ep({ requests: 0, client_errors: 0 }), [{ field: "client_errors", op: "eq", value: 0, pct: true }])).toBe(true);
  });
});
