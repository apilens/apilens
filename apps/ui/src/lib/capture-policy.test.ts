import { describe, expect, it } from "vitest";
import {
  DEFAULT_POLICY,
  captureError,
  capturePath,
  checkDraft,
  checkPolicy,
  draftOf,
  effectiveRows,
  formatCap,
  formatRate,
  isAppId,
  percentText,
  policyValues,
  runtimeLine,
  samePolicy,
} from "./capture-policy";
import type { CapturePolicy } from "./identity";

const stored = (over: Partial<CapturePolicy> = {}): CapturePolicy => ({
  app_id: "7f1c2a3b-4d5e-4f60-8a9b-0c1d2e3f4a5b",
  app: "shop",
  project: "shop",
  ...DEFAULT_POLICY,
  updated_at: null,
  updated_by: null,
  ...over,
});

describe("capturePath", () => {
  it("names the app in the query", () => {
    expect(capturePath("shop")).toBe("/shop/settings/capture");
    expect(capturePath("shop", "checkout api")).toBe("/shop/settings/capture?app=checkout%20api");
  });
});

describe("draft round trip", () => {
  it("shows the rate in percent and the cap as text", () => {
    expect(draftOf({ ...DEFAULT_POLICY, sample_rate: 0.125, max_payload_bytes: 4096 })).toMatchObject({ percent: "12.5", cap: "4096" });
    expect(draftOf(DEFAULT_POLICY)).toMatchObject({ percent: "100", cap: "" });
    expect(percentText(0.0001)).toBe("0.01");
  });

  it("turns a valid draft into the API's body", () => {
    const d = { ...draftOf(DEFAULT_POLICY), percent: " 25 ", cap: "65536", capture_headers: false };
    expect(checkDraft(d)).toEqual({ ok: true, policy: { ...DEFAULT_POLICY, sample_rate: 0.25, capture_headers: false, max_payload_bytes: 65536 } });
    expect(checkDraft({ ...d, percent: "12.34" })).toMatchObject({ ok: true, policy: { sample_rate: 0.1234 } });
    expect(checkDraft({ ...d, percent: "0", cap: "" })).toMatchObject({ ok: true, policy: { sample_rate: 0, max_payload_bytes: null } });
  });

  it("refuses rates and caps the API would refuse", () => {
    const d = draftOf(DEFAULT_POLICY);
    for (const percent of ["", "101", "12.345", "-1", "abc", "1e2"]) {
      const r = checkDraft({ ...d, percent });
      expect(r.ok, percent).toBe(false);
      if (!r.ok) expect(r.errors.percent).toBeTruthy();
    }
    for (const cap of ["0", "1048577", "1.5", "-4", "12kb"]) {
      const r = checkDraft({ ...d, cap });
      expect(r.ok, cap).toBe(false);
      if (!r.ok) expect(r.errors.cap).toBeTruthy();
    }
    expect(checkDraft({ ...d, cap: "1048576" }).ok).toBe(true);
  });
});

describe("checkPolicy", () => {
  it("accepts what the form sends", () => {
    expect(checkPolicy({ ...DEFAULT_POLICY, sample_rate: 0.5, max_payload_bytes: 10 })).toEqual({ ok: true, policy: { ...DEFAULT_POLICY, sample_rate: 0.5, max_payload_bytes: 10 } });
    expect(checkPolicy({ ...DEFAULT_POLICY, max_payload_bytes: undefined })).toMatchObject({ ok: true, policy: { max_payload_bytes: null } });
  });

  it("refuses anything else", () => {
    for (const bad of [null, "x", { ...DEFAULT_POLICY, enabled: "yes" }, { ...DEFAULT_POLICY, sample_rate: 1.5 }, { ...DEFAULT_POLICY, sample_rate: 0.12345 }, { ...DEFAULT_POLICY, max_payload_bytes: 0 }, { ...DEFAULT_POLICY, max_payload_bytes: 2_000_000 }]) {
      expect(checkPolicy(bad).ok).toBe(false);
    }
  });
});

describe("samePolicy and policyValues", () => {
  it("compares only the saveable fields", () => {
    expect(samePolicy(policyValues(stored({ updated_at: "2026-11-01T00:00:00Z" })), DEFAULT_POLICY)).toBe(true);
    expect(samePolicy(policyValues(stored({ sample_rate: 0.5 })), DEFAULT_POLICY)).toBe(false);
  });
});

describe("formatting", () => {
  it("formats rates and caps", () => {
    expect(formatRate(0.25)).toBe("25%");
    expect(formatCap(null)).toBe("No cap");
    expect(formatCap(65536)).toBe("65,536 bytes (64 KiB)");
    expect(formatCap(1048576)).toBe("1,048,576 bytes (1 MiB)");
    expect(formatCap(1000)).toBe("1,000 bytes");
  });

  it("describes the runtime with what was reported", () => {
    expect(runtimeLine({ framework: "fastapi", framework_version: "0.115.0", runtime_version: "Python 3.12.4", sdk_version: "0.6.0" })).toBe("fastapi 0.115.0 · Python 3.12.4 · SDK 0.6.0");
    expect(runtimeLine({ framework: "", framework_version: "", runtime_version: "", sdk_version: "" })).toBe("");
  });
});

describe("effectiveRows", () => {
  it("applies the narrower of the policy and the SDK config", () => {
    const rows = effectiveRows(
      { ...DEFAULT_POLICY, sample_rate: 0.5, capture_request_body: false, max_payload_bytes: 8192 },
      { sample_rate: 0.25, capture_headers: false, capture_request_body: true, capture_response_body: true, max_payload_bytes: 65536 },
    );
    expect(rows.map((r) => [r.label, r.policy, r.sdk, r.effective, r.narrowedBySdk])).toEqual([
      ["Capture", "On", null, "On", false],
      ["Sample rate", "50%", "25%", "25%", true],
      ["Headers", "On", "Off", "Off", true],
      ["Request bodies", "Off", "On", "Off", false],
      ["Response bodies", "On", "On", "On", false],
      ["Body size cap", "8,192 bytes (8 KiB)", "65,536 bytes (64 KiB)", "8,192 bytes (8 KiB)", false],
    ]);
  });

  it("follows the policy for settings the SDK did not report, and the SDK's cap when the policy has none", () => {
    const rows = effectiveRows(DEFAULT_POLICY, { max_payload_bytes: "4096", sample_rate: "lots" });
    expect(rows.find((r) => r.label === "Sample rate")).toMatchObject({ sdk: null, effective: "100%" });
    expect(rows.find((r) => r.label === "Headers")).toMatchObject({ sdk: null, effective: "On" });
    expect(rows.find((r) => r.label === "Body size cap")).toMatchObject({ sdk: "4,096 bytes (4 KiB)", effective: "4,096 bytes (4 KiB)", narrowedBySdk: true });
  });

  it("is off everywhere when the policy turns capture off", () => {
    expect(effectiveRows({ ...DEFAULT_POLICY, enabled: false }, {})[0]).toMatchObject({ policy: "Off", effective: "Off" });
  });
});

describe("isAppId and captureError", () => {
  it("recognises app ids", () => {
    expect(isAppId("7f1c2a3b-4d5e-4f60-8a9b-0c1d2e3f4a5b")).toBe(true);
    expect(isAppId("shop")).toBe(false);
    expect(isAppId(undefined)).toBe(false);
  });

  it("explains each error code", () => {
    expect(captureError("forbidden")).toBe("Only project admins can change the capture policy.");
    expect(captureError("invalid_request")).toMatch(/sample rate/);
    expect(captureError("not_found")).toMatch(/no longer exists/);
    expect(captureError("unavailable")).toMatch(/couldn’t reach/);
    expect(captureError("weird")).toBe("Something went wrong. Try again in a moment.");
  });
});
