import { describe, expect, it } from "vitest";
import { appHealth, appHref, formatLastSeen, needsAttention, reportingTone, sdkUpdate, sdkVersions } from "./apps";

const NOW = Date.parse("2026-11-05T12:00:00Z");
const ago = (s: number) => new Date(NOW - s * 1000).toISOString();
const sdk = (versions: string[] | null, latest: string, outdated: number) => ({ name: "apilens-python", versions, latest_version: latest, outdated_instances: outdated });

describe("appHref", () => {
  it("encodes the project and the app", () => {
    expect(appHref("shop", "checkout-api")).toBe("/shop/apps/checkout-api");
    expect(appHref("a b", "c/d")).toBe("/a%20b/apps/c%2Fd");
  });
});

describe("formatLastSeen", () => {
  it("says how long ago the last heartbeat arrived", () => {
    expect(formatLastSeen(ago(12), NOW)).toBe("Last seen just now");
    expect(formatLastSeen(ago(4 * 60 + 30), NOW)).toBe("Last seen 4 min ago");
    expect(formatLastSeen(ago(3 * 3600 + 5), NOW)).toBe("Last seen 3 h ago");
    expect(formatLastSeen(ago(26 * 3600), NOW)).toBe("Last seen 1 day ago");
    expect(formatLastSeen(ago(9 * 86400), NOW)).toBe("Last seen 9 days ago");
  });

  it("says when none arrived", () => {
    expect(formatLastSeen(null, NOW)).toBe("No heartbeat yet");
    expect(formatLastSeen("not a date", NOW)).toBe("No heartbeat yet");
  });

  it("treats a heartbeat from a clock ahead as just now", () => {
    expect(formatLastSeen(ago(-30), NOW)).toBe("Last seen just now");
  });
});

describe("reportingTone", () => {
  it("maps each state to a tone", () => {
    expect(["reporting", "stale", "silent", "never"].map((s) => reportingTone(s as "reporting"))).toEqual(["ok", "warn", "error", "none"]);
  });
});

describe("appHealth", () => {
  it("rates by the share of 5xx", () => {
    expect(appHealth({ requests: 0, server_errors: 0 })).toBe("idle");
    expect(appHealth({ requests: 1000, server_errors: 9 })).toBe("healthy");
    expect(appHealth({ requests: 1000, server_errors: 10 })).toBe("degraded");
    expect(appHealth({ requests: 1000, server_errors: 50 })).toBe("failing");
  });
});

describe("SDK versions", () => {
  it("names the versions in use", () => {
    expect(sdkVersions(sdk(["0.4.0"], "0.4.0", 0))).toBe("apilens-python 0.4.0");
    expect(sdkVersions(sdk(["0.3.2", "0.3.9", "0.4.0"], "0.4.0", 2))).toBe("apilens-python 0.3.2 to 0.4.0");
    expect(sdkVersions(sdk(null, "0.4.0", 0))).toBe("apilens-python");
  });

  it("hints at an update only when an instance runs behind a known release", () => {
    expect(sdkUpdate(sdk(["0.3.2"], "0.4.0", 1))).toBe("Update available: 0.4.0 (1 instance behind)");
    expect(sdkUpdate(sdk(["0.3.2", "0.4.0"], "0.4.0", 3))).toBe("Update available: 0.4.0 (3 instances behind)");
    expect(sdkUpdate(sdk(["0.4.0"], "0.4.0", 0))).toBeNull();
    expect(sdkUpdate(sdk(["1.0.0"], "", 0))).toBeNull();
  });
});

describe("needsAttention", () => {
  it("flags stale and silent apps and outdated SDKs", () => {
    expect(needsAttention({ status: "reporting", sdks: [sdk(["0.4.0"], "0.4.0", 0)] })).toBe(false);
    expect(needsAttention({ status: "never", sdks: null })).toBe(false);
    expect(needsAttention({ status: "stale", sdks: null })).toBe(true);
    expect(needsAttention({ status: "silent", sdks: [] })).toBe(true);
    expect(needsAttention({ status: "reporting", sdks: [sdk(["0.3.2"], "0.4.0", 1)] })).toBe(true);
  });
});
