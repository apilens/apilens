import { describe, expect, it } from "vitest";
import { exploreHref, parseExploreQuery, requestsPath } from "./explore";
import {
  type ExploreFilters,
  FILTER_KEYS,
  NO_FILTERS,
  activeCount,
  filterChips,
  filterEntries,
  filterQuery,
  fromDraft,
  normalizeStatus,
  parseFilters,
  sameFilters,
  toDraft,
  withoutChip,
} from "./explore-filters";

const ALL: ExploreFilters = {
  env: "production",
  method: "POST",
  status: "4xx,500-503",
  path: "/orders/{id}",
  url_contains: "?expand=items&x=1",
  payload_contains: "card declined",
  consumer_id: "c_acme",
  consumer_group: "Enterprise plan",
  ip: "203.0.113.7",
  request_size_min: 10,
  request_size_max: 2048,
  response_size_min: 0,
  response_size_max: 1000000,
  latency_min: 100.5,
  latency_max: 2000,
  sampled: "false",
};

/** Search params of an href, as Next.js hands them to the page. */
const paramsOf = (href: string) => Object.fromEntries(new URL(href, "http://x").searchParams);

describe("normalizeStatus", () => {
  it("reads codes, classes and ranges, normalised", () => {
    expect(normalizeStatus("404")).toBe("404");
    expect(normalizeStatus(" 4XX , 500 - 503 ,, 200")).toBe("4xx,500-503,200");
    expect(normalizeStatus("1xx,5xx")).toBe("1xx,5xx");
    expect(normalizeStatus("500-500")).toBe("500-500");
  });
  it("treats empty and all as no filter", () => {
    expect(normalizeStatus("")).toBe("");
    expect(normalizeStatus("  ALL ")).toBe("");
  });
  it("refuses what the API would refuse", () => {
    for (const bad of ["6xx", "99", "600", "abc", "503-500", "500-", "-500", "500-501-502", "4x", ",", Array(21).fill("200").join(",")]) {
      expect(normalizeStatus(bad), bad).toBeNull();
    }
    expect(normalizeStatus(Array(20).fill("200").join(","))).not.toBeNull();
  });
});

describe("parseFilters", () => {
  it("has no filters by default", () => {
    expect(parseFilters({})).toEqual(NO_FILTERS);
    expect(activeCount(NO_FILTERS)).toBe(0);
    expect(filterEntries(NO_FILTERS)).toEqual([]);
  });
  it("reads every filter", () => {
    const params = Object.fromEntries(filterEntries(ALL));
    expect(parseFilters(params)).toEqual(ALL);
  });
  it("takes the first of repeated params and trims text", () => {
    expect(parseFilters({ env: ["  staging ", "prod"], path: " /a " })).toEqual({ ...NO_FILTERS, env: "staging", path: "/a" });
  });
  it("upper-cases the method and drops one that is not letters", () => {
    expect(parseFilters({ method: "post" }).method).toBe("POST");
    expect(parseFilters({ method: "GET;" }).method).toBe("");
    expect(parseFilters({ method: "A".repeat(17) }).method).toBe("");
  });
  it("drops invalid status, bounds and sampled values", () => {
    const f = parseFilters({
      status: "9xx",
      request_size_min: "-1",
      request_size_max: "1.5",
      response_size_min: "1e3",
      latency_min: "abc",
      latency_max: "Infinity",
      sampled: "yes",
    });
    expect(f).toEqual(NO_FILTERS);
  });
  it("keeps zero bounds and fractional latency", () => {
    const f = parseFilters({ request_size_max: "0", latency_min: "0.25", latency_max: "0" });
    expect(f.request_size_max).toBe(0);
    expect(f.latency_min).toBe(0.25);
    expect(f.latency_max).toBe(0);
  });
  it("drops text longer than the API takes", () => {
    expect(parseFilters({ env: "e".repeat(65), ip: "1".repeat(64) })).toEqual({ ...NO_FILTERS, ip: "1".repeat(64) });
  });
});

describe("the URL round trip", () => {
  it("a deep link reproduces the exact filtered view", () => {
    const q = { range: "6h" as const, filters: ALL };
    const href = exploreHref("my shop", q);
    expect(href.startsWith("/my%20shop/explore?range=6h&env=production&method=POST&status=4xx%2C500-503&")).toBe(true);
    expect(parseExploreQuery(paramsOf(href))).toEqual(q);
    // The same link, built again, is byte-for-byte the same.
    expect(exploreHref("my shop", parseExploreQuery(paramsOf(href)))).toBe(href);
  });
  it("lists the filters in a fixed order whatever the input order", () => {
    const href = exploreHref("shop", parseExploreQuery({ sampled: "true", env: "prod", latency_max: "50" }));
    expect(href).toBe("/shop/explore?env=prod&latency_max=50&sampled=true");
  });
  it("round-trips each filter alone", () => {
    for (const k of FILTER_KEYS) {
      const filters = { ...NO_FILTERS, [k]: ALL[k] } as ExploreFilters;
      const href = exploreHref("shop", { range: "1h", filters });
      expect(parseExploreQuery(paramsOf(href)), k).toEqual({ range: "1h", filters });
    }
  });
  it("escapes text that looks like URL syntax", () => {
    const filters = { ...NO_FILTERS, url_contains: "a&b=c#d%", payload_contains: "“quotes” + spaces" };
    const href = exploreHref("shop", { range: "1h", filters });
    expect(parseExploreQuery(paramsOf(href)).filters).toEqual(filters);
  });
  it("polls the Route Handler with the range and the same filters", () => {
    expect(requestsPath("shop", { range: "1h" })).toBe("/api/projects/shop/requests?range=1h");
    const path = requestsPath("shop", { range: "24h", filters: { ...NO_FILTERS, status: "5xx", sampled: "true" } });
    expect(path).toBe("/api/projects/shop/requests?range=24h&status=5xx&sampled=true");
    expect(parseExploreQuery(paramsOf(path))).toEqual({ range: "24h", filters: { ...NO_FILTERS, status: "5xx", sampled: "true" } });
  });
  it("hands the API only the filters that are on, by their API names", () => {
    expect(filterQuery({ ...NO_FILTERS, ip: "10.0.0.1", latency_min: 0 })).toEqual({ ip: "10.0.0.1", latency_min: "0" });
  });
});

describe("filterChips / withoutChip", () => {
  it("names each active filter, with a min/max pair as one chip", () => {
    expect(filterChips(ALL).map((c) => c.label)).toEqual([
      "Environment production",
      "Method POST",
      "Status 4xx, 500-503",
      "Path /orders/{id}",
      "URL contains “?expand=items&x=1”",
      "Payload contains “card declined”",
      "Consumer c_acme",
      "Group Enterprise plan",
      "IP 203.0.113.7",
      "Request size 10 B to 2.0 KB",
      "Response size 0 B to 1.0 MB",
      "Latency 100.5 ms to 2000 ms",
      "Sampled out",
    ]);
    expect(activeCount(ALL)).toBe(13);
  });
  it("reads open-ended ranges", () => {
    const labels = filterChips({ ...NO_FILTERS, latency_min: 500, response_size_max: 0, sampled: "true" }).map((c) => c.label);
    expect(labels).toEqual(["Response size ≤ 0 B", "Latency ≥ 500 ms", "Kept in full"]);
  });
  it("removes a chip's filters and nothing else", () => {
    const latency = filterChips(ALL).find((c) => c.id === "latency");
    expect(latency?.keys).toEqual(["latency_min", "latency_max"]);
    const next = withoutChip(ALL, latency as NonNullable<typeof latency>);
    expect(next).toEqual({ ...ALL, latency_min: null, latency_max: null });
    expect(ALL.latency_min).toBe(100.5);
  });
});

describe("the edit form", () => {
  it("round-trips through a draft", () => {
    const r = fromDraft(toDraft(ALL));
    expect(r).toEqual({ ok: true, filters: ALL });
    expect(fromDraft(toDraft(NO_FILTERS))).toEqual({ ok: true, filters: NO_FILTERS });
  });
  it("normalises what was typed", () => {
    const r = fromDraft({ ...toDraft(NO_FILTERS), status: "5XX, 404", method: "get", path: "  /x  " });
    expect(r).toEqual({ ok: true, filters: { ...NO_FILTERS, status: "5xx,404", method: "GET", path: "/x" } });
  });
  it("names each invalid field", () => {
    const r = fromDraft({ ...toDraft(NO_FILTERS), status: "abc", request_size_min: "1.5", latency_max: "-3", method: "G1", ip: "1".repeat(65) });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(Object.keys(r.errors).sort()).toEqual(["ip", "latency_max", "method", "request_size_min", "status"]);
  });
  it("refuses a maximum below the minimum", () => {
    const r = fromDraft({ ...toDraft(NO_FILTERS), latency_min: "500", latency_max: "100" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toEqual({ latency_max: "The maximum is below the minimum." });
    expect(fromDraft({ ...toDraft(NO_FILTERS), latency_min: "100", latency_max: "100" }).ok).toBe(true);
  });
  it("compares filters by value", () => {
    expect(sameFilters(ALL, { ...ALL })).toBe(true);
    expect(sameFilters(ALL, { ...ALL, latency_max: 2001 })).toBe(false);
  });
});
