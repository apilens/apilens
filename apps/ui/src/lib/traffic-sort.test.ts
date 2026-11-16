// The Traffic endpoints table's sort (#1001): `?sort=&dir=`, the header links and the order.
import { describe, expect, it } from "vitest";
import type { EndpointTraffic } from "./identity";
import { DEFAULT_ENDPOINT_SORT, ariaSort, nextEndpointSort, parseEndpointSort, sortEndpoints } from "./traffic";

const ep = (method: string, path: string, o: Partial<EndpointTraffic> = {}): EndpointTraffic => ({
  app_id: "a1",
  method,
  path,
  requests: 10,
  client_errors: 0,
  server_errors: 0,
  error_rate: 0,
  p50_ms: 10,
  p95_ms: 100,
  apdex: 1,
  ...o,
});

describe("parseEndpointSort", () => {
  it("defaults to busiest first", () => {
    expect(parseEndpointSort({})).toEqual(DEFAULT_ENDPOINT_SORT);
    expect(parseEndpointSort({ sort: "nope", dir: "asc" })).toEqual({ key: "requests", dir: "desc" });
  });

  it("reads a column and a direction, else the column's first direction", () => {
    expect(parseEndpointSort({ sort: "p95", dir: "asc" })).toEqual({ key: "p95", dir: "asc" });
    expect(parseEndpointSort({ sort: "p95" })).toEqual({ key: "p95", dir: "desc" });
    expect(parseEndpointSort({ sort: "endpoint", dir: "sideways" })).toEqual({ key: "endpoint", dir: "asc" });
    expect(parseEndpointSort({ sort: ["apdex", "p50"] })).toEqual({ key: "apdex", dir: "asc" });
  });
});

describe("nextEndpointSort and ariaSort", () => {
  it("links a column in its first direction, then the other way", () => {
    expect(nextEndpointSort(DEFAULT_ENDPOINT_SORT, "p95")).toEqual({ sort: "p95", dir: "desc" });
    expect(nextEndpointSort({ key: "p95", dir: "desc" }, "p95")).toEqual({ sort: "p95", dir: "asc" });
    expect(nextEndpointSort({ key: "p95", dir: "asc" }, "p95")).toEqual({ sort: "p95", dir: "desc" });
    expect(nextEndpointSort(DEFAULT_ENDPOINT_SORT, "endpoint")).toEqual({ sort: "endpoint", dir: "asc" });
  });

  it("leaves the default order out of the URL", () => {
    expect(nextEndpointSort(DEFAULT_ENDPOINT_SORT, "requests")).toEqual({ sort: "requests", dir: "asc" });
    expect(nextEndpointSort({ key: "requests", dir: "asc" }, "requests")).toEqual({ sort: null, dir: null });
    expect(nextEndpointSort({ key: "p95", dir: "desc" }, "requests")).toEqual({ sort: null, dir: null });
  });

  it("names the order on its column only", () => {
    expect(ariaSort(DEFAULT_ENDPOINT_SORT, "requests")).toBe("descending");
    expect(ariaSort({ key: "p50", dir: "asc" }, "p50")).toBe("ascending");
    expect(ariaSort({ key: "p50", dir: "asc" }, "requests")).toBeUndefined();
  });
});

describe("sortEndpoints", () => {
  const list = [
    ep("GET", "/orders", { requests: 900, p95_ms: 120, client_errors: 4, apdex: 0.9 }),
    ep("POST", "/charge", { requests: 300, p95_ms: 1800, server_errors: 9, apdex: 0.5, app_id: "b2" }),
    ep("GET", "/health", { requests: 0, p95_ms: 0, apdex: null }),
    ep("GET", "/users", { requests: 300, p95_ms: 90, apdex: 0.99 }),
  ];
  const paths = (rows: EndpointTraffic[]) => rows.map((e) => e.path);

  it("orders by a number either way, ties in the API's order", () => {
    expect(paths(sortEndpoints(list, { key: "p95", dir: "desc" }))).toEqual(["/charge", "/orders", "/users", "/health"]);
    expect(paths(sortEndpoints(list, { key: "p95", dir: "asc" }))).toEqual(["/health", "/users", "/orders", "/charge"]);
    expect(paths(sortEndpoints(list, { key: "requests", dir: "desc" }))).toEqual(["/orders", "/charge", "/users", "/health"]);
    expect(paths(sortEndpoints(list, { key: "server_errors", dir: "desc" }))[0]).toBe("/charge");
    expect(paths(sortEndpoints(list, { key: "client_errors", dir: "desc" }))[0]).toBe("/orders");
    // The input is left as it was.
    expect(paths(list)).toEqual(["/orders", "/charge", "/health", "/users"]);
  });

  it("puts endpoints without an Apdex last, worst score first", () => {
    expect(paths(sortEndpoints(list, { key: "apdex", dir: "asc" }))).toEqual(["/charge", "/orders", "/users", "/health"]);
    expect(paths(sortEndpoints(list, { key: "apdex", dir: "desc" }))).toEqual(["/users", "/orders", "/charge", "/health"]);
  });

  it("orders by path or by app name", () => {
    expect(paths(sortEndpoints(list, { key: "endpoint", dir: "asc" }))).toEqual(["/charge", "/health", "/orders", "/users"]);
    const names: Record<string, string> = { a1: "Shop", b2: "Billing" };
    expect(paths(sortEndpoints(list, { key: "app", dir: "asc" }, (id) => names[id]))[0]).toBe("/charge");
  });
});
