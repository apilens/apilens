import { describe, expect, it } from "vitest";
import {
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
  makeCond,
  onlyValue,
  parseCond,
  readExploreUrl,
  queryEntries,
  rangeText,
  routeSearch,
  shownClasses,
  ticked,
  toggleValue,
  typedCond,
  zonedInputToIso,
} from "./explore-query";

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
    const q = readExploreUrl({ range: "24h", filter: ["status:eq:5xx", "path:contains:/orders"], id: "req_1" });
    expect(q).toEqual({ range: "24h", conds: [c("status:eq:5xx"), c("path:contains:/orders")], id: "req_1" });
    const url = exploreUrl("shop", q);
    expect(url).toBe("/project/shop/explore?range=24h&filter=status%3Aeq%3A5xx&filter=path%3Acontains%3A%2Forders&id=req_1");
    const back = Object.fromEntries([...new URL(url, "http://x").searchParams.keys()].map((k) => [k, new URL(url, "http://x").searchParams.getAll(k)]));
    expect(readExploreUrl(back)).toEqual(q);
  });

  it("redirects an older link to the same view", () => {
    const q = readExploreUrl({ range: "1h", status: "5xx", env: "production", at: "2026-11-05T10:10:00Z", request: "req_charge" });
    expect(exploreUrl("shop", q)).toBe("/project/shop/explore?to=2026-11-05T10%3A10%3A00Z&filter=env%3Aeq%3Aproduction&filter=status%3Aeq%3A5xx&id=req_charge");
  });

  it("leaves defaults out and drops a reversed window", () => {
    expect(queryEntries(readExploreUrl({ range: "1h", from: "2026-11-05T11:00:00Z", to: "2026-11-05T10:00:00Z" }))).toEqual([]);
    expect(readExploreUrl({ range: "1y" }).range).toBe("1h");
    expect(readExploreUrl({ id: "../x" }).id).toBeUndefined();
  });

  it("dedupes conditions", () => {
    expect(readExploreUrl({ filter: ["status:eq:5xx", "status:eq:5XX"], status: "5xx" }).conds).toEqual([c("status:eq:5xx")]);
  });
});

describe("apiWindow and bucketFor", () => {
  const now = Date.parse("2026-11-05T12:00:30Z");
  it("reads 15m as the end of the API's 1h", () => {
    expect(apiWindow({ range: "15m" }, now)).toEqual({ range: "1h", from: "2026-11-05T11:45:30Z" });
    expect(apiWindow({ range: "6h" }, now)).toEqual({ range: "6h" });
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
    expect(routeSearch({ range: "1h", conds: [c("method:neq:GET")] }, { cursor: "x" })).toBe("?filter=method%3Aneq%3AGET&cursor=x");
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
    expect(rangeText({ range: "1h" }, "UTC")).toBe("Last 1 hour");
    expect(rangeText({ range: "1h", from: "2026-11-05T10:00:00Z", to: "2026-11-05T11:00:00Z" }, "UTC")).toBe("Nov 5, 10:00 – Nov 5, 11:00 UTC");
  });

  it("makes a condition from parts", () => {
    expect(makeCond("STATUS", "neq", "5XX")).toEqual(c("status:neq:5xx"));
    expect(makeCond("status", "contains", "5")).toBeNull();
  });
});
