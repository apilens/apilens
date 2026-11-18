import { describe, expect, it } from "vitest";
import {
  appHealth,
  appHref,
  appIsEmpty,
  attentionReasons,
  attentionText,
  formatLastSeen,
  instanceCountText,
  instanceRelease,
  instanceSdk,
  reportingTone,
  sdkUpdate,
  sdkVersions,
  sortBySeverity,
} from "./apps";

const NOW = Date.parse("2026-11-05T12:00:00Z");
const ago = (s: number) => new Date(NOW - s * 1000).toISOString();
const sdk = (versions: string[] | null, latest: string, outdated: number) => ({ name: "apilens-python", versions, latest_version: latest, outdated_instances: outdated });

describe("appHref", () => {
  it("encodes the project and the app", () => {
    expect(appHref("shop", "checkout-api")).toBe("/project/shop/apps/checkout-api");
    expect(appHref("a b", "c/d")).toBe("/project/a%20b/apps/c%2Fd");
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

describe("SDK instances of the last 24 hours", () => {
  const inst = (sdk_name: string, sdk_outdated: boolean, seconds: number) => ({ sdk_name, sdk_outdated, last_seen_at: ago(seconds) });

  it("counts only outdated instances seen in the last 24 hours when the server lists them", () => {
    const instances = [inst("apilens-python", true, 60), inst("apilens-python", true, 25 * 3600), inst("apilens-python", false, 60), inst("apilens-go", true, 60)];
    expect(sdkUpdate(sdk(["0.3.2", "0.4.0"], "0.4.0", 3), instances, NOW)).toBe("Update available: 0.4.0 (1 instance behind)");
    expect(sdkUpdate(sdk(["0.3.2"], "0.4.0", 1), [inst("apilens-python", true, 2 * 86400)], NOW)).toBeNull();
    // No instances listed (older servers): the server's count stands.
    expect(sdkUpdate(sdk(["0.3.2"], "0.4.0", 2), [], NOW)).toBe("Update available: 0.4.0 (2 instances behind)");
  });

  it("says how many instances ran in the last 24 hours", () => {
    expect(instanceCountText([inst("a", false, 60), inst("a", false, 3600), inst("a", false, 3 * 86400)], NOW)).toBe("2 instances in the last 24 h");
    expect(instanceCountText([inst("a", false, 60)], NOW)).toBe("1 instance in the last 24 h");
    expect(instanceCountText([inst("a", false, 3 * 86400)], NOW)).toBe("0 instances in the last 24 h");
    expect(instanceCountText(undefined, NOW)).toBeNull();
    expect(instanceCountText([], NOW)).toBeNull();
  });
});

describe("attention", () => {
  it("flags failing, degraded and not-reporting apps, nothing else", () => {
    expect(attentionReasons({ health: "healthy", reporting: "reporting" })).toEqual([]);
    expect(attentionReasons({ health: "idle", reporting: "never" })).toEqual([]);
    expect(attentionReasons({ health: null, reporting: null })).toEqual([]);
    expect(attentionReasons({ health: "failing", reporting: "reporting" })).toEqual(["failing"]);
    expect(attentionReasons({ health: "degraded", reporting: null })).toEqual(["degraded"]);
    expect(attentionReasons({ health: "idle", reporting: "silent" })).toEqual(["not-reporting"]);
    expect(attentionReasons({ health: "failing", reporting: "stale" })).toEqual(["failing", "not-reporting"]);
  });

  it("counts each app once and words the count per reason", () => {
    expect(attentionText([])).toBe("");
    expect(attentionText([{ health: "healthy", reporting: "reporting" }])).toBe("");
    expect(attentionText([{ health: "degraded", reporting: "reporting" }])).toBe("1 app needs attention: 1 degraded.");
    expect(
      attentionText([
        { health: "failing", reporting: "stale" },
        { health: "idle", reporting: "silent" },
        { health: "healthy", reporting: "reporting" },
      ]),
    ).toBe("2 apps need attention: 1 failing, 2 not reporting.");
    expect(
      attentionText([
        { health: "failing", reporting: "reporting" },
        { health: "failing", reporting: "reporting" },
        { health: "failing", reporting: "reporting" },
        { health: "degraded", reporting: "silent" },
      ]),
    ).toBe("4 apps need attention: 3 failing, 1 degraded, 1 not reporting.");
  });

  it("sorts worst first and keeps the order of equals", () => {
    const apps = [
      { name: "ok", health: "healthy", reporting: "reporting" },
      { name: "idle", health: "idle", reporting: "never" },
      { name: "silent", health: "idle", reporting: "silent" },
      { name: "degraded", health: "degraded", reporting: "reporting" },
      { name: "ok2", health: null, reporting: null },
      { name: "failing", health: "failing", reporting: "stale" },
      { name: "failing2", health: "failing", reporting: "reporting" },
    ] as const;
    expect(sortBySeverity([...apps], (a) => a).map((a) => a.name)).toEqual(["failing", "failing2", "degraded", "silent", "ok", "idle", "ok2"]);
  });
});

describe("appIsEmpty", () => {
  it("is empty only without requests and without a heartbeat ever", () => {
    expect(appIsEmpty({ requests: 0 }, { status: "never" })).toBe(true);
    expect(appIsEmpty({ requests: 3 }, { status: "never" })).toBe(false);
    expect(appIsEmpty({ requests: 0 }, { status: "silent" })).toBe(false);
  });

  it("is not empty when a read failed", () => {
    expect(appIsEmpty(null, { status: "never" })).toBe(false);
    expect(appIsEmpty({ requests: 0 }, null)).toBe(false);
  });
});

describe("instanceSdk and instanceRelease", () => {
  it("names the SDK and its version", () => {
    expect(instanceSdk({ sdk_name: "apilens-python", sdk_version: "0.4.0" })).toBe("apilens-python 0.4.0");
    expect(instanceSdk({ sdk_name: "apilens-python", sdk_version: "" })).toBe("apilens-python");
  });

  it("shows the release with a short commit, either alone, or nothing", () => {
    expect(instanceRelease({ release: "2026.11.05", commit: "3f9a2c1d5e6f" })).toBe("2026.11.05 (3f9a2c1)");
    expect(instanceRelease({ release: "", commit: "3f9a2c1d5e6f" })).toBe("3f9a2c1");
    expect(instanceRelease({ release: "v2", commit: "" })).toBe("v2");
    expect(instanceRelease({ release: "", commit: "" })).toBe("");
  });
});
