import { describe, expect, it } from "vitest";
import { attemptsLabel, checkHealthCheckInput, formatLatency, healthCheckError, healthChecksPath, probeOutcome } from "./health-checks";

const PROBE = { ok: false, status_code: 503, expected_status: 200, latency_ms: 41.2, attempts: 2, checked_at: "2026-11-05T10:00:00Z" };

describe("checkHealthCheckInput", () => {
  it("trims and defaults the expected status to 200", () => {
    expect(checkHealthCheckInput({ app_id: " a1 ", environment: " production ", url: " https://api.example.com/healthz " })).toEqual({
      ok: true,
      body: { app_id: "a1", environment: "production", url: "https://api.example.com/healthz", expected_status: 200 },
    });
    expect(checkHealthCheckInput({ app_id: "a1", environment: "staging", url: "http://api.example.com/", expected_status: "204" })).toMatchObject({
      ok: true,
      body: { expected_status: 204 },
    });
  });

  it.each([
    [{ environment: "production", url: "https://api.example.com/" }, "app_id"],
    [{ app_id: "a1", environment: " ", url: "https://api.example.com/" }, "environment"],
    [{ app_id: "a1", environment: "production", url: "" }, "url"],
    [{ app_id: "a1", environment: "production", url: "api.example.com/health" }, "url"],
    [{ app_id: "a1", environment: "production", url: "ftp://api.example.com/" }, "url"],
    [{ app_id: "a1", environment: "production", url: "https://a:b@api.example.com/" }, "url"],
    [{ app_id: "a1", environment: "production", url: "https://api.example.com/#top" }, "url"],
    [{ app_id: "a1", environment: "production", url: "https://api.example.com/", expected_status: 99 }, "expected_status"],
    [{ app_id: "a1", environment: "production", url: "https://api.example.com/", expected_status: "2xx" }, "expected_status"],
    [null, "app_id"],
  ])("refuses %j on %s", (input, field) => {
    expect(checkHealthCheckInput(input)).toMatchObject({ ok: false, field });
  });
});

describe("labels", () => {
  it("says what a probe got", () => {
    expect(probeOutcome(PROBE)).toBe("HTTP 503, expected 200");
    expect(probeOutcome({ ...PROBE, status_code: 0, error: "timeout" })).toBe("Timeout");
    expect(probeOutcome({ ...PROBE, status_code: 0 })).toBe("No response");
    expect(probeOutcome({ ...PROBE, ok: true, status_code: 200 })).toBe("Passing (HTTP 200)");
  });

  it("formats latency and attempts", () => {
    expect(formatLatency(41.2)).toBe("41 ms");
    expect(formatLatency(1234)).toBe("1.2 s");
    expect(formatLatency(5000)).toBe("5 s");
    expect(attemptsLabel(2)).toBe("2 (retried once)");
    expect(attemptsLabel(1)).toBe("1 (not retried)");
  });

  it("answers a sentence per API error", () => {
    expect(healthCheckError("validation_failed", "url must point to a public address")).toBe("Not accepted: url must point to a public address.");
    expect(healthCheckError("forbidden")).toMatch(/project admins/);
    expect(healthCheckError("whatever")).toMatch(/Something went wrong/);
  });

  it("builds the section path", () => {
    expect(healthChecksPath("shop")).toBe("/shop/settings/health-checks");
  });
});
