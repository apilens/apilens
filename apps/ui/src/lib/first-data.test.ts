import { describe, expect, it } from "vitest";
import {
  endpointCount,
  firstData,
  formatAgo,
  formatCount,
  formatMs,
  loadFirstData,
  shownPath,
  statusTone,
} from "./first-data";
import type { RequestRow, TrafficSummary } from "./identity";

const row = (i: number, extra: Partial<RequestRow> = {}): RequestRow => ({
  timestamp: `2026-11-04T12:00:${String(59 - i).padStart(2, "0")}Z`,
  method: "GET",
  path: "/orders/{id}",
  raw_path: `/orders/${i}`,
  status_code: 200,
  response_time_ms: 12.4,
  environment: "production",
  consumer_id: "",
  consumer_name: "",
  trace_id: `t${i}`,
  ...extra,
});

const summary = (extra: Partial<TrafficSummary> = {}): TrafficSummary => ({
  range: "7d",
  from: "2026-10-28T13:00:00Z",
  to: "2026-11-04T13:00:00Z",
  requests: 42,
  client_errors: 1,
  server_errors: 0,
  error_rate: 1 / 42,
  p50_ms: 10,
  p95_ms: 38.6,
  p99_ms: 80,
  requests_per_minute: 0.004,
  ...extra,
});

const endpoint = (path: string) => ({ method: "GET", path, requests: 1, client_errors: 0, server_errors: 0, error_rate: 0, p50_ms: 1, p95_ms: 1 });

describe("firstData", () => {
  it("combines the latest rows, the totals and the endpoint count", () => {
    const rows = Array.from({ length: 12 }, (_, i) => row(i));
    const d = firstData({ requests: rows }, summary(), { endpoints: [endpoint("/a"), endpoint("/b")] });
    expect(d.requests).toHaveLength(10);
    expect(d.requests[0].trace_id).toBe("t0");
    expect(d).toMatchObject({ total: 42, endpoints: 2, p95Ms: 38.6 });
  });

  it("reads null lists as empty and has no p95 without requests", () => {
    expect(firstData({ requests: null }, summary({ requests: 0, p95_ms: 0 }), { endpoints: null })).toEqual({
      requests: [],
      total: 0,
      endpoints: 0,
      p95Ms: null,
    });
  });

  it("never counts fewer requests than the rows it shows (the rollups can lag the raw rows)", () => {
    expect(firstData({ requests: [row(0), row(1)] }, summary({ requests: 0 }), { endpoints: [] }).total).toBe(2);
  });
});

describe("loadFirstData", () => {
  it("loads the three answers together", async () => {
    const d = await loadFirstData({
      requests: async () => ({ requests: [row(0)] }),
      summary: async () => summary({ requests: 1 }),
      endpoints: async () => ({ endpoints: [endpoint("/a")] }),
    });
    expect(d).toMatchObject({ total: 1, endpoints: 1 });
  });

  it("fails when any of them fails", async () => {
    const boom = new Error("unavailable");
    await expect(
      loadFirstData({
        requests: async () => ({ requests: [] }),
        summary: async () => {
          throw boom;
        },
        endpoints: async () => ({ endpoints: [] }),
      }),
    ).rejects.toBe(boom);
  });
});

describe("formatting", () => {
  it("formats latencies", () => {
    expect(formatMs(null)).toBe("–");
    expect(formatMs(0.4)).toBe("<1 ms");
    expect(formatMs(38.6)).toBe("39 ms");
    expect(formatMs(1240)).toBe("1.24 s");
    expect(formatMs(Number.NaN)).toBe("–");
  });

  it("formats counts and caps the endpoint count", () => {
    expect(formatCount(12345)).toBe("12,345");
    expect(endpointCount(3)).toBe("3");
    expect(endpointCount(500)).toBe("500+");
  });

  it("says how long ago a request was", () => {
    const now = Date.parse("2026-11-04T12:00:00Z");
    expect(formatAgo("2026-11-04T11:59:58Z", now)).toBe("just now");
    expect(formatAgo("2026-11-04T11:59:18Z", now)).toBe("42s ago");
    expect(formatAgo("2026-11-04T11:57:00Z", now)).toBe("3m ago");
    expect(formatAgo("2026-11-04T10:00:00Z", now)).toBe("2h ago");
    expect(formatAgo("2026-10-31T12:00:00Z", now)).toBe("4d ago");
    // A clock a little ahead of ours is still "just now".
    expect(formatAgo("2026-11-04T12:00:03Z", now)).toBe("just now");
    expect(formatAgo("not a date", now)).toBe("");
  });

  it("tones status codes", () => {
    expect(statusTone(200)).toBe("ok");
    expect(statusTone(304)).toBe("ok");
    expect(statusTone(404)).toBe("warn");
    expect(statusTone(503)).toBe("error");
  });

  it("shows the URL as requested, else the route template", () => {
    expect(shownPath({ path: "/orders/{id}", raw_path: "/orders/42" })).toBe("/orders/42");
    expect(shownPath({ path: "/orders/{id}", raw_path: "" })).toBe("/orders/{id}");
  });
});
