import { describe, expect, it } from "vitest";
import {
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
} from "./explore";
import { NO_FILTERS } from "./explore-filters";

describe("parseExploreQuery / exploreHref", () => {
  it("defaults to the last hour and leaves the default out of the URL", () => {
    expect(parseExploreQuery({})).toEqual({ range: "1h", filters: NO_FILTERS });
    expect(exploreHref("shop", { range: "1h" })).toBe("/shop/explore");
  });
  it("keeps a known range and drops an unknown one", () => {
    expect(parseExploreQuery({ range: "7d" })).toEqual({ range: "7d", filters: NO_FILTERS });
    expect(parseExploreQuery({ range: ["6h", "7d"] })).toEqual({ range: "6h", filters: NO_FILTERS });
    expect(parseExploreQuery({ range: "30d" })).toEqual({ range: "1h", filters: NO_FILTERS });
    expect(exploreHref("my shop", { range: "24h" })).toBe("/my%20shop/explore?range=24h");
  });
  it("polls the project's Route Handler with the range", () => {
    expect(requestsPath("shop", { range: "6h" })).toBe("/api/projects/shop/requests?range=6h");
    expect(scopeText({ range: "24h" })).toBe("the last 24 hours");
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
    expect(rowKey({ timestamp: "t", trace_id: "" }, 3)).toBe("t#3");
  });
});

describe("visibleWindow", () => {
  it("renders the rows in view plus overscan, never all 200", () => {
    const w = visibleWindow(0, 600, 200);
    expect(w).toEqual({ start: 0, end: 600 / ROW_HEIGHT + OVERSCAN });
    const mid = visibleWindow(4000, 600, 200);
    expect(mid).toEqual({ start: 100 - OVERSCAN, end: 100 + 15 + OVERSCAN });
    expect(mid.end - mid.start).toBeLessThan(40);
  });
  it("clamps to the row count", () => {
    expect(visibleWindow(7600, 600, 200)).toEqual({ start: 190 - OVERSCAN, end: 200 });
    expect(visibleWindow(99_999, 600, 10)).toEqual({ start: 10, end: 10 });
    expect(visibleWindow(0, 600, 0)).toEqual({ start: 0, end: 0 });
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

describe("logPoll", () => {
  it("reads rows", () => {
    expect(logPoll(200, { ok: true, requests: [{ method: "GET" }] })).toEqual({ kind: "rows", rows: [{ method: "GET" }] });
    expect(logPoll(200, { ok: true, requests: null })).toEqual({ kind: "rows", rows: [] });
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
