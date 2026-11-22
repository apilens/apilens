import { describe, expect, it } from "vitest";
import {
  windowRange,
  apdexRating,
  appName,
  appOptions,
  declaredLabel,
  endpointHref,
  formatApdex,
  formatLatency,
  latencyTop,
  lineY,
  linePath,
  parseAppParam,
  parseEndpointSearch,
  parseTrafficQuery,
  plotWidth,
  scopeText,
  searchEndpoints,
  splitDeclared,
  statusRows,
  trafficHref,
} from "./traffic";

const SHOP = "7f1c2a3b-4d5e-4f60-8a9b-0c1d2e3f4a5b";
const BILLING = "8a2d3b4c-5e6f-4a71-9bac-1d2e3f4a5b6c";

describe("parseTrafficQuery", () => {
  it("defaults to the last 24 hours in all environments", () => {
    expect(parseTrafficQuery({})).toEqual({ range: "24h", env: "", app: "", method: "", path: "", from: "", to: "", consumer: "", metrics: [], status: "" });
  });

  it("reads a known range and an environment", () => {
    expect(parseTrafficQuery({ range: "7d", env: "production" })).toEqual({ range: "7d", env: "production", app: "", method: "", path: "", from: "", to: "", consumer: "", metrics: [], status: "" });
    expect(parseTrafficQuery({ range: ["1h", "7d"], env: [" staging "] })).toEqual({ range: "1h", env: "staging", app: "", method: "", path: "", from: "", to: "", consumer: "", metrics: [], status: "" });
  });

  it("falls back on an unknown range or an environment name the API would refuse", () => {
    expect(parseTrafficQuery({ range: "30d", env: "x".repeat(65) })).toEqual({ range: "24h", env: "", app: "", method: "", path: "", from: "", to: "", consumer: "", metrics: [], status: "" });
  });

  it("reads the filter bar's method (upper case) and route template, refusing what the API would", () => {
    const q = parseTrafficQuery({ range: "24h", method: "post", path: "/orders/{id}" });
    expect([q.method, q.path]).toEqual(["POST", "/orders/{id}"]);
    const bad = parseTrafficQuery({ method: "GET; DROP", path: "orders" });
    expect([bad.method, bad.path]).toEqual(["", ""]);
    expect(parseTrafficQuery({ path: `/${"x".repeat(1024)}` }).path).toBe("");
  });

  it("reads a window picked on the chart: both ends, in order, at most 7 days apart", () => {
    const q = parseTrafficQuery({ range: "24h", from: "2026-11-21T17:00:00Z", to: "2026-11-21T22:00:00Z" });
    expect([q.from, q.to]).toEqual(["2026-11-21T17:00:00Z", "2026-11-21T22:00:00Z"]);
    expect(windowRange(q)).toBe("6h");
    for (const bad of [
      { from: "2026-11-21T22:00:00Z", to: "2026-11-21T17:00:00Z" },
      { from: "2026-11-01T00:00:00Z", to: "2026-11-21T00:00:00Z" },
      { from: "2026-11-21T17:00:00Z" },
      { from: "yesterday", to: "2026-11-21T22:00:00Z" },
    ]) {
      const b = parseTrafficQuery({ range: "24h", ...bad });
      expect([b.from, b.to]).toEqual(["", ""]);
      expect(windowRange(b)).toBe("24h");
    }
    const href = trafficHref("shop", { range: "24h", env: "", app: "", from: "2026-11-21T17:00:00Z", to: "2026-11-21T22:00:00Z" });
    expect(new URL(href, "http://x").searchParams.get("from")).toBe("2026-11-21T17:00:00Z");
  });

  it("puts the method and route in the page URL, never in an endpoint link", () => {
    const href = trafficHref("shop", { range: "24h", env: "", app: "", method: "POST", path: "/orders/{id}" });
    expect(new URL(href, "http://x").searchParams.get("method")).toBe("POST");
    expect(new URL(href, "http://x").searchParams.get("path")).toBe("/orders/{id}");
    expect(endpointHref("shop", { method: "POST", path: "/charge" }, { range: "24h", method: "POST", path: "/charge" })).not.toContain("method=");
  });
});

describe("trafficHref and endpointHref", () => {
  it("leaves defaults out of the URL", () => {
    expect(trafficHref("shop", {})).toBe("/project/shop/traffic");
    // The range and an explicit "all environments" always travel (#993): a URL without them reads the smart defaults.
    expect(trafficHref("shop", { range: "24h", env: "" })).toBe("/project/shop/traffic?range=24h&env=all");
    expect(trafficHref("shop", { range: "1h", env: "production" })).toBe("/project/shop/traffic?range=1h&env=production");
  });

  it("links an endpoint's detail with the path as one segment, keeping the scope", () => {
    expect(endpointHref("shop", { method: "get", path: "/orders/{id}" }, { range: "24h", env: "" })).toBe("/project/shop/endpoints/GET/%2Forders%2F%7Bid%7D?range=24h&env=all");
    expect(endpointHref("shop", { method: "POST", path: "/charge" }, { range: "7d", env: "staging" })).toBe("/project/shop/endpoints/POST/%2Fcharge?range=7d&env=staging");
  });

  it("says the scope in words", () => {
    expect(scopeText({ range: "1h", env: "" })).toBe("the last 1 hour");
    expect(scopeText({ range: "7d", env: "production" })).toBe("the last 7 days in production");
    expect(scopeText({ range: "7d", env: "production", app: BILLING }, "Billing")).toBe("the last 7 days in production for Billing");
  });

  it("keeps the app in the URL and opens a row's endpoint scoped to its app (#976)", () => {
    expect(trafficHref("shop", { range: "24h", env: "", app: BILLING })).toBe(`/project/shop/traffic?range=24h&env=all&app=${BILLING}`);
    expect(endpointHref("shop", { method: "GET", path: "/charge" }, { range: "1h", env: "", app: BILLING })).toBe(`/project/shop/endpoints/GET/%2Fcharge?range=1h&env=all&app=${BILLING}`);
  });
});

describe("app filter (#976)", () => {
  const apps = [
    { id: SHOP, slug: "shop", name: "Shop" },
    { id: BILLING, slug: "billing", name: "Billing" },
  ];

  it("reads an app id from the URL, all apps otherwise", () => {
    expect(parseTrafficQuery({ app: BILLING.toUpperCase() }).app).toBe(BILLING);
    expect(parseAppParam([BILLING, SHOP])).toBe(BILLING);
    expect(parseAppParam("billing")).toBe("");
    expect(parseAppParam(undefined)).toBe("");
  });

  it("offers All apps first, keeping an app the project no longer lists", () => {
    expect(appOptions(apps, "")).toEqual([
      { value: "", label: "All apps" },
      { value: SHOP, label: "Shop" },
      { value: BILLING, label: "Billing" },
    ]);
    const gone = "9b3e4c5d-6f70-4b82-8cbd-2e3f4a5b6c7d";
    expect(appOptions(apps, gone).at(-1)).toEqual({ value: gone, label: "Unknown app" });
  });

  it("names a row's app", () => {
    expect(appName(apps, BILLING)).toBe("Billing");
    expect(appName(apps, "other")).toBe("Unknown app");
    expect(appName(null, BILLING)).toBe("Unknown app");
  });
});

describe("formatting", () => {
  it("formats latencies in ms and seconds", () => {
    expect(formatLatency(0)).toBe("0 ms");
    expect(formatLatency(0.4)).toBe("<1 ms");
    expect(formatLatency(42.4)).toBe("42 ms");
    expect(formatLatency(999.7)).toBe("1.00 s");
    expect(formatLatency(1240)).toBe("1.24 s");
    expect(formatLatency(12_500)).toBe("12.5 s");
  });

  it("formats Apdex with two decimals and rates it", () => {
    expect(formatApdex(0.9412)).toBe("0.94");
    expect(formatApdex(1)).toBe("1.00");
    expect(formatApdex(null)).toBe("n/a");
    expect(formatApdex(undefined)).toBe("n/a");
    expect([0.97, 0.9, 0.75, 0.6, 0.2].map(apdexRating)).toEqual(["Excellent", "Good", "Fair", "Poor", "Unacceptable"]);
    expect(apdexRating(null)).toBeNull();
  });
});

describe("chart helpers", () => {
  it("splits each bucket into successful, 4xx and 5xx", () => {
    expect(statusRows([{ ts: "t", requests: 100, client_errors: 7, server_errors: 3, p95_ms: 12 }])).toEqual([
      { ts: "t", successful: 90, client_errors: 7, server_errors: 3 },
    ]);
  });

  it("uses a measured width only when it is a real one (no width(-1) race)", () => {
    expect(plotWidth(null)).toBeNull();
    expect(plotWidth(undefined)).toBeNull();
    expect(plotWidth(-1)).toBeNull();
    expect(plotWidth(0)).toBeNull();
    expect(plotWidth(Number.NaN)).toBeNull();
    expect(plotWidth(612.4)).toBe(612);
  });

  it("draws a line through the centre of each bucket against the axis top", () => {
    expect(linePath([], 100, 10, 10)).toBe("");
    expect(linePath([0, 5, 10], 300, 100, 10)).toBe("M50,100L150,50L250,0");
    // Values above the top are clamped to it; a zero top draws along the baseline.
    expect(linePath([20], 100, 100, 10)).toBe("M50,0");
    expect(linePath([0, 0], 100, 100, 0)).toBe("M25,100L75,100");
  });

  it("puts a hovered point's dot where the line is drawn", () => {
    expect(lineY(0, 100, 10)).toBe(100);
    expect(lineY(5, 100, 10)).toBe(50);
    expect(lineY(10, 100, 10)).toBe(0);
    // Clamped like the line: above the top, below zero, not a number, a zero top.
    expect(lineY(20, 100, 10)).toBe(0);
    expect(lineY(-3, 100, 10)).toBe(100);
    expect(lineY(Number.NaN, 100, 10)).toBe(100);
    expect(lineY(0, 100, 0)).toBe(100);
  });

  it("rounds the latency axis up", () => {
    expect(latencyTop([120, 380, 90])).toBe(500);
    expect(latencyTop([])).toBe(1);
  });
});

describe("declared routes and path search (#1003)", () => {
  const ep = (method: string, path: string, discovered = false) => ({
    app_id: SHOP,
    method,
    path,
    requests: discovered ? 0 : 10,
    client_errors: 0,
    server_errors: 0,
    error_rate: 0,
    p50_ms: discovered ? 0 : 12,
    p95_ms: discovered ? 0 : 40,
    ...(discovered ? { apdex: null, discovered_only: true } : { apdex: 1 }),
  });
  const rows = [ep("GET", "/orders/{id}"), ep("POST", "/charge"), ep("GET", "/health", true), ep("DELETE", "/orders/{id}", true)];

  it("keeps the routes declared without traffic apart, in the API's order", () => {
    const { active, declared } = splitDeclared(rows);
    expect(active.map((e) => `${e.method} ${e.path}`)).toEqual(["GET /orders/{id}", "POST /charge"]);
    expect(declared.map((e) => `${e.method} ${e.path}`)).toEqual(["GET /health", "DELETE /orders/{id}"]);
  });

  it("names the group's size", () => {
    expect(declaredLabel(1)).toBe("1 declared route without traffic");
    expect(declaredLabel(3)).toBe("3 declared routes without traffic");
    expect(declaredLabel(1200)).toBe("1,200 declared routes without traffic");
  });

  it("reads ?q= trimmed and capped", () => {
    expect(parseEndpointSearch({})).toBe("");
    expect(parseEndpointSearch({ q: "  /orders " })).toBe("/orders");
    expect(parseEndpointSearch({ q: ["/a", "/b"] })).toBe("/a");
    expect(parseEndpointSearch({ q: "x".repeat(300) })).toHaveLength(200);
  });

  it("matches the path or method and path, ignoring case", () => {
    const paths = (q: string) => searchEndpoints(rows, q).map((e) => `${e.method} ${e.path}`);
    expect(paths("")).toHaveLength(4);
    expect(paths("ORDERS")).toEqual(["GET /orders/{id}", "DELETE /orders/{id}"]);
    expect(paths("post /ch")).toEqual(["POST /charge"]);
    expect(paths("/nothing")).toEqual([]);
  });
});

describe("consumer and endpoint metric filters", () => {
  it("reads ?consumer= and ?m= conditions, dropping what the API would refuse", () => {
    const q = parseTrafficQuery({ consumer: " acme ", m: ["p95:gt:500", "client_errors:lt:2%", "p99:gt:5"] });
    expect(q.consumer).toBe("acme");
    expect(q.metrics).toEqual([
      { field: "client_errors", op: "lt", value: 2, pct: true },
      { field: "p95", op: "gt", value: 500, pct: false },
    ]);
    expect(parseTrafficQuery({ consumer: "x".repeat(257) }).consumer).toBe("");
  });
  it("writes them back into the page URL, so the sidebar, the filter bar and links agree", () => {
    const q = parseTrafficQuery({ range: "24h", env: "production", consumer: "acme", m: ["server_errors:eq:0", "p95:gt:1500"] });
    const href = trafficHref("shop", q);
    expect(href).toBe("/project/shop/traffic?range=24h&env=production&consumer=acme&m=server_errors%3Aeq%3A0&m=p95%3Agt%3A1500");
    const back = parseTrafficQuery(Object.fromEntries([...new URLSearchParams(href.split("?")[1]).keys()].map((k) => [k, new URLSearchParams(href.split("?")[1]).getAll(k)])));
    expect(back.consumer).toBe("acme");
    expect(back.metrics).toEqual(q.metrics);
  });
});

describe("status filter", () => {
  it("reads classes and codes, lower-cased, and drops what the API would refuse", () => {
    expect(parseTrafficQuery({ status: "4XX" }).status).toBe("4xx");
    expect(parseTrafficQuery({ status: "2xx,3xx" }).status).toBe("2xx,3xx");
    expect(parseTrafficQuery({ status: "404" }).status).toBe("404");
    for (const bad of ["4xxx", "9xx", "40", "4xx,", "abc"]) expect(parseTrafficQuery({ status: bad }).status).toBe("");
  });
  it("writes it into the page URL", () => {
    expect(trafficHref("shop", { range: "24h", env: "production", status: "2xx,3xx" })).toBe("/project/shop/traffic?range=24h&env=production&status=2xx%2C3xx");
  });
});
