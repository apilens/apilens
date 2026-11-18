import { describe, expect, it } from "vitest";
import { bucketFraction, labelEvery, latencyMarks, timeFraction, timeTicks, trimHistogram } from "./chart-ticks";

const at = (iso: string) => Date.parse(iso);
const labels = (r: ReturnType<typeof timeTicks>) => r.ticks.map((t) => t.label);
const isos = (r: ReturnType<typeof timeTicks>) => r.ticks.map((t) => new Date(t.at).toISOString());

describe("timeTicks", () => {
  it("puts 3–5 ticks on round wall-clock times in UTC over an hour", () => {
    const r = timeTicks(at("2026-11-18T08:07:00Z"), at("2026-11-18T09:07:00Z"), "UTC");
    expect(r.step).toBe(15 * 60_000);
    expect(labels(r)).toEqual(["08:15", "08:30", "08:45", "09:00"]);
    expect(r.zone).toBe("UTC");
  });

  it("aligns to the wall clock in Asia/Kolkata (UTC+5:30), not to UTC", () => {
    const r = timeTicks(at("2026-11-18T08:07:00Z"), at("2026-11-18T09:07:00Z"), "Asia/Kolkata");
    // 13:37–14:37 IST: the quarter hours of IST fall on :00, :15… of IST, i.e. :15/:30/:45/:00 + 30 min of UTC.
    expect(labels(r)).toEqual(["13:45", "14:00", "14:15", "14:30"]);
    expect(isos(r)).toEqual(["2026-11-18T08:15:00.000Z", "2026-11-18T08:30:00.000Z", "2026-11-18T08:45:00.000Z", "2026-11-18T09:00:00.000Z"]);
    expect(r.zone).toBe("IST");
  });

  it("uses hours in Asia/Kolkata on the half hour of UTC", () => {
    const r = timeTicks(at("2026-11-18T00:00:00Z"), at("2026-11-18T06:00:00Z"), "Asia/Kolkata");
    expect(labels(r)).toEqual(["06:00", "08:00", "10:00"]);
    expect(isos(r)[0]).toBe("2026-11-18T00:30:00.000Z");
  });

  it("labels seconds for a sub-minute range", () => {
    const r = timeTicks(at("2026-11-18T10:00:03Z"), at("2026-11-18T10:00:33Z"), "UTC");
    expect(r.step).toBe(10_000);
    expect(labels(r)).toEqual(["10:00:10", "10:00:20", "10:00:30"]);
  });

  it("labels midnight with the date over a day", () => {
    const r = timeTicks(at("2026-11-17T10:00:00Z"), at("2026-11-18T10:00:00Z"), "UTC");
    expect(r.step).toBe(6 * 3_600_000);
    expect(labels(r)).toEqual(["12:00", "18:00", "Nov 18", "06:00"]);
  });

  it("labels days for a week", () => {
    const r = timeTicks(at("2026-11-11T10:00:00Z"), at("2026-11-18T10:00:00Z"), "UTC");
    expect(r.step).toBe(2 * 86_400_000);
    expect(labels(r)).toEqual(["Nov 13", "Nov 15", "Nov 17"]);
  });

  it("starts weeks on Mondays over 30 days", () => {
    const r = timeTicks(at("2026-10-19T10:00:00Z"), at("2026-11-18T10:00:00Z"), "UTC");
    expect(r.step).toBe(7 * 86_400_000);
    // Oct 26, Nov 2, 9, 16 2026 are Mondays.
    expect(labels(r)).toEqual(["Oct 26", "Nov 2", "Nov 9", "Nov 16"]);
  });

  it("keeps wall-clock ticks across a DST change (America/New_York, spring forward)", () => {
    // 2026-03-07 12:00 EST to 2026-03-08 12:00 EDT: 23 hours.
    const r = timeTicks(at("2026-03-07T17:00:00Z"), at("2026-03-08T16:00:00Z"), "America/New_York");
    expect(labels(r)).toEqual(["12:00", "18:00", "Mar 8", "06:00", "12:00"]);
    const t = r.ticks.map((x) => x.at);
    // Midnight to 06:00 is 5 real hours that night.
    expect(t[3] - t[2]).toBe(5 * 3_600_000);
    expect(r.zone).toBe("EDT");
  });

  it("never ticks a wall time the clocks skipped", () => {
    // 01:00–04:00 EST/EDT on 2026-03-08: 02:00 does not exist.
    const r = timeTicks(at("2026-03-08T06:00:00Z"), at("2026-03-08T08:00:00Z"), "America/New_York");
    expect(labels(r)).not.toContain("02:00");
    expect(new Set(labels(r)).size).toBe(r.ticks.length);
  });

  it("stays within the range, ascending, and at most max", () => {
    for (const tz of ["UTC", "Asia/Kolkata", "America/New_York", "Asia/Kathmandu"]) {
      for (const span of [45_000, 3_600_000, 6 * 3_600_000, 86_400_000, 7 * 86_400_000]) {
        const from = at("2026-11-02T03:17:12Z");
        for (const max of [3, 4, 5]) {
          const r = timeTicks(from, from + span, tz, max);
          expect(r.ticks.length).toBeGreaterThanOrEqual(2);
          expect(r.ticks.length).toBeLessThanOrEqual(max);
          r.ticks.forEach((x, i) => {
            expect(x.at).toBeGreaterThanOrEqual(from);
            expect(x.at).toBeLessThanOrEqual(from + span);
            if (i) expect(x.at).toBeGreaterThan(r.ticks[i - 1].at);
          });
        }
      }
    }
  });

  it("gives no ticks for an empty or invalid range", () => {
    expect(timeTicks(10, 10, "UTC").ticks).toEqual([]);
    expect(timeTicks(Number.NaN, 10, "UTC").ticks).toEqual([]);
  });
});

describe("timeFraction", () => {
  it("maps an instant across equal bucket slots", () => {
    expect(timeFraction(0, 0, 60_000, 60)).toBe(0);
    expect(timeFraction(30 * 60_000, 0, 60_000, 60)).toBe(0.5);
    expect(timeFraction(120 * 60_000, 0, 60_000, 60)).toBe(1);
    expect(timeFraction(5, 0, 0, 60)).toBe(0);
  });
});

const B = [
  { label: "0–10 ms", from: 0, to: 10, count: 4 },
  { label: "10–100 ms", from: 10, to: 100, count: 6 },
  { label: "100–1000 ms", from: 100, to: 1000, count: 0 },
  { label: "1–10 s", from: 1000, to: 10_000, count: 0 },
  { label: "≥10 s", from: 10_000, count: 0 },
];

describe("trimHistogram", () => {
  it("drops the empty buckets at the end", () => {
    expect(trimHistogram(B).map((b) => b.label)).toEqual(["0–10 ms", "10–100 ms"]);
  });
  it("keeps the bucket a mark falls in", () => {
    expect(trimHistogram(B, [500]).map((b) => b.label)).toEqual(["0–10 ms", "10–100 ms", "100–1000 ms"]);
    expect(trimHistogram(B, [20_000])).toHaveLength(5);
  });
  it("keeps one bucket when all are empty", () => {
    expect(trimHistogram(B.map((b) => ({ ...b, count: 0 })))).toHaveLength(1);
    expect(trimHistogram([])).toEqual([]);
  });
});

describe("bucketFraction", () => {
  it("places a value linearly inside its bucket's slot", () => {
    expect(bucketFraction(B, 0)).toBe(0);
    expect(bucketFraction(B, 5)).toBeCloseTo(0.1);
    expect(bucketFraction(B, 55)).toBeCloseTo(0.3);
    expect(bucketFraction(B, 20_000)).toBeCloseTo(0.9);
    expect(bucketFraction(B.slice(0, 2), 500)).toBe(1);
    expect(bucketFraction([], 5)).toBeNull();
  });
});

describe("latencyMarks", () => {
  it("marks p50 and p95, and T only when known", () => {
    expect(latencyMarks({ p50_ms: 31, p95_ms: 412.6 }).map((m) => `${m.label} ${m.text}`)).toEqual(["p50 31 ms", "p95 413 ms"]);
    expect(latencyMarks({ p50_ms: 31, p95_ms: 412.6 }, 500).map((m) => `${m.label} ${m.text}`)).toEqual(["p50 31 ms", "p95 413 ms", "T 500 ms"]);
    expect(latencyMarks({ p50_ms: 31, p95_ms: 412.6 }, null)).toHaveLength(2);
  });
});

describe("labelEvery", () => {
  it("thins labels so they never overlap", () => {
    expect(labelEvery(100, 72)).toBe(1);
    expect(labelEvery(40, 72)).toBe(2);
    expect(labelEvery(0, 72)).toBe(Number.POSITIVE_INFINITY);
  });
});
