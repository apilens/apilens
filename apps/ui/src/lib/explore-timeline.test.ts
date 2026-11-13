import { describe, expect, it } from "vitest";
import { exploreHref, parseExploreQuery, requestsPath, scopeText, timelinePath } from "./explore";
import { NO_FILTERS } from "./explore-filters";
import {
  bucketAt,
  bucketText,
  chartWindow,
  formatInstant,
  instantText,
  isoSecond,
  jumpPoint,
  labelStyle,
  logWindow,
  moveBucket,
  parseWindow,
  selectionWindow,
  timeX,
  timelinePoll,
  windowText,
  timelineTotals,
} from "./explore-timeline";
import type { RequestTimeline } from "./identity";

const T0 = "2026-11-05T10:00:00Z";
const at = (min: number, sec = 0) => isoSecond(Date.parse(T0) + min * 60_000 + sec * 1000);

/** A 10-minute timeline of one-minute buckets from 10:00 to 10:10 UTC. */
const timeline: RequestTimeline = {
  from: T0,
  to: at(10),
  bucket_seconds: 60,
  buckets: Array.from({ length: 10 }, (_, i) => ({ ts: at(i), requests: i, successful: i, client_errors: 0, server_errors: 0 })),
};

describe("parseWindow", () => {
  it("reads and normalises the zoom and the jump point", () => {
    expect(parseWindow({ from: "2026-11-05T10:02:00.000Z", to: "2026-11-05T11:14:00+01:00", at: at(5) })).toEqual({ from: at(2), to: at(14), at: at(5) });
    expect(parseWindow({})).toEqual({});
    expect(parseWindow({ from: [at(1), at(2)] })).toEqual({ from: at(1) });
  });
  it("drops what is not a time, a reversed zoom and a jump outside the zoom", () => {
    expect(parseWindow({ from: "yesterday", to: "x".repeat(50), at: "soon" })).toEqual({});
    expect(parseWindow({ from: at(5), to: at(5) })).toEqual({});
    expect(parseWindow({ from: at(6), to: at(2), at: at(4) })).toEqual({ at: at(4) });
    expect(parseWindow({ from: at(2), to: at(6), at: at(2) })).toEqual({ from: at(2), to: at(6) });
    expect(parseWindow({ from: at(2), to: at(6), at: at(7) })).toEqual({ from: at(2), to: at(6) });
    expect(parseWindow({ from: at(2), to: at(6), at: at(6) })).toEqual({ from: at(2), to: at(6), at: at(6) });
  });
});

describe("the window in the URL", () => {
  const q = { range: "6h" as const, filters: { ...NO_FILTERS, method: "POST" }, from: at(2), to: at(8), at: at(5) };
  it("puts range, window and filters in a fixed order, and a deep link reads it back", () => {
    const href = exploreHref("shop", q);
    expect(href).toBe(`/shop/explore?range=6h&from=${encodeURIComponent(at(2))}&to=${encodeURIComponent(at(8))}&at=${encodeURIComponent(at(5))}&method=POST`);
    const back = parseExploreQuery(Object.fromEntries(new URL(href, "http://x").searchParams));
    expect(back).toEqual(q);
  });
  it("reads the log up to the jump point and the timeline over the zoom", () => {
    expect(logWindow(q)).toEqual({ from: at(2), to: at(5) });
    expect(logWindow({ at: at(5) })).toEqual({ to: at(5) });
    expect(logWindow({})).toEqual({});
    expect(chartWindow(q)).toEqual({ from: at(2), to: at(8) });
    expect(requestsPath("shop", q)).toBe(`/api/projects/shop/requests?range=6h&from=${encodeURIComponent(at(2))}&to=${encodeURIComponent(at(5))}&method=POST`);
    expect(timelinePath("shop", q)).toBe(`/api/projects/shop/requests/timeline?range=6h&from=${encodeURIComponent(at(2))}&to=${encodeURIComponent(at(8))}&method=POST`);
    expect(timelinePath("shop", { range: "1h" })).toBe("/api/projects/shop/requests/timeline?range=1h");
  });
  it("says the scope in words", () => {
    expect(scopeText({ range: "1h" })).toBe("the last 1 hour");
    expect(scopeText({ range: "1h", from: at(2), to: at(8) })).toBe("the window from 10:02 to 10:08 UTC");
    expect(scopeText({ range: "1h", at: at(5, 30) })).toBe("the last 1 hour, up to 10:05:30 UTC");
  });
});

describe("bucket geometry", () => {
  it("finds the bucket under a pixel, clamped to the ends", () => {
    expect([-5, 0, 49, 50, 999, 1000, 2000].map((x) => bucketAt(x, 1000, 10))).toEqual([0, 0, 0, 0, 9, 9, 9]);
    expect(bucketAt(120, 1000, 10)).toBe(1);
    expect(bucketAt(10, 0, 10)).toBe(0);
    expect(bucketAt(10, 100, 0)).toBe(0);
  });
  it("jumps to the end of the clicked bucket", () => {
    expect(jumpPoint(timeline, 3)).toBe(at(4));
    expect(jumpPoint(timeline, 9)).toBe(at(10));
    expect(jumpPoint(timeline, 10)).toBeNull();
  });
  it("caps the last bucket's end at the window's end", () => {
    const partial = { ...timeline, to: at(9, 30) };
    expect(jumpPoint(partial, 9)).toBe(at(9, 30));
    expect(selectionWindow(partial, 9, 7)).toEqual({ from: at(7), to: at(9, 30) });
  });
  it("zooms a drag to whole buckets, in either direction", () => {
    expect(selectionWindow(timeline, 2, 4)).toEqual({ from: at(2), to: at(5) });
    expect(selectionWindow(timeline, 4, 2)).toEqual({ from: at(2), to: at(5) });
    expect(selectionWindow(timeline, -3, 99)).toEqual({ from: T0, to: at(10) });
    expect(selectionWindow({ ...timeline, buckets: [] }, 0, 1)).toBeNull();
  });
  it("does not start a zoom before the window when the first bucket does", () => {
    const shifted = { ...timeline, from: at(0, 20) };
    expect(selectionWindow(shifted, 0, 1)).toEqual({ from: at(0, 20), to: at(2) });
  });
  it("places the jump point on the plot", () => {
    expect(timeX(timeline, at(5), 1000)).toBe(500);
    expect(timeX(timeline, at(10), 1000)).toBe(1000);
    expect(timeX(timeline, at(11), 1000)).toBeNull();
    expect(timeX(timeline, "nope", 1000)).toBeNull();
  });
  it("moves the keyboard focus between bars", () => {
    expect(["ArrowRight", "ArrowLeft", "Home", "End", "a"].map((k) => moveBucket(k, 4, 10))).toEqual([5, 3, 0, 9, null]);
    expect(moveBucket("ArrowRight", 9, 10)).toBe(9);
    expect(moveBucket("ArrowLeft", 0, 10)).toBe(0);
    expect(moveBucket("ArrowLeft", 0, 0)).toBeNull();
  });
});

describe("labels", () => {
  it("formats instants and windows in UTC", () => {
    expect(formatInstant(at(5))).toBe("10:05");
    expect(formatInstant(at(5, 7), { seconds: true })).toBe("10:05:07");
    expect(formatInstant(at(5), { withDay: true })).toBe("Nov 5, 10:05");
    expect(formatInstant("x")).toBe("");
    expect(windowText(at(2), at(14))).toBe("10:02 to 10:14 UTC");
    expect(windowText(at(2, 30), at(3))).toBe("10:02:30 to 10:03:00 UTC");
    expect(windowText("2026-11-04T22:00:00Z", "2026-11-05T02:00:00Z")).toBe("Nov 4, 22:00 to Nov 5, 02:00 UTC");
    expect(instantText(at(5))).toBe("10:05 UTC");
  });
  it("labels seconds for sub-minute buckets and the day from 6 hours up", () => {
    expect(labelStyle(timeline)).toEqual({ seconds: false, withDay: false });
    expect(labelStyle({ ...timeline, bucket_seconds: 10 })).toEqual({ seconds: true, withDay: false });
    expect(labelStyle({ from: T0, to: at(6 * 60), bucket_seconds: 300 })).toEqual({ seconds: false, withDay: true });
  });
  it("says what a bar holds", () => {
    const b = { ts: at(3), requests: 1204, successful: 1100, client_errors: 100, server_errors: 4 };
    expect(bucketText(timeline, b)).toBe("10:03 to 10:04 UTC: 1,204 requests (1,100 successful, 100 4xx, 4 5xx)");
    expect(bucketText(timeline, { ...b, requests: 1 })).toContain(": 1 request (");
  });
});

describe("timelinePoll", () => {
  it("reads the Route Handler's answers", () => {
    expect(timelinePoll(200, { ok: true, timeline })).toEqual({ kind: "timeline", timeline });
    expect(timelinePoll(401, { ok: false, code: "session_expired", next: "/auth/refresh" })).toEqual({ kind: "expired", next: "/auth/refresh" });
    expect(timelinePoll(503, null)).toEqual({ kind: "error", code: "unavailable" });
    expect(timelinePoll(200, { ok: true })).toEqual({ kind: "error", code: "network_error" });
  });
});

describe("timelineTotals", () => {
  it("sums every bucket by status class", () => {
    const b = (requests: number, successful: number, c: number, sv: number) => ({ ts: "t", requests, successful, client_errors: c, server_errors: sv });
    expect(timelineTotals({ buckets: [b(10, 7, 2, 1), b(5, 5, 0, 0)] })).toEqual({ requests: 15, successful: 12, client_errors: 2, server_errors: 1 });
  });
  it("reads no buckets as zero", () => {
    expect(timelineTotals({ buckets: null })).toEqual({ requests: 0, successful: 0, client_errors: 0, server_errors: 0 });
  });
});
