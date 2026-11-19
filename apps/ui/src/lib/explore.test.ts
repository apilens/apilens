import { describe, expect, it } from "vitest";
import {
  logCaption,
  logPages,
  LOG_LIMIT,
  OVERSCAN,
  ROW_HEIGHT,
  consumerOf,
  exploreHref,
  formatBytes,
  isSampledOut,
  latencyTone,
  logPoll,
  moveFocus,
  parseExploreQuery,
  requestsPath,
  rowKey,
  scopeText,
  statusClass,
  visibleWindow,
  logTime,
  statusQuickHref,
  bucketHrefs,
  exploreHrefFor,
} from "./explore";
import { NO_FILTERS } from "./explore-filters";

describe("parseExploreQuery / exploreHref", () => {
  it("defaults to the last hour and always writes a given range (Explore's own default is 24 hours)", () => {
    expect(parseExploreQuery({})).toEqual({ range: "1h", filters: NO_FILTERS });
    expect(exploreHref("shop", { range: "1h" })).toBe("/project/shop/explore?range=1h");
    expect(exploreHref("shop", {})).toBe("/project/shop/explore");
  });
  it("keeps a known range and drops an unknown one", () => {
    expect(parseExploreQuery({ range: "7d" })).toEqual({ range: "7d", filters: NO_FILTERS });
    expect(parseExploreQuery({ range: ["6h", "7d"] })).toEqual({ range: "6h", filters: NO_FILTERS });
    expect(parseExploreQuery({ range: "30d" })).toEqual({ range: "1h", filters: NO_FILTERS });
    expect(exploreHref("my shop", { range: "24h" })).toBe("/project/my%20shop/explore?range=24h");
  });
  it("polls the project's Route Handler with the range", () => {
    expect(requestsPath("shop", { range: "6h" })).toBe("/api/projects/shop/requests?range=6h");
    expect(scopeText({ range: "24h" }, "UTC")).toBe("the last 24 hours");
  });
  it("asks for the API's largest page", () => {
    expect(LOG_LIMIT).toBe(200);
  });
});

describe("row formatting", () => {
  it("classes status codes for the chip", () => {
    expect([200, 204, 301, 404, 429, 500, 503, 99, 600].map(statusClass)).toEqual(["2xx", "2xx", "3xx", "4xx", "4xx", "5xx", "5xx", "other", "other"]);
  });
  it("tones latency against 500 ms and 2 s", () => {
    expect([0, 500, 501, 2000, 2001].map(latencyTone)).toEqual(["ok", "ok", "slow", "slow", "frustrated"]);
  });
  it("formats body sizes", () => {
    expect([0, 512, 999, 1000, 1234, 14_200, 999_400, 3_400_000, 2e12].map(formatBytes)).toEqual([
      "0 B",
      "512 B",
      "999 B",
      "1.0 KB",
      "1.2 KB",
      "14 KB",
      "999 KB",
      "3.4 MB",
      "2000 GB",
    ]);
    expect(formatBytes(undefined)).toBe("–");
    expect(formatBytes(-1)).toBe("–");
  });
  it("names the consumer, falling back to its id, else anonymous", () => {
    expect(consumerOf({ consumer_id: "c_1", consumer_name: " Acme " })).toBe("Acme");
    expect(consumerOf({ consumer_id: "c_1", consumer_name: "" })).toBe("c_1");
    expect(consumerOf({ consumer_id: "", consumer_name: "" })).toBeNull();
  });
  it("marks only rows the SDK sampled out", () => {
    expect(isSampledOut({ sampled: false })).toBe(true);
    expect(isSampledOut({ sampled: true })).toBe(false);
    expect(isSampledOut({})).toBe(false);
  });
  it("keys rows by trace id, else by time and position", () => {
    expect(rowKey({ timestamp: "t", trace_id: "abc" }, 3)).toBe("abc");
    expect(rowKey({ id: "r1", timestamp: "t", trace_id: "abc" }, 3)).toBe("r1");
    expect(rowKey({ timestamp: "t", trace_id: "" }, 3)).toBe("t#3");
  });
});

describe("visibleWindow", () => {
  // Expressed in rows, so the cases hold whatever ROW_HEIGHT is: a viewport of 15 rows.
  const VIEW = 15 * ROW_HEIGHT;
  it("renders the rows in view plus overscan, never all 200", () => {
    expect(visibleWindow(0, VIEW, 200)).toEqual({ start: 0, end: 15 + OVERSCAN });
    const mid = visibleWindow(100 * ROW_HEIGHT, VIEW, 200);
    expect(mid).toEqual({ start: 100 - OVERSCAN, end: 100 + 15 + OVERSCAN });
    expect(mid.end - mid.start).toBeLessThan(40);
  });
  it("clamps to the row count", () => {
    expect(visibleWindow(190 * ROW_HEIGHT, VIEW, 200)).toEqual({ start: 190 - OVERSCAN, end: 200 });
    expect(visibleWindow(99_999, VIEW, 10)).toEqual({ start: 10, end: 10 });
    expect(visibleWindow(0, VIEW, 0)).toEqual({ start: 0, end: 0 });
  });
  it("renders one screen from the top before layout", () => {
    expect(visibleWindow(0, 0, 200)).toEqual({ start: 0, end: 20 + OVERSCAN });
  });
});

describe("moveFocus", () => {
  it("moves by one, by a page and to the ends, clamped", () => {
    expect(moveFocus("ArrowDown", 0, 10, 5)).toBe(1);
    expect(moveFocus("ArrowDown", 9, 10, 5)).toBe(9);
    expect(moveFocus("ArrowUp", 0, 10, 5)).toBe(0);
    expect(moveFocus("PageDown", 0, 10, 5)).toBe(4);
    expect(moveFocus("PageDown", 8, 10, 5)).toBe(9);
    expect(moveFocus("PageUp", 3, 10, 5)).toBe(0);
    expect(moveFocus("Home", 7, 10, 5)).toBe(0);
    expect(moveFocus("End", 2, 10, 5)).toBe(9);
  });
  it("leaves other keys alone, so ⌘K and Tab keep working", () => {
    expect(moveFocus("k", 3, 10, 5)).toBeNull();
    expect(moveFocus("Tab", 3, 10, 5)).toBeNull();
    expect(moveFocus("ArrowDown", 0, 0, 5)).toBeNull();
  });
});

describe("older pages", () => {
  const q = parseExploreQuery({ range: "6h", status: "5xx" });
  it("walks older with the API cursor, keeping the range and filters, and back", () => {
    const first = logPages("shop", q, [], "c1");
    expect(first.page).toBe(1);
    expect(first.newerHref).toBeNull();
    expect(first.olderHref).toBe("/project/shop/explore?range=6h&status=5xx&cursor=c1");
    const second = logPages("shop", q, ["c1"], "c2");
    expect(second.page).toBe(2);
    expect(second.olderHref).toBe("/project/shop/explore?range=6h&status=5xx&cursor=c1.c2");
    expect(second.newerHref).toBe("/project/shop/explore?range=6h&status=5xx");
    expect(second.newestHref).toBe("/project/shop/explore?range=6h&status=5xx");
    expect(logPages("shop", q, ["c1"], "").olderHref).toBeNull();
  });
  it("never carries the cursor into a range or filter link", () => {
    expect(exploreHref("shop", q)).not.toContain("cursor");
  });
  it("captions the newest and an older page", () => {
    expect(logCaption(q, 1, 200, true, "UTC")).toBe("The newest 200 requests in the last 6 hours matching the filters, newest first.");
    expect(logCaption(q, 3, 12, false, "UTC")).toBe("Requests 401–412 from the newest in the last 6 hours, newest first. Live updates run on the newest page only.");
  });
});

describe("logPoll", () => {
  it("reads rows", () => {
    expect(logPoll(200, { ok: true, requests: [{ method: "GET" }], next_cursor: "c1" })).toEqual({ kind: "rows", rows: [{ method: "GET" }], older: "c1" });
    expect(logPoll(200, { ok: true, requests: null })).toEqual({ kind: "rows", rows: [], older: "" });
  });
  it("sends an expired session to sign in", () => {
    expect(logPoll(401, { ok: false, code: "session_expired", next: "/sign-in?reason=session_expired" })).toEqual({
      kind: "expired",
      next: "/sign-in?reason=session_expired",
    });
  });
  it("reports failures by code", () => {
    expect(logPoll(503, { ok: false, code: "unavailable" })).toEqual({ kind: "error", code: "unavailable" });
    expect(logPoll(502, null)).toEqual({ kind: "error", code: "unavailable" });
    expect(logPoll(0, "nope")).toEqual({ kind: "error", code: "network_error" });
  });
});

describe("logTime", () => {
  const now = Date.parse("2026-11-06T10:52:00Z");
  it("shows the UTC clock time to the millisecond, without a day for today", () => {
    expect(logTime("2026-11-06T10:51:03.214Z", now, "UTC")).toEqual({ day: "", clock: "10:51:03", ms: ".214" });
  });
  it("puts the day in front for another UTC day", () => {
    expect(logTime("2026-11-05T23:59:59.007Z", now, "UTC")).toEqual({ day: "Nov 5", clock: "23:59:59", ms: ".007" });
  });
  it("reads the clock and the day in the user's zone", () => {
    // 23:59:59 UTC on Nov 5 is 05:29:59 IST on Nov 6, the same day as `now` (16:22 IST).
    expect(logTime("2026-11-05T23:59:59.007Z", now, "Asia/Kolkata")).toEqual({ day: "", clock: "05:29:59", ms: ".007" });
    // 20:00 UTC on Nov 6 is already Nov 7 in IST.
    expect(logTime("2026-11-06T20:00:00.000Z", now, "Asia/Kolkata")).toEqual({ day: "Nov 7", clock: "01:30:00", ms: ".000" });
  });
  it("reads an unparseable time as a dash", () => {
    expect(logTime("nope", now, "UTC")).toEqual({ day: "", clock: "–", ms: "" });
  });
});

describe("statusQuickHref", () => {
  const q = { range: "6h" as const, filters: { ...NO_FILTERS, method: "POST" }, at: "2026-11-06T10:00:00Z" };
  it("narrows to a status class, keeping the other filters and the range", () => {
    const r = statusQuickHref("demo", q, "5xx");
    expect(r.active).toBe(false);
    expect(r.href).toBe("/project/demo/explore?range=6h&method=POST&status=5xx");
  });
  it("clears the status filter when that class is already on", () => {
    const r = statusQuickHref("demo", { ...q, filters: { ...q.filters, status: "5xx" } }, "5xx");
    expect(r.active).toBe(true);
    expect(r.href).toBe("/project/demo/explore?range=6h&method=POST");
  });
});

describe("exploreHrefFor (#977)", () => {
  const APP = "0b9c2c4e-8a3f-4d1e-9f2a-1c2d3e4f5a6b";
  it("always carries the range, then the environment and app", () => {
    expect(exploreHrefFor("shop", { range: "1h" })).toBe("/project/shop/explore?range=1h");
    expect(exploreHrefFor("shop", { range: "24h", env: "production", app: APP })).toBe(`/project/shop/explore?range=24h&env=production&app=${APP}`);
    expect(exploreHrefFor("shop", { range: "24h", env: "", app: "" })).toBe("/project/shop/explore?range=24h");
  });
  it("narrows to an endpoint by its route template, a status and a latency bound", () => {
    const href = exploreHrefFor("shop", { range: "6h", env: "production", method: "get", path: "/orders/{id}", status: "5XX", latency_min: 412.6 });
    expect(href).toBe("/project/shop/explore?range=6h&env=production&method=GET&status=5xx&path=%2Forders%2F%7Bid%7D&latency_min=412");
    // What Explore reads back: the same filters, the template kept as is.
    const q = parseExploreQuery(Object.fromEntries(new URL(href, "http://x").searchParams));
    expect(q.range).toBe("6h");
    expect(q.filters).toEqual({ ...NO_FILTERS, env: "production", method: "GET", status: "5xx", path: "/orders/{id}", latency_min: 412 });
  });
  it("drops a status or latency Explore would refuse", () => {
    expect(exploreHrefFor("shop", { range: "1h", status: "teapot", latency_min: Number.NaN })).toBe("/project/shop/explore?range=1h");
    expect(exploreHrefFor("shop", { range: "1h", latency_min: -1 })).toBe("/project/shop/explore?range=1h");
  });
  it("carries a consumer and a time window", () => {
    expect(exploreHrefFor("shop", { range: "24h", consumer_id: "acme", from: "2026-11-05T10:00:00Z", to: "2026-11-05T10:15:00Z" })).toBe(
      "/project/shop/explore?range=24h&from=2026-11-05T10%3A00%3A00Z&to=2026-11-05T10%3A15%3A00Z&consumer_id=acme",
    );
  });
});

describe("bucketHrefs (#977)", () => {
  const ts = (m: number) => new Date(Date.UTC(2026, 10, 5, 10, m)).toISOString();
  it("opens each bucket as its own window, the last as wide as the one before", () => {
    const hrefs = bucketHrefs("shop", { range: "24h", env: "production" }, [{ ts: ts(0) }, { ts: ts(15) }, { ts: ts(30) }]);
    const windows = hrefs.map((h) => {
      const p = new URL(h, "http://x").searchParams;
      return [p.get("from"), p.get("to"), p.get("range"), p.get("env")];
    });
    expect(windows).toEqual([
      ["2026-11-05T10:00:00Z", "2026-11-05T10:15:00Z", "24h", "production"],
      ["2026-11-05T10:15:00Z", "2026-11-05T10:30:00Z", "24h", "production"],
      ["2026-11-05T10:30:00Z", "2026-11-05T10:45:00Z", "24h", "production"],
    ]);
  });
  it("keeps the whole range when a bucket's width is unknown", () => {
    expect(bucketHrefs("shop", { range: "1h" }, [{ ts: ts(0) }])).toEqual(["/project/shop/explore?range=1h"]);
    expect(bucketHrefs("shop", { range: "1h" }, [{ ts: "nope" }, { ts: ts(5) }])[0]).toBe("/project/shop/explore?range=1h");
    expect(bucketHrefs("shop", { range: "1h" }, [])).toEqual([]);
  });
});
