import { describe, expect, it } from "vitest";
import { METRICS, checkRuleDraft, draftSummary, draftThreshold, newRuleDraft, withMetric } from "./alerts";
import type { TrafficPoint } from "./identity";
import { breachCount, breachText, breachedBuckets, closestEnvironment, environmentWarning, hasPreview, previewValues } from "./rule-preview";

const pt = (requests: number, client_errors = 0, server_errors = 0, p95_ms = 0): TrafficPoint => ({ ts: "2026-11-16T00:00:00Z", requests, client_errors, server_errors, p95_ms });

describe("metric defaults (#982)", () => {
  it("gives every metric a default condition and threshold", () => {
    const by = Object.fromEntries(METRICS.map((m) => [m.value, `${m.defaultCondition} ${m.defaultThreshold}`]));
    expect(by.errors).toBe("gt 10");
    expect(by.server_error_rate).toBe("gt 0.05");
    expect(by.p95).toBe("gt 1000");
    expect(by.apdex).toBe("lt 0.85");
    expect(by.traffic).toBe("lt 1");
    for (const m of METRICS) expect(checkRuleDraft(withMetric({ ...newRuleDraft("a", "production"), name: "x" }, m.value, false)).ok).toBe(true);
  });

  it("applies the defaults on a metric change until the threshold is touched", () => {
    const d = newRuleDraft("a", "production");
    expect([d.metric, d.condition, d.threshold]).toEqual(["error_rate", "gt", "5"]);
    const p95 = withMetric(d, "p95", false);
    expect([p95.metric, p95.condition, p95.threshold]).toEqual(["p95", "gt", "1000"]);
    const apdex = withMetric(p95, "apdex", false);
    expect([apdex.condition, apdex.threshold]).toEqual(["lt", "0.85"]);
    expect(withMetric(d, "server_error_rate", false).threshold).toBe("5");
    // Touched: only the metric changes.
    const typed = { ...d, threshold: "2", condition: "gte" as const };
    expect(withMetric(typed, "p95", true)).toEqual({ ...typed, metric: "p95" });
  });

  it("reads the draft threshold in API units and summarises the draft", () => {
    expect(draftThreshold({ metric: "error_rate", threshold: "5" })).toBe(0.05);
    expect(draftThreshold({ metric: "p95", threshold: "800" })).toBe(800);
    expect(draftThreshold({ metric: "p95", threshold: "abc" })).toBeNull();
    expect(draftSummary(newRuleDraft())).toBe("Error rate (4xx + 5xx) > 5.0% over 5 min");
    expect(draftSummary(withMetric(newRuleDraft(), "p95", false))).toBe("p95 response time > 1 s over 5 min");
    expect(draftSummary({ ...newRuleDraft(), threshold: "" })).toBe("");
  });
});

describe("preview", () => {
  it("charts only the metrics the timeseries carries", () => {
    expect(hasPreview("error_rate")).toBe(true);
    expect(hasPreview("p95")).toBe(true);
    expect(hasPreview("apdex")).toBe(false);
    expect(hasPreview("unique_consumers")).toBe(false);
  });

  it("reads rates per bucket and scales counts to the window", () => {
    const points = [pt(100, 3, 2, 420), pt(0)];
    expect(previewValues("error_rate", points, 1800, 300)).toEqual([0.05, null]);
    expect(previewValues("server_error_rate", points, 1800, 300)).toEqual([0.02, null]);
    expect(previewValues("p95", points, 1800, 300)).toEqual([420, null]);
    // 30 min buckets against a 5 min window: a sixth of the bucket.
    expect(previewValues("errors", [pt(600, 30, 30)], 1800, 300)).toEqual([10]);
    expect(previewValues("traffic", [pt(600), pt(0)], 1800, 300)).toEqual([100, 0]);
    expect(previewValues("apdex", points, 1800, 300)).toEqual([]);
  });

  it("counts each run of breaching buckets once", () => {
    const flags = breachedBuckets([0.01, 0.2, 0.3, null, 0.02, 0.5], "gt", 0.05);
    expect(flags).toEqual([false, true, true, false, false, true]);
    expect(breachCount(flags)).toBe(2);
    expect(breachCount(breachedBuckets([1, 1], "gte", 1))).toBe(1);
    expect(breachCount(breachedBuckets([0, 2], "lt", 1))).toBe(1);
    expect(breachText(0)).toBe("Would not have breached in the last 24 hours");
    expect(breachText(1)).toBe("Would have breached once in the last 24 hours");
    expect(breachText(3)).toBe("Would have breached 3 times in the last 24 hours");
  });
});

describe("environment typo", () => {
  it("warns about an environment no traffic was seen from, with the closest known one", () => {
    expect(environmentWarning("prodution", ["production", "staging"])).toBe("No traffic seen from prodution; did you mean production?");
    expect(environmentWarning("stagng", ["production", "staging"])).toBe("No traffic seen from stagng; did you mean staging?");
    expect(environmentWarning("production", ["production"])).toBeNull();
    expect(environmentWarning("", ["production"])).toBeNull();
    expect(environmentWarning("anything", [])).toBeNull();
    expect(closestEnvironment("qa", ["dev", "production"])).toBe("dev");
  });
});
