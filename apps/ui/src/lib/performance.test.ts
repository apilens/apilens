import { describe, expect, it } from "vitest";
import type { EndpointTraffic } from "./identity";
import {
  APDEX_BANDS,
  apdexBandAt,
  apdexBandRange,
  apdexExplanation,
  apdexPosition,
  byP95,
  checkThreshold,
  checkThresholdDraft,
  endpointLatencyHref,
  parsePerformanceQuery,
  perfScopeText,
  performanceHref,
  thresholdDraft,
  thresholdError,
} from "./performance";

describe("performance URL state", () => {
  it("reads range, env and app, falling back to the defaults", () => {
    expect(parsePerformanceQuery({})).toEqual({ range: "24h", env: "", app: "" });
    expect(parsePerformanceQuery({ range: "1h", env: " production ", app: "billing" })).toEqual({ range: "1h", env: "production", app: "billing" });
    expect(parsePerformanceQuery({ range: "30d", env: "x".repeat(65), app: ["a", "b"] })).toEqual({ range: "24h", env: "", app: "a" });
  });

  it("builds the page URL leaving defaults out", () => {
    expect(performanceHref("shop", { range: "24h", env: "", app: "" })).toBe("/shop/performance");
    expect(performanceHref("shop", { range: "7d", env: "prod eu", app: "billing" })).toBe("/shop/performance?range=7d&env=prod+eu&app=billing");
  });

  it("opens an endpoint's Response times tab keeping the scope", () => {
    const q = { range: "24h" as const, env: "", app: "" };
    expect(endpointLatencyHref("shop", { method: "post", path: "/charge" }, q)).toBe("/shop/endpoints/POST/%2Fcharge?tab=latency");
    expect(endpointLatencyHref("shop", { method: "GET", path: "/orders/{id}" }, { ...q, range: "1h", env: "production" })).toBe(
      "/shop/endpoints/GET/%2Forders%2F%7Bid%7D?range=1h&env=production&tab=latency",
    );
  });

  it("puts the scope in words", () => {
    expect(perfScopeText({ range: "6h", env: "", app: "" })).toBe("the last 6 hours");
    expect(perfScopeText({ range: "1h", env: "production", app: "" })).toBe("the last 1 hour in production");
  });
});

describe("byP95", () => {
  const ep = (path: string, p95: number, requests = 10): EndpointTraffic => ({
    method: "GET",
    path,
    requests,
    client_errors: 0,
    server_errors: 0,
    error_rate: 0,
    p50_ms: 1,
    p95_ms: p95,
    apdex: requests ? 1 : null,
  });

  it("ranks the slowest p95 first and leaves out routes without traffic", () => {
    const list = [ep("/a", 20), ep("/b", 900), ep("/idle", 0, 0), ep("/c", 20, 50), ep("/d", 20, 50)];
    expect(byP95(list).map((e) => e.path)).toEqual(["/b", "/c", "/d", "/a"]);
    expect(list.map((e) => e.path)).toEqual(["/a", "/b", "/idle", "/c", "/d"]);
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
