import { describe, expect, it } from "vitest";
import type { EndpointTraffic } from "./identity";
import {
  APDEX_BANDS,
  apdexBandAt,
  apdexBandRange,
  apdexExplanation,
  apdexPosition,
  byTimeSpent,
  checkThreshold,
  checkThresholdDraft,
  endpointLatencyHref,
  formatTimeSpent,
  parsePerformanceQuery,
  perfScopeText,
  performanceHref,
  slowRequestHref,
  thresholdDraft,
  thresholdError,
} from "./performance";

const BILLING = "8a2d3b4c-5e6f-4a71-9bac-1d2e3f4a5b6c";

describe("performance URL state", () => {
  it("reads range, env and app, falling back to the defaults", () => {
    expect(parsePerformanceQuery({})).toEqual({ range: "24h", env: "", app: "" });
    // The app is an app id (#976), lower-cased; a slug or anything else means all apps.
    expect(parsePerformanceQuery({ range: "1h", env: " production ", app: ` ${BILLING.toUpperCase()} ` })).toEqual({ range: "1h", env: "production", app: BILLING });
    expect(parsePerformanceQuery({ range: "30d", env: "x".repeat(65), app: "billing" })).toEqual({ range: "24h", env: "", app: "" });
  });

  it("builds the page URL leaving defaults out", () => {
    expect(performanceHref("shop", { range: "24h", env: "", app: "" })).toBe("/shop/performance?range=24h&env=all");
    expect(performanceHref("shop", { range: "7d", env: "prod eu", app: BILLING })).toBe(`/shop/performance?range=7d&env=prod+eu&app=${BILLING}`);
  });

  it("opens an endpoint's Response times tab keeping the scope", () => {
    const q = { range: "24h" as const, env: "", app: "" };
    expect(endpointLatencyHref("shop", { method: "post", path: "/charge" }, q)).toBe("/shop/endpoints/POST/%2Fcharge?range=24h&env=all&tab=latency");
    expect(endpointLatencyHref("shop", { method: "GET", path: "/orders/{id}" }, { ...q, range: "1h", env: "production" })).toBe(
      "/shop/endpoints/GET/%2Forders%2F%7Bid%7D?range=1h&env=production&tab=latency",
    );
    // A row is one app's endpoint (#976): its link opens scoped to that app.
    expect(endpointLatencyHref("shop", { app_id: BILLING, method: "GET", path: "/charge" }, q)).toBe(`/shop/endpoints/GET/%2Fcharge?range=24h&env=all&app=${BILLING}&tab=latency`);
  });

  it("puts the scope in words", () => {
    expect(perfScopeText({ range: "6h", env: "", app: "" })).toBe("the last 6 hours");
    expect(perfScopeText({ range: "1h", env: "production", app: "" })).toBe("the last 1 hour in production");
    expect(perfScopeText({ range: "1h", env: "production", app: BILLING }, "Billing")).toBe("the last 1 hour in production for Billing");
  });
});

describe("byTimeSpent (#1001)", () => {
  const ep = (path: string, total: number, requests = 10): EndpointTraffic => ({
    app_id: "a1",
    method: "GET",
    path,
    requests,
    client_errors: 0,
    server_errors: 0,
    error_rate: 0,
    p50_ms: 1,
    p95_ms: 1,
    total_time_ms: total,
    apdex: requests ? 1 : null,
  });

  it("ranks by requests × average, most first, and leaves out routes without traffic", () => {
    const list = [ep("/a", 100), ep("/b", 600), ep("/idle", 0, 0), ep("/c", 100, 50), ep("/d", 200, 4)];
    const rows = byTimeSpent(list);
    expect(rows.map((r) => r.endpoint.path)).toEqual(["/b", "/d", "/c", "/a"]);
    expect(rows.map((r) => r.avgMs)).toEqual([60, 50, 2, 10]);
    expect(rows.map((r) => r.share)).toEqual([0.6, 0.2, 0.1, 0.1]);
    expect(list.map((e) => e.path)).toEqual(["/a", "/b", "/idle", "/c", "/d"]);
  });

  it("keeps the first `limit`, their share still of every endpoint's time", () => {
    const rows = byTimeSpent([ep("/a", 300), ep("/b", 100)], 1);
    expect(rows).toHaveLength(1);
    expect(rows[0].share).toBe(0.75);
    expect(byTimeSpent([ep("/old", 0)])).toEqual([]);
  });
});

describe("formatTimeSpent", () => {
  it("reads in ms, s, minutes or hours", () => {
    expect(formatTimeSpent(840)).toBe("840 ms");
    expect(formatTimeSpent(12_400)).toBe("12.4 s");
    expect(formatTimeSpent(210_000)).toBe("3.5 min");
    expect(formatTimeSpent(7_560_000)).toBe("2.1 h");
  });
});

describe("slowRequestHref (#1001)", () => {
  const r = { id: "abc_1", environment: "production", method: "post", path: "/charge", response_time_ms: 2310.7 };
  it("opens Explore on the request: its environment, endpoint and response time or slower", () => {
    expect(slowRequestHref("shop", r, { range: "24h" })).toBe(
      "/shop/explore?range=24h&env=production&method=POST&path=%2Fcharge&latency_min=2310&request=abc_1",
    );
    expect(slowRequestHref("shop", { ...r, id: undefined, environment: "" }, { range: "1h" })).toBe("/shop/explore?method=POST&path=%2Fcharge&latency_min=2310");
  });
});

describe("apdex gauge", () => {
  it("places a score on the gauge", () => {
    expect(apdexPosition(0.625)).toBe(62.5);
    expect(apdexPosition(1.2)).toBe(100);
    expect(apdexPosition(-1)).toBe(0);
    expect(apdexPosition(null)).toBeNull();
    expect(apdexPosition(Number.NaN)).toBeNull();
  });

  it("covers 0 to 1 with the standard bands", () => {
    expect(APDEX_BANDS[0].from).toBe(0);
    expect(APDEX_BANDS[APDEX_BANDS.length - 1].to).toBe(1);
    for (let i = 1; i < APDEX_BANDS.length; i++) expect(APDEX_BANDS[i].from).toBe(APDEX_BANDS[i - 1].to);
  });

  it("explains the formula and where T comes from", () => {
    expect(apdexExplanation()).toContain("Apdex = (satisfied + tolerating / 2) / requests.");
    expect(apdexExplanation().join(" ")).toMatch(/server error \(5xx\)/);
    expect(apdexExplanation(null).at(-1)).toBe("T is the endpoint’s own threshold, else its app’s, else 500 ms.");
    expect(apdexExplanation({ name: "Billing", thresholdMs: 250 }).at(-1)).toBe("T is the endpoint’s own threshold, else its app’s (Billing: 250 ms), else 500 ms.");
  });
});

describe("app threshold input", () => {
  it("shows the saved threshold, empty for the default", () => {
    expect(thresholdDraft({ latency_threshold_ms: 250 })).toBe("250");
    expect(thresholdDraft({ latency_threshold_ms: null })).toBe("");
    expect(thresholdDraft(null)).toBe("");
  });

  it("takes whole milliseconds from 1 to 600,000, or empty for the default", () => {
    expect(checkThresholdDraft(" 250 ")).toEqual({ ok: true, threshold: 250 });
    expect(checkThresholdDraft("")).toEqual({ ok: true, threshold: null });
    expect(checkThresholdDraft("600000")).toEqual({ ok: true, threshold: 600_000 });
    for (const bad of ["0", "600001", "1.5", "1s", "-5"]) {
      expect(checkThresholdDraft(bad)).toMatchObject({ ok: false, error: expect.stringContaining("from 1 to 600,000") });
    }
  });

  it("re-checks what reaches the Server Action", () => {
    expect(checkThreshold(250)).toEqual({ ok: true, threshold: 250 });
    expect(checkThreshold(null)).toEqual({ ok: true, threshold: null });
    for (const bad of [0, 600_001, 2.5, "250", undefined, {}]) expect(checkThreshold(bad)).toEqual({ ok: false });
  });

  it("answers a sentence per API error", () => {
    expect(thresholdError("forbidden")).toBe("Only project admins can change the response time threshold.");
    expect(thresholdError("timeout")).toMatch(/couldn’t reach APILens/);
    expect(thresholdError("weird")).toBe("Something went wrong. Try again in a moment.");
  });
});

describe("Apdex gauge hover", () => {
  it("finds the band under a point of the gauge, a band's upper edge belonging to the next", () => {
    expect(apdexBandAt(0).label).toBe("Unacceptable");
    expect(apdexBandAt(0.49).label).toBe("Unacceptable");
    expect(apdexBandAt(0.5).label).toBe("Poor");
    expect(apdexBandAt(0.7).label).toBe("Fair");
    expect(apdexBandAt(0.85).label).toBe("Good");
    expect(apdexBandAt(0.94).label).toBe("Excellent");
    expect(apdexBandAt(1).label).toBe("Excellent");
  });
  it("clamps what is off the gauge", () => {
    expect(apdexBandAt(-1).label).toBe("Unacceptable");
    expect(apdexBandAt(3).label).toBe("Excellent");
    expect(apdexBandAt(Number.NaN).label).toBe("Unacceptable");
  });
  it("writes a band's span with two decimals", () => {
    expect(apdexBandRange(APDEX_BANDS[3])).toBe("0.85–0.94");
    expect(apdexBandRange(APDEX_BANDS[0])).toBe("0.00–0.50");
  });
});
