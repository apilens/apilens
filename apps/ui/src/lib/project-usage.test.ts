import { describe, expect, it } from "vitest";
import type { QuotaUsage, UsageDay } from "./identity";
import { quotaMeter, recordsLimitLine, rejectReasons, usageBars, usageSummary } from "./project-usage";

const day = (date: string, accepted: number, rejected = 0): UsageDay => ({
  date,
  accepted,
  rejected,
  truncated: 0,
  masked: 0,
  rejected_by_reason: [],
  bytes: 0,
});

const quota = (q: Partial<QuotaUsage>): QuotaUsage => ({
  records_per_minute: 0,
  bytes_per_day: 0,
  bytes_today: 0,
  bytes_today_ratio: null,
  rejected_today: 0,
  ...q,
});

describe("rejectReasons", () => {
  it("labels known reasons, keeps unknown codes and drops empty ones, most first", () => {
    expect(
      rejectReasons([
        { reason: "invalid", records: 3 },
        { reason: "app_quota_x", records: 5 },
        { reason: "bytes_per_day", records: 0 },
        { reason: "records_per_minute", records: 5 },
      ]),
    ).toEqual([
      { reason: "app_quota_x", label: "app_quota_x", records: 5 },
      { reason: "records_per_minute", label: "Over the records-per-minute quota", records: 5 },
      { reason: "invalid", label: "Invalid record", records: 3 },
    ]);
    expect(rejectReasons(null)).toEqual([]);
  });
});

describe("usageBars", () => {
  it("scales accepted records to the busiest day", () => {
    const { top, bars } = usageBars([day("2026-11-01", 50), day("2026-11-02", 100)], 200, 100);
    expect(top).toBe(100);
    expect(bars.map((b) => [b.x, b.w, b.y, b.h])).toEqual([
      [12.5, 75, 50, 50],
      [112.5, 75, 0, 100],
    ]);
  });
  it("draws an empty month flat", () => {
    const { top, bars } = usageBars([day("2026-11-01", 0)], 100, 100);
    expect(top).toBe(1);
    expect(bars[0].h).toBe(0);
  });
});

describe("usageSummary", () => {
  const label = (d: string) => d;
  it("states the total, the average and the busiest day", () => {
    expect(usageSummary([day("a", 10), day("b", 30), day("c", 0)], label)).toBe(
      "40 records accepted in the 3 days, 13 a day on average. Busiest day b: 30.",
    );
  });
  it("says when nothing was accepted", () => {
    expect(usageSummary([day("a", 0)], label)).toBe("No records accepted in the 1 days.");
    expect(usageSummary([], label)).toBe("No days to show.");
  });
});

describe("quotaMeter", () => {
  it("is null when bytes are unlimited", () => {
    expect(quotaMeter(quota({}))).toBeNull();
  });
  it("reads today's share, clamped, with a tone", () => {
    expect(quotaMeter(quota({ bytes_per_day: 10_000_000, bytes_today: 3_100_000, bytes_today_ratio: 0.31 }))).toEqual({
      percent: 31,
      label: "3.1 MB of 10 MB today (31%)",
      tone: "ok",
    });
    expect(quotaMeter(quota({ bytes_per_day: 1000, bytes_today: 850, bytes_today_ratio: 0.85 }))?.tone).toBe("warn");
    const over = quotaMeter(quota({ bytes_per_day: 1000, bytes_today: 1500, bytes_today_ratio: 1.5 }));
    expect(over?.percent).toBe(100);
    expect(over?.tone).toBe("over");
  });
});

describe("recordsLimitLine", () => {
  it("names the limit or says unlimited", () => {
    expect(recordsLimitLine(quota({ records_per_minute: 1000 }))).toBe("1,000 records a minute");
    expect(recordsLimitLine(quota({}))).toBe("Unlimited");
  });
});
