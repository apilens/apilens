import { describe, expect, it } from "vitest";
import {
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
    expect(parseTrafficQuery({})).toEqual({ range: "24h", env: "", app: "" });
  });

  it("reads a known range and an environment", () => {
    expect(parseTrafficQuery({ range: "7d", env: "production" })).toEqual({ range: "7d", env: "production", app: "" });
    expect(parseTrafficQuery({ range: ["1h", "7d"], env: [" staging "] })).toEqual({ range: "1h", env: "staging", app: "" });
  });

  it("falls back on an unknown range or an environment name the API would refuse", () => {
    expect(parseTrafficQuery({ range: "30d", env: "x".repeat(65) })).toEqual({ range: "24h", env: "", app: "" });
  });
});

describe("trafficHref and endpointHref", () => {
  it("leaves defaults out of the URL", () => {
    expect(trafficHref("shop", { range: "24h", env: "" })).toBe("/shop/traffic");
    expect(trafficHref("shop", { range: "1h", env: "production" })).toBe("/shop/traffic?range=1h&env=production");
  });

  it("links an endpoint's detail with the path as one segment, keeping the scope", () => {
    expect(endpointHref("shop", { method: "get", path: "/orders/{id}" }, { range: "24h", env: "" })).toBe("/shop/endpoints/GET/%2Forders%2F%7Bid%7D");
    expect(endpointHref("shop", { method: "POST", path: "/charge" }, { range: "7d", env: "staging" })).toBe("/shop/endpoints/POST/%2Fcharge?range=7d&env=staging");
  });

  it("says the scope in words", () => {
    expect(scopeText({ range: "1h", env: "" })).toBe("the last 1 hour");
    expect(scopeText({ range: "7d", env: "production" })).toBe("the last 7 days in production");
    expect(scopeText({ range: "7d", env: "production", app: BILLING }, "Billing")).toBe("the last 7 days in production for Billing");
  });

  it("keeps the app in the URL and opens a row's endpoint scoped to its app (#976)", () => {
    expect(trafficHref("shop", { range: "24h", env: "", app: BILLING })).toBe(`/shop/traffic?app=${BILLING}`);
    expect(endpointHref("shop", { method: "GET", path: "/charge" }, { range: "1h", env: "", app: BILLING })).toBe(`/shop/endpoints/GET/%2Fcharge?range=1h&app=${BILLING}`);
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
