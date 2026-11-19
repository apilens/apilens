import { describe, expect, it } from "vitest";
import {
  EXPLORE_RANGES,
  apiConds,
  apiQuery,
  apiWindow,
  bucketFor,
  clearField,
  compactCount,
  condString,
  condWords,
  exploreUrl,
  hasLegacy,
  isoToZonedInput,
  legacyConds,
  levelOf,
  makeCond,
  onlyValue,
  parseCond,
  readExploreUrl,
  queryEntries,
  rangeText,
  routeSearch,
  shownClasses,
  statusHit,
  ticked,
  toggleValue,
  typedCond,
  typedTime,
  parseDuration,
  parseRange,
  presetOf,
  rangeMs,
  rangeOfMs,
  rangeWords,
  zonedInputToIso,
} from "./explore-query";

describe("time ranges (the sidebar's Time Range)", () => {
  it("reads durations as Supabase's date picker does", () => {
    expect(parseDuration("2h")).toEqual({ range: "2h", ms: 7_200_000, words: "Last 2 hours" });
    expect(parseDuration("last 30m")).toEqual({ range: "30m", ms: 1_800_000, words: "Last 30 minutes" });
    expect(parseDuration("1 day")).toEqual({ range: "24h", ms: 86_400_000, words: "Last 24 hours" });
    expect(parseDuration("60 minutes")).toEqual({ range: "1h", ms: 3_600_000, words: "Last 60 minutes" });
    expect(parseDuration("7d")?.range).toBe("7d");
    expect(parseDuration("8d")).toBeNull();
    expect(parseDuration("0h")).toBeNull();
    expect(parseDuration("soon")).toBeNull();
    expect(presetOf(3_600_000)).toBe("1h");
    expect(presetOf(10 * 60_000)).toBe("10m");
    expect(presetOf(7_200_000)).toBeNull();
  });

  it("offers Supabase's presets up to the API's 7 days, in its words", () => {
    expect(EXPLORE_RANGES.map((r) => `Last ${rangeWords(r)}`)).toEqual(["Last 10 minutes", "Last 30 minutes", "Last 60 minutes", "Last 3 hours", "Last 24 hours", "Last 7 days"]);
    expect(rangeWords("15m")).toBe("15 minutes");
    expect(rangeWords("2d")).toBe("2 days");
  });

  it("normalises tokens", () => {
    expect(rangeOfMs(60 * 60_000)).toBe("1h");
    expect(rangeOfMs(90 * 60_000)).toBe("90m");
    expect(rangeOfMs(86_400_000)).toBe("24h");
    expect(rangeOfMs(2 * 86_400_000)).toBe("2d");
    expect(rangeOfMs(30 * 86_400_000)).toBe("7d");
    expect(rangeMs("3h")).toBe(3 * 3_600_000);
    expect(rangeMs("7d")).toBe(7 * 86_400_000);
  });

  it("parses ?range= values, old links included", () => {
    expect(parseRange("7d")).toBe("7d");
    expect(parseRange("15m")).toBe("15m");
    expect(parseRange("6h")).toBe("6h");
    expect(parseRange("60m")).toBe("1h");
    expect(parseRange("30d")).toBe("7d");
    expect(parseRange("0h")).toBeNull();
    expect(parseRange("1y")).toBeNull();
    expect(parseRange(undefined)).toBeNull();
  });

  it("turns time: and date: into a range", () => {
    expect(typedTime("time:24h")).toEqual({ range: "24h" });
    expect(typedTime("date = last 15m")).toEqual({ range: "15m" });
    expect(typedTime("time:2h")).toEqual({ range: "2h" });
    expect(typedTime("path:/time")).toBeNull();
    expect(typedTime("time:forever")).toBeNull();
  });
});

describe("?range= links (the Last 1 hour bug)", () => {
  it("honours every range a link can carry", () => {
    for (const r of ["10m", "15m", "30m", "1h", "3h", "6h", "24h", "7d"]) expect(readExploreUrl({ range: r }).range).toBe(r);
    expect(rangeText(readExploreUrl({ range: "7d" }), "UTC")).toBe("Last 7 days");
    expect(readExploreUrl({ range: "30d" }).range).toBe("7d");
    expect(readExploreUrl({ range: "nope" }).range).toBe("24h");
  });

  it("keeps the range through the page URL and the route handlers", () => {
    const q = readExploreUrl({ range: "7d" });
    expect(exploreUrl("shop", q)).toBe("/project/shop/explore?range=7d");
    expect(routeSearch(q)).toBe("?range=7d");
    expect(readExploreUrl(Object.fromEntries(new URLSearchParams(routeSearch(q).slice(1)))).range).toBe("7d");
  });
});

const APP = "5d0c1b2a-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
const c = (s: string) => {
  const x = parseCond(s);
  if (!x) throw new Error(`bad cond ${s}`);
  return x;
};

describe("parseCond", () => {
  it("reads field:op:value, values with colons included", () => {
    expect(parseCond("status:eq:4XX")).toEqual({ field: "status", op: "eq", value: "4xx" });
    expect(parseCond("path:contains:/a:b")).toEqual({ field: "path", op: "contains", value: "/a:b" });
    expect(parseCond("method:neq:get")).toEqual({ field: "method", op: "neq", value: "GET" });
    expect(parseCond(`app:eq:${APP.toUpperCase()}`)).toEqual({ field: "app", op: "eq", value: APP });
    expect(parseCond("latency:between:100 - 500")).toEqual({ field: "latency", op: "between", value: "100-500" });
  });

  it("refuses what the API would", () => {
    for (const bad of ["status", "status:eq", "status:eq:", "nope:eq:1", "method:contains:G", "status:eq:6xx", "app:eq:shop", "latency:between:9-1", "request_size:gt:1.5", "sampled:eq:maybe", "payload:eq:x"]) {
      expect(parseCond(bad), bad).toBeNull();
    }
  });
});

describe("legacyConds", () => {
  it("translates every older filter parameter", () => {
    const got = legacyConds({
      env: "production",
      app: APP,
      method: "post",
      status: "4xx,500-503",
      path: "/orders/{id}",
      q: "charge",
      url_contains: "expand",
      payload_contains: "sku",
      consumer_id: "c_acme",
      consumer_group: "pro",
      ip: "10.0.0.1",
      trace_id: "abc",
      latency_min: "100",
      latency_max: "500",
      request_size_min: "10",
      response_size_max: "2048",
      sampled: "false",
    }).map(condString);
    expect(got).toEqual([
      "env:eq:production",
      `app:eq:${APP}`,
      "method:eq:POST",
      "status:eq:4xx",
      "status:eq:500-503",
      "path:eq:/orders/{id}",
      "path:contains:charge",
      "url:contains:expand",
      "payload:contains:sku",
      "consumer:eq:c_acme",
      "consumer_group:eq:pro",
      "ip:eq:10.0.0.1",
      "trace_id:eq:abc",
      "request_size:gt:10",
      "response_size:lt:2048",
      "latency:between:100-500",
      "sampled:eq:false",
    ]);
  });

  it("drops values the API would refuse", () => {
    expect(legacyConds({ status: "6xx", app: "shop", method: "G T", latency_min: "-1" })).toEqual([]);
  });

  it("knows a legacy link", () => {
    expect(hasLegacy({ status: "5xx" })).toBe(true);
    expect(hasLegacy({ request: "req_1" })).toBe(true);
    expect(hasLegacy({ filter: "status:eq:5xx", range: "24h" })).toBe(false);
  });
});

describe("readExploreUrl and exploreUrl", () => {
  it("round-trips the state", () => {
    const q = readExploreUrl({ range: "1h", filter: ["status:eq:5xx", "path:contains:/orders"], id: "req_1" });
    expect(q).toEqual({ range: "1h", conds: [c("status:eq:5xx"), c("path:contains:/orders")], id: "req_1" });
    const url = exploreUrl("shop", q);
    expect(url).toBe("/project/shop/explore?range=1h&filter=status%3Aeq%3A5xx&filter=path%3Acontains%3A%2Forders&id=req_1");
    const back = Object.fromEntries([...new URL(url, "http://x").searchParams.keys()].map((k) => [k, new URL(url, "http://x").searchParams.getAll(k)]));
    expect(readExploreUrl(back)).toEqual(q);
  });

  it("redirects an older link to the same view", () => {
    const q = readExploreUrl({ range: "1h", status: "5xx", env: "production", at: "2026-11-05T10:10:00Z", request: "req_charge" });
    expect(exploreUrl("shop", q)).toBe("/project/shop/explore?range=1h&to=2026-11-05T10%3A10%3A00Z&filter=env%3Aeq%3Aproduction&filter=status%3Aeq%3A5xx&id=req_charge");
  });

  it("leaves defaults out and drops a reversed window", () => {
    expect(queryEntries(readExploreUrl({ range: "24h", from: "2026-11-05T11:00:00Z", to: "2026-11-05T10:00:00Z" }))).toEqual([]);
    expect(readExploreUrl({ range: "1y" }).range).toBe("24h");
    // 24 hours is the default and left out; the last hour is written.
    expect(readExploreUrl({}).range).toBe("24h");
    expect(exploreUrl("shop", { range: "24h", conds: [] })).toBe("/project/shop/explore");
    expect(exploreUrl("shop", { range: "1h", conds: [] })).toBe("/project/shop/explore?range=1h");
    // A window with an end only reaches back by its range, so the range stays.
    expect(queryEntries({ range: "1h", to: "2026-11-05T10:00:00Z" })).toEqual([["range", "1h"], ["to", "2026-11-05T10:00:00Z"]]);
    expect(queryEntries({ range: "1h", from: "2026-11-05T09:00:00Z", to: "2026-11-05T10:00:00Z" })).toEqual([["from", "2026-11-05T09:00:00Z"], ["to", "2026-11-05T10:00:00Z"]]);
    expect(readExploreUrl({ id: "../x" }).id).toBeUndefined();
  });

  it("dedupes conditions", () => {
    expect(readExploreUrl({ filter: ["status:eq:5xx", "status:eq:5XX"], status: "5xx" }).conds).toEqual([c("status:eq:5xx")]);
  });
});

describe("apiWindow and bucketFor", () => {
  const now = Date.parse("2026-11-05T12:00:30Z");
  it("reads a range the API lacks as the end of the smallest API range holding it", () => {
    expect(apiWindow({ range: "15m" }, now)).toEqual({ range: "1h", from: "2026-11-05T11:45:30Z" });
    expect(apiWindow({ range: "10m" }, now)).toEqual({ range: "1h", from: "2026-11-05T11:50:30Z" });
    expect(apiWindow({ range: "3h" }, now)).toEqual({ range: "6h", from: "2026-11-05T09:00:30Z" });
    expect(apiWindow({ range: "6h" }, now)).toEqual({ range: "6h" });
    expect(apiWindow({ range: "7d" }, now)).toEqual({ range: "7d" });
  });

  it("picks the smallest range holding a custom window", () => {
    expect(apiWindow({ range: "1h", from: "2026-11-05T02:00:00Z", to: "2026-11-05T03:00:00Z" }, now)).toEqual({ range: "24h", from: "2026-11-05T02:00:00Z", to: "2026-11-05T03:00:00Z" });
    expect(apiWindow({ range: "1h", from: "2026-10-01T00:00:00Z" }, now).range).toBe("7d");
    expect(apiWindow({ range: "1h", to: "2026-11-05T11:00:00Z" }, now)).toEqual({ range: "6h", from: "2026-11-05T10:00:00Z", to: "2026-11-05T11:00:00Z" });
  });

  it("buckets by minute under 12h, hour under 2d, day beyond", () => {
    expect(bucketFor({ range: "6h" }, now)).toBe("minute");
    expect(bucketFor({ range: "24h" }, now)).toBe("hour");
    expect(bucketFor({ range: "7d" }, now)).toBe("day");
  });

  it("sends the conditions as filter values", () => {
    expect(apiQuery({ range: "24h", conds: [c("method:neq:GET")] }, now)).toEqual({ range: "24h", filter: ["method:neq:GET"] });
    expect(routeSearch({ range: "24h", conds: [c("method:neq:GET")] }, { cursor: "x" })).toBe("?filter=method%3Aneq%3AGET&cursor=x");
    expect(routeSearch({ range: "1h", conds: [] })).toBe("?range=1h");
  });
});

describe("facets and pills", () => {
  const conds = [c("status:eq:4xx"), c("method:eq:GET"), c("status:neq:404")];
  it("ticks, unticks and picks only one value", () => {
    expect(ticked(conds, "status")).toEqual(["4xx"]);
    expect(toggleValue(conds, "status", "5xx", true).map(condString)).toEqual(["status:eq:4xx", "method:eq:GET", "status:neq:404", "status:eq:5xx"]);
    expect(toggleValue(conds, "status", "404", true).map(condString)).toEqual(["status:eq:4xx", "method:eq:GET", "status:eq:404"]);
    expect(toggleValue(conds, "status", "4xx", false).map(condString)).toEqual(["method:eq:GET", "status:neq:404"]);
    expect(onlyValue(conds, "status", "500").map(condString)).toEqual(["method:eq:GET", "status:eq:500"]);
    expect(clearField(conds, "status").map(condString)).toEqual(["method:eq:GET"]);
  });

  it("names a pill", () => {
    expect(condWords(c(`app:neq:${APP}`), { app: () => "Shop" })).toBe("App is not Shop");
    expect(condWords(c("latency:between:100-500"))).toBe("Latency between 100–500 ms");
  });

  it("drops chart layers the status filter leaves out", () => {
    expect([...shownClasses([])]).toEqual(["2xx", "4xx", "5xx"]);
    expect([...shownClasses([c("status:eq:404")])]).toEqual(["4xx"]);
    expect([...shownClasses([c("status:eq:200"), c("status:eq:500-503")])]).toEqual(["2xx", "5xx"]);
    expect([...shownClasses([c("status:neq:5xx")])]).toEqual(["2xx", "4xx"]);
    expect([...shownClasses([c("status:neq:500")])]).toEqual(["2xx", "4xx", "5xx"]);
  });

  it("reads level conditions, Supabase's three levels", () => {
    expect(parseCond("level:eq:Warning")).toEqual({ field: "level", op: "eq", value: "warning" });
    expect(parseCond("level:eq:info")).toBeNull();
    expect(parseCond("level:contains:err")).toBeNull();
    expect(typedCond("level:error")).toEqual(c("level:eq:error"));
    expect([levelOf(101), levelOf(204), levelOf(301), levelOf(404), levelOf(503)]).toEqual(["success", "success", "success", "warning", "error"]);
  });

  it("sends a level to the API as status exclusions, ANDed with status conditions", () => {
    expect(apiConds([c("level:eq:warning")]).map(condString)).toEqual(["status:neq:1xx,2xx,3xx", "status:neq:5xx"]);
    expect(apiConds([c("level:eq:success"), c("level:eq:error"), c("method:eq:GET")]).map(condString)).toEqual(["method:eq:GET", "status:neq:4xx"]);
    expect(apiConds([c("level:eq:success"), c("level:eq:warning"), c("level:eq:error")])).toEqual([]);
    expect(apiConds([c("level:neq:error"), c("status:eq:200")]).map(condString)).toEqual(["status:eq:200", "status:neq:5xx"]);
    expect(apiQuery({ range: "1h", conds: [c("level:eq:error")] }, 0).filter).toEqual(["status:neq:1xx,2xx,3xx", "status:neq:4xx"]);
    // The URL keeps the level, as the page reads it back.
    expect(routeSearch({ range: "24h", conds: [c("level:eq:error")] })).toBe("?filter=level%3Aeq%3Aerror");
    // Older status links are untouched.
    expect(apiConds([c("status:eq:4xx")]).map(condString)).toEqual(["status:eq:4xx"]);
  });

  it("matches a code against status and level conditions", () => {
    expect(statusHit(404, [])).toBe(true);
    expect(statusHit(404, [c("level:eq:warning")])).toBe(true);
    expect(statusHit(200, [c("level:eq:warning")])).toBe(false);
    expect(statusHit(302, [c("level:eq:success")])).toBe(true);
    expect(statusHit(503, [c("status:eq:500-502")])).toBe(false);
    expect(statusHit(404, [c("status:eq:5xx"), c("status:eq:404")])).toBe(true);
    expect(statusHit(404, [c("status:eq:4xx"), c("status:neq:404")])).toBe(false);
  });

  it("drops chart layers a level leaves out", () => {
    expect([...shownClasses([c("level:eq:error")])]).toEqual(["5xx"]);
    expect([...shownClasses([c("level:neq:success")])]).toEqual(["4xx", "5xx"]);
  });

  it("formats counts compactly", () => {
    expect(compactCount(950)).toBe("950");
    expect(compactCount(1234)).toBe("1.2k");
    expect(compactCount(12_300)).toBe("12k");
    expect(compactCount(3_400_000)).toBe("3.4M");
    expect(compactCount(1000)).toBe("1k");
  });
});

describe("typedCond", () => {
  it("reads field, operator and value", () => {
    expect(typedCond("status:500")).toEqual(c("status:eq:500"));
    expect(typedCond("method != get")).toEqual(c("method:neq:GET"));
    expect(typedCond("latency > 500")).toEqual(c("latency:gt:500"));
    expect(typedCond("latency 100-500")).toEqual(c("path:contains:latency 100-500"));
    expect(typedCond("latency=100-500")).toEqual(c("latency:between:100-500"));
    expect(typedCond("consumer ~ acme")).toEqual(c("consumer:contains:acme"));
    expect(typedCond("environment=staging")).toEqual(c("env:eq:staging"));
  });

  it("makes other text a path contains", () => {
    expect(typedCond("/orders")).toEqual(c("path:contains:/orders"));
    expect(typedCond("checkout flow")).toEqual(c("path:contains:checkout flow"));
    expect(typedCond("  ")).toBeNull();
  });
});

describe("custom range", () => {
  it("converts a wall time in the zone and back", () => {
    expect(zonedInputToIso("2026-11-05T10:30", "Asia/Kolkata")).toBe("2026-11-05T05:00:00Z");
    expect(zonedInputToIso("2026-11-05T10:30", "UTC")).toBe("2026-11-05T10:30:00Z");
    expect(zonedInputToIso("nope", "UTC")).toBeNull();
    expect(isoToZonedInput("2026-11-05T05:00:00Z", "Asia/Kolkata")).toBe("2026-11-05T10:30");
  });

  it("says the range", () => {
    expect(rangeText({ range: "1h" }, "UTC")).toBe("Last 60 minutes");
    expect(rangeText({ range: "1h", from: "2026-11-05T10:00:00Z", to: "2026-11-05T11:00:00Z" }, "UTC")).toBe("Nov 5, 10:00 – Nov 5, 11:00 UTC");
  });

  it("makes a condition from parts", () => {
    expect(makeCond("STATUS", "neq", "5XX")).toEqual(c("status:neq:5xx"));
    expect(makeCond("status", "contains", "5")).toBeNull();
  });
});
