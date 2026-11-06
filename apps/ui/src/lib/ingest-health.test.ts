import { describe, expect, it } from "vitest";
import type { AppSdkStats } from "./identity";
import { INGEST_RUNBOOK, counterShare, dayBars, daysSummary, dropReasons, dropSummary, formatCount, ingestPath, plural, sdkLine, share, shortenedRecords } from "./ingest-health";

const sdk = (over: Partial<AppSdkStats> = {}): AppSdkStats => ({
  instances: 2,
  queued_records: 0,
  sent_records: 1200,
  failed_batches: 0,
  dropped_records: 0,
  drop_counts: {},
  ...over,
});

describe("ingestPath", () => {
  it("names the app in the query", () => {
    expect(ingestPath("shop")).toBe("/shop/settings/ingest");
    expect(ingestPath("shop", "checkout api")).toBe("/shop/settings/ingest?app=checkout%20api");
  });
});

describe("INGEST_RUNBOOK", () => {
  it("points at the ingest health page of the docs", () => {
    expect(INGEST_RUNBOOK).toMatch(/\/ingest\/ingest-health$/);
  });
});

describe("numbers", () => {
  it("formats counts and plurals", () => {
    expect(formatCount(1234567)).toBe("1,234,567");
    expect(formatCount(-3)).toBe("0");
    expect(plural(1, "batch", "batches")).toBe("1 batch");
    expect(plural(3, "batch", "batches")).toBe("3 batches");
  });

  it("gives shares with one decimal, <0.1% for a tiny one and null without a base", () => {
    expect(share(1, 4)).toBe("25%");
    expect(share(1, 3)).toBe("33.3%");
    expect(share(1, 10_000)).toBe("<0.1%");
    expect(share(0, 10)).toBe("0%");
    expect(share(0, 0)).toBeNull();
  });

  it("shares rejected of what arrived and the others of what was stored", () => {
    const c = { accepted: 900, rejected: 100, truncated: 9, masked: 90 };
    expect(counterShare("accepted", c)).toBeNull();
    expect(counterShare("rejected", c)).toBe("10% of received");
    expect(counterShare("truncated", c)).toBe("1% of accepted");
    expect(counterShare("masked", c)).toBe("10% of accepted");
    expect(counterShare("masked", { accepted: 0, rejected: 0, truncated: 0, masked: 0 })).toBeNull();
  });
});

describe("SDK drops", () => {
  it("lists reasons with drops, most first, named for people; shortened records are not drops", () => {
    const stats = sdk({ dropped_records: 15, drop_counts: { queue_full: 3, retries_exhausted: 12, queue_bytes: 0, truncated: 4, custom_reason: 3 } });
    expect(dropReasons(stats)).toEqual([
      { reason: "retries_exhausted", label: "Still failing after retries", count: 12 },
      { reason: "custom_reason", label: "custom_reason", count: 3 },
      { reason: "queue_full", label: "Queue full (record limit)", count: 3 },
    ]);
    expect(shortenedRecords(stats)).toBe(4);
    expect(shortenedRecords(sdk())).toBe(0);
  });

  it("sums up what was lost in one line, or nothing", () => {
    expect(dropSummary(sdk({ failed_batches: 3, dropped_records: 12 }))).toBe("3 batches failed · 12 records dropped");
    expect(dropSummary(sdk({ failed_batches: 1 }))).toBe("1 batch failed");
    expect(dropSummary(sdk({ dropped_records: 1 }))).toBe("1 record dropped");
    expect(dropSummary(sdk())).toBeNull();
    expect(dropSummary(sdk({ instances: 0, failed_batches: 3 }))).toBeNull();
  });

  it("says which instances the counters cover", () => {
    expect(sdkLine(sdk({ instances: 0 }))).toMatch(/^No SDK instance sent a heartbeat in the last hour/);
    expect(sdkLine(sdk())).toBe("Nothing dropped by the 2 instances seen in the last hour.");
    expect(sdkLine(sdk({ instances: 1, dropped_records: 2 }))).toBe("Summed over the 1 instance seen in the last hour, since each process started.");
  });
});

const day = (date: string, accepted: number, rejected = 0) => ({ date, accepted, rejected, truncated: 0, masked: 0 });

describe("dayBars", () => {
  it("stacks rejected on accepted, scaled to the busiest day", () => {
    const { top, bars } = dayBars([day("2026-11-01", 50, 50), day("2026-11-02", 25)], 200, 100);
    expect(top).toBe(100);
    expect(bars[0]).toMatchObject({ x: 12.5, w: 75, accepted: { y: 50, h: 50 }, rejected: { y: 0, h: 50 } });
    expect(bars[1]).toMatchObject({ x: 112.5, accepted: { y: 75, h: 25 }, rejected: { y: 75, h: 0 } });
  });
  it("draws an empty week flat", () => {
    const { top, bars } = dayBars([day("2026-11-01", 0)], 100, 100);
    expect(top).toBe(1);
    expect(bars[0].accepted.h).toBe(0);
  });
  it("ignores negative counts", () => {
    expect(dayBars([day("2026-11-01", -5, -1)], 100, 100).bars[0].accepted.h).toBe(0);
  });
});

describe("daysSummary", () => {
  it("names the busiest day and the rejections", () => {
    expect(daysSummary([day("a", 10, 2), day("b", 30)], (d) => d)).toBe("Busiest day b: 30 records received. 2 records rejected over the 2 days.");
    expect(daysSummary([day("a", 1)], (d) => d)).toBe("Busiest day a: 1 record received. None rejected.");
    expect(daysSummary([], (d) => d)).toBe("No days to show.");
  });
});
