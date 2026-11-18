import { describe, expect, it } from "vitest";
import {
  consumerIdentificationUrl,
  errorRates,
  errorsHref,
  errorsScopeText,
  formatPerHour,
  formatRateTop,
  isErrorCode,
  markExpectedError,
  parseErrorsQuery,
  rateTop,
  reasonPhrase,
  seenAgo,
  statusClass,
  withExpectedCode,
} from "./errors";

describe("parseErrorsQuery", () => {
  it("reads the defaults from an empty query", () => {
    expect(parseErrorsQuery({})).toEqual({ tab: "status", range: "24h", env: "", code: null, view: "summary", page: 1, per: 25, dpage: 1, dper: 10 });
  });

  it("reads every known value", () => {
    expect(parseErrorsQuery({ tab: "issues", range: "7d", env: " production ", code: "404", view: "details" })).toEqual({
      tab: "issues",
      range: "7d",
      env: "production",
      code: 404,
      view: "details",
      page: 1,
      per: 25,
      dpage: 1,
      dper: 10,
    });
  });

  it("reads the table's and the modal's page", () => {
    expect(parseErrorsQuery({ page: "3", per: "50", dpage: "2", dper: "25" })).toMatchObject({ page: 3, per: 50, dpage: 2, dper: 25 });
    expect(parseErrorsQuery({ page: "0", per: "7", dpage: "x", dper: "100" })).toMatchObject({ page: 1, per: 25, dpage: 1, dper: 10 });
  });

  it("falls back on anything unknown", () => {
    expect(parseErrorsQuery({ tab: "x", range: "30d", env: "e".repeat(65), code: "200", view: "x" })).toEqual({ tab: "status", range: "24h", env: "", code: null, view: "summary", page: 1, per: 25, dpage: 1, dper: 10 });
    expect(parseErrorsQuery({ code: "4041" }).code).toBeNull();
    expect(parseErrorsQuery({ code: "6xx" }).code).toBeNull();
    expect(parseErrorsQuery({ code: ["503", "404"] }).code).toBe(503);
  });
});

describe("errorsHref", () => {
  it("leaves defaults out", () => {
    expect(errorsHref("shop", {})).toBe("/project/shop/errors");
    expect(errorsHref("shop", { tab: "status", range: "24h", env: "", code: null, view: "summary" })).toBe("/project/shop/errors?range=24h&env=all");
  });

  it("keeps the scope and the open status code", () => {
    expect(errorsHref("shop", { range: "1h", env: "staging", code: 404, view: "consumers" })).toBe("/project/shop/errors?range=1h&env=staging&code=404&view=consumers");
    expect(errorsHref("shop", { code: 500, view: "summary" })).toBe("/project/shop/errors?code=500");
  });

  it("drops the modal on the Issues tab, and a view without a code", () => {
    expect(errorsHref("shop", { tab: "issues", code: 404, view: "details" })).toBe("/project/shop/errors?tab=issues");
    expect(errorsHref("shop", { view: "details" })).toBe("/project/shop/errors");
  });

  it("keeps the pages, the modal's only with the modal", () => {
    expect(errorsHref("shop", { page: 2, per: 50, code: 404, dpage: 3, dper: 25 })).toBe("/project/shop/errors?page=2&per=50&code=404&dpage=3&dper=25");
    expect(errorsHref("shop", { page: 1, per: 25, dpage: 3 })).toBe("/project/shop/errors");
  });

  it("round-trips through parseErrorsQuery", () => {
    const q = { tab: "status" as const, range: "6h" as const, env: "prod eu", code: 422, view: "details" as const, page: 2, per: 50, dpage: 3, dper: 25 };
    const url = new URL(errorsHref("shop", q), "http://x");
    expect(parseErrorsQuery(Object.fromEntries(url.searchParams))).toEqual(q);
  });
});

describe("copy and formatting", () => {
  it("names the scope", () => {
    expect(errorsScopeText({ range: "1h", env: "" })).toBe("the last 1 hour");
    expect(errorsScopeText({ range: "7d", env: "production" })).toBe("the last 7 days in production");
  });

  it("classes and names status codes", () => {
    expect(statusClass(404)).toBe("4xx");
    expect(statusClass(503)).toBe("5xx");
    expect(reasonPhrase(404)).toBe("Not Found");
    expect(reasonPhrase(499)).toBe("");
    expect(isErrorCode(400)).toBe(true);
    expect(isErrorCode(599)).toBe(true);
    expect(isErrorCode(399)).toBe(false);
    expect(isErrorCode(404.5)).toBe(false);
    expect(isErrorCode("404")).toBe(false);
  });

  it("formats a frequency per hour", () => {
    expect(formatPerHour(0)).toBe("0");
    expect(formatPerHour(0.04)).toBe("<0.1");
    expect(formatPerHour(2)).toBe("2");
    expect(formatPerHour(2.44)).toBe("2.4");
    expect(formatPerHour(1234.4)).toBe("1,234");
  });

  it("answers a sentence for each failure", () => {
    expect(markExpectedError("forbidden")).toBe("Only project admins can mark status codes as expected.");
    expect(markExpectedError("too_many")).toMatch(/32 expected status codes/);
    expect(markExpectedError("whatever")).toBe("Something went wrong. Try again in a moment.");
  });
});

describe("withExpectedCode", () => {
  it("adds the code, sorted, keeping the other settings", () => {
    expect(withExpectedCode({ expected_status_codes: [409, 401], latency_threshold_ms: 250, excluded: true }, 404)).toEqual({
      expected_status_codes: [401, 404, 409],
      latency_threshold_ms: 250,
      excluded: true,
    });
    expect(withExpectedCode({ expected_status_codes: null, latency_threshold_ms: null, excluded: false }, 404)).toEqual({
      expected_status_codes: [404],
      latency_threshold_ms: null,
      excluded: false,
    });
  });

  it("answers null when the code already is expected", () => {
    expect(withExpectedCode({ expected_status_codes: [404], latency_threshold_ms: null, excluded: false }, 404)).toBeNull();
  });
});

describe("since when and for whom (#1002)", () => {
  const now = Date.parse("2026-11-18T12:00:00Z");
  const before = (ms: number) => new Date(now - ms).toISOString();

  it("says how long ago an error was seen", () => {
    expect(seenAgo(before(20_000), "UTC", now)).toBe("just now");
    expect(seenAgo(before(5 * 60_000), "UTC", now)).toBe("5 min ago");
    expect(seenAgo(before(3 * 3_600_000 + 59 * 60_000), "UTC", now)).toBe("3 h ago");
    expect(seenAgo(before(26 * 3_600_000), "UTC", now)).toBe("1 day ago");
    expect(seenAgo(before(12 * 86_400_000), "UTC", now)).toBe("12 days ago");
    // A time ahead of the clock (skew) is "just now", never "-3 min ago".
    expect(seenAgo(new Date(now + 180_000).toISOString(), "UTC", now)).toBe("just now");
    expect(seenAgo("not a time", "UTC", now)).toBe("");
  });

  it("names the day, in the user's zone, from 30 days back", () => {
    // 2026-10-01 20:00 UTC is already Oct 2 in Kolkata (UTC+5:30).
    expect(seenAgo("2026-10-01T20:00:00Z", "UTC", now)).toBe("Oct 1, 2026");
    expect(seenAgo("2026-10-01T20:00:00Z", "Asia/Kolkata", now)).toBe("Oct 2, 2026");
  });

  it("computes each bucket's error rate and a round scale top for it", () => {
    const rates = errorRates([
      { requests: 200, client_errors: 6, server_errors: 2 },
      { requests: 0, client_errors: 0, server_errors: 0 },
      { requests: 100, client_errors: 0, server_errors: 3 },
    ]);
    expect(rates).toEqual([0.04, 0, 0.03]);
    expect(rateTop(rates)).toBe(0.05);
    expect(rateTop([])).toBe(0.01);
    expect(rateTop([0.003])).toBe(0.01);
    expect(rateTop([0.3, Number.NaN])).toBe(0.5);
    expect(rateTop([1])).toBe(1);
    expect(formatRateTop(0.05)).toBe("5%");
    expect(formatRateTop(0.25)).toBe("25%");
    expect(formatRateTop(1)).toBe("100%");
  });

  it("links the consumer identification docs", () => {
    expect(consumerIdentificationUrl("https://apilens.ai/docs/")).toBe("https://apilens.ai/docs/sdk-reference/consumers");
  });
});
