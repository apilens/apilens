import { describe, expect, it } from "vitest";
import {
  RETENTION_LIMITS,
  afterRetention,
  formatPeriod,
  isCustomized,
  longestRetention,
  rangeLabel,
  retentionDaysError,
  retentionDocsUrl,
  retentionError,
} from "./retention";

describe("afterRetention", () => {
  const defaults = [
    { key: "requests", period_days: 90 },
    { key: "rollups_1m", period_days: 30 },
    { key: "rollups_1h", period_days: 400 },
  ] as const;

  it("says the hourly metrics keep counts when they outlast the signal", () => {
    expect(afterRetention({ key: "requests", period_days: 90 }, defaults)).toMatch(/stay in the hourly metrics/);
    expect(afterRetention({ key: "rollups_1m", period_days: 30 }, defaults)).toMatch(/use the hourly metrics/);
  });

  it("does not promise hourly metrics that are kept for less", () => {
    const short = [{ key: "rollups_1h", period_days: 60 }] as const;
    expect(afterRetention({ key: "requests", period_days: 90 }, short)).toBe("Deleted with their headers and bodies.");
    expect(afterRetention({ key: "rollups_1m", period_days: 90 }, short)).toBe("Deleted.");
    expect(afterRetention({ key: "requests", period_days: 90 }, null)).toBe("Deleted with their headers and bodies.");
  });

  it("has a line for every signal", () => {
    for (const key of ["logs", "spans", "rollups_1h", "deploys"] as const) {
      expect(afterRetention({ key, period_days: 30 }, defaults)).toMatch(/^Deleted\. /);
    }
  });
});

describe("retentionDocsUrl", () => {
  it("links the self-host section of the data privacy page", () => {
    expect(retentionDocsUrl("https://apilens.ai/docs/")).toBe("https://apilens.ai/docs/getting-started/data-privacy#changing-retention-self-hosted");
  });
});

describe("RETENTION_LIMITS", () => {
  it("mirrors the install config (internal/platform/config/retention.go)", () => {
    expect(RETENTION_LIMITS).toEqual({
      requests: { default: 90, min: 1, max: 3650 },
      logs: { default: 30, min: 1, max: 3650 },
      spans: { default: 30, min: 1, max: 3650 },
      rollups_1m: { default: 30, min: 1, max: 400 },
      rollups_1h: { default: 400, min: 30, max: 3650 },
    });
  });
});

describe("retentionDaysError", () => {
  it("checks the range of a configurable signal", () => {
    expect(retentionDaysError("requests", 90)).toBeNull();
    expect(retentionDaysError("requests", 0)).toBe("Use 1 to 3650 days.");
    expect(retentionDaysError("rollups_1m", 401)).toBe("Use 1 to 400 days.");
    expect(retentionDaysError("rollups_1h", 29)).toBe("Use 30 to 3650 days.");
    expect(retentionDaysError("logs", 7.5)).toBe("Use 1 to 3650 days.");
  });

  it("refuses deploys, which are fixed", () => {
    expect(retentionDaysError("deploys", 400)).toMatch(/can’t be changed/);
  });
});

describe("labels", () => {
  it("formats periods in days or whole years", () => {
    expect(formatPeriod(1)).toBe("1 day");
    expect(formatPeriod(30)).toBe("30 days");
    expect(formatPeriod(400)).toBe("400 days");
    expect(formatPeriod(365)).toBe("1 year");
    expect(formatPeriod(3650)).toBe("10 years");
  });

  it("gives the range of a configurable signal only", () => {
    expect(rangeLabel({ key: "requests", configurable: true })).toBe("1 to 3650 days");
    expect(rangeLabel({ key: "deploys", configurable: false })).toBeNull();
  });

  it("tells a changed period from the default", () => {
    expect(isCustomized({ key: "requests", period_days: 90 })).toBe(false);
    expect(isCustomized({ key: "requests", period_days: 30 })).toBe(true);
    expect(isCustomized({ key: "deploys", period_days: 400 })).toBe(false);
  });

  it("finds the longest period", () => {
    expect(longestRetention([{ period_days: 30 }, { period_days: 400 }, { period_days: 90 }])).toBe(400);
    expect(longestRetention(null)).toBe(0);
  });

  it("has a sentence for a failed read", () => {
    expect(retentionError("not_found")).toMatch(/no longer exists/);
    expect(retentionError("unavailable")).toBe("Couldn’t load retention. Reload the page to try again.");
    expect(retentionError(undefined)).toMatch(/Reload the page/);
  });
});
