import { describe, expect, it } from "vitest";
import { errorsHref, errorsScopeText, formatPerHour, isErrorCode, markExpectedError, parseErrorsQuery, reasonPhrase, statusClass, withExpectedCode } from "./errors";

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
    expect(errorsHref("shop", {})).toBe("/shop/errors");
    expect(errorsHref("shop", { tab: "status", range: "24h", env: "", code: null, view: "summary" })).toBe("/shop/errors");
  });

  it("keeps the scope and the open status code", () => {
    expect(errorsHref("shop", { range: "1h", env: "staging", code: 404, view: "consumers" })).toBe("/shop/errors?range=1h&env=staging&code=404&view=consumers");
    expect(errorsHref("shop", { code: 500, view: "summary" })).toBe("/shop/errors?code=500");
  });

  it("drops the modal on the Issues tab, and a view without a code", () => {
    expect(errorsHref("shop", { tab: "issues", code: 404, view: "details" })).toBe("/shop/errors?tab=issues");
    expect(errorsHref("shop", { view: "details" })).toBe("/shop/errors");
  });

  it("keeps the pages, the modal's only with the modal", () => {
    expect(errorsHref("shop", { page: 2, per: 50, code: 404, dpage: 3, dper: 25 })).toBe("/shop/errors?page=2&per=50&code=404&dpage=3&dper=25");
    expect(errorsHref("shop", { page: 1, per: 25, dpage: 3 })).toBe("/shop/errors");
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
