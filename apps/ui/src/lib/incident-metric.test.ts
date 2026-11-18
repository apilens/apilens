import { describe, expect, it } from "vitest";
import type { TrafficPoint } from "./identity";
import { chartRange, hasSeries, incidentBands, metricValues, noSeriesText, plotSpan, seriesLabel } from "./incident-metric";

const NOW = Date.parse("2026-11-16T12:00:00Z");
const pt = (ts: string, requests: number, client_errors: number, server_errors: number, p95_ms: number): TrafficPoint => ({ ts, requests, client_errors, server_errors, p95_ms });
const POINTS = [pt("2026-11-16T11:00:00Z", 100, 4, 6, 120), pt("2026-11-16T11:15:00Z", 0, 0, 0, 0), pt("2026-11-16T11:30:00Z", 50, 0, 25, 900)];

describe("chartRange", () => {
  it("reads 6 h, or 24 h when the newest incident started before them", () => {
    expect(chartRange(undefined, NOW)).toBe("6h");
    expect(chartRange("2026-11-16T08:00:00Z", NOW)).toBe("6h");
    expect(chartRange("2026-11-16T05:59:00Z", NOW)).toBe("24h");
    expect(chartRange("not a time", NOW)).toBe("6h");
  });
});

describe("metricValues", () => {
  it("reads errors, error rate, p95 and traffic off each bucket", () => {
    // 15 min buckets against a 15 min window: counts as they are.
    expect(metricValues("traffic", POINTS, 900, 900)).toEqual([100, 0, 50]);
    expect(metricValues("errors", POINTS, 900, 900)).toEqual([10, 0, 25]);
    expect(metricValues("server_errors", POINTS, 900, 900)).toEqual([6, 0, 25]);
    expect(metricValues("client_errors", POINTS, 900, 900)).toEqual([4, 0, 0]);
    // Rates divide by the bucket's requests; a bucket without requests is 0, never NaN.
    expect(metricValues("error_rate", POINTS, 900, 300)).toEqual([0.1, 0, 0.5]);
    expect(metricValues("server_error_rate", POINTS, 900, 300)).toEqual([0.06, 0, 0.5]);
    expect(metricValues("client_error_rate", POINTS, 900, 300)).toEqual([0.04, 0, 0]);
    expect(metricValues("p95", POINTS, 900, 300)).toEqual([120, 0, 900]);
  });

  it("scales counts from the bucket to the rule's window", () => {
    expect(metricValues("errors", POINTS, 900, 300)?.map((v) => Math.round(v * 100) / 100)).toEqual([3.33, 0, 8.33]);
    expect(metricValues("traffic", POINTS, 300, 3600)).toEqual([1200, 0, 600]);
  });

  it("is null for metrics the series does not carry", () => {
    for (const m of ["p50", "p75", "apdex", "unique_consumers"] as const) {
      expect(hasSeries(m)).toBe(false);
      expect(metricValues(m, POINTS, 900, 300)).toBeNull();
    }
    expect(hasSeries("p95")).toBe(true);
    expect(noSeriesText("apdex")).toMatch(/^Apdex has no series over time yet/);
  });
});

describe("seriesLabel", () => {
  it("names the window counts are over", () => {
    expect(seriesLabel({ metric: "errors", window_s: 300 })).toBe("Errors (4xx + 5xx) per 5 min");
    expect(seriesLabel({ metric: "error_rate", window_s: 300 })).toBe("Error rate (4xx + 5xx)");
    expect(seriesLabel({ metric: "p95", window_s: 300 })).toBe("p95 response time");
  });
});

describe("plotSpan and incidentBands", () => {
  it("spans the first bucket's start to the last bucket's end", () => {
    expect(plotSpan(POINTS, 900)).toEqual({ from: Date.parse("2026-11-16T11:00:00Z"), to: Date.parse("2026-11-16T11:45:00Z") });
    expect(plotSpan([], 900)).toBeNull();
  });

  it("shades each incident from start to end (or now), clipped, oldest first", () => {
    const from = Date.parse("2026-11-16T10:00:00Z");
    const to = NOW;
    const bands = incidentBands(
      [
        { id: "open", started_at: "2026-11-16T11:30:00Z", ended_at: null },
        { id: "done", started_at: "2026-11-16T10:30:00Z", ended_at: "2026-11-16T11:00:00Z" },
        { id: "clipped", started_at: "2026-11-16T09:00:00Z", ended_at: "2026-11-16T10:30:00Z" },
        { id: "before", started_at: "2026-11-16T08:00:00Z", ended_at: "2026-11-16T09:00:00Z" },
      ],
      from,
      to,
      NOW,
    );
    expect(bands).toEqual([
      { id: "clipped", from: 0, to: 0.25, open: false },
      { id: "done", from: 0.25, to: 0.5, open: false },
      { id: "open", from: 0.75, to: 1, open: true },
    ]);
    expect(incidentBands([{ id: "x", started_at: "2026-11-16T11:00:00Z", ended_at: null }], to, from, NOW)).toEqual([]);
  });
});
