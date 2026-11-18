import { describe, expect, it } from "vitest";
import { parseExploreQuery } from "./explore";
import { incidentLinks, metricStatus, parseEndpoint } from "./incident-links";

const APP = "5d0c1b2a-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
const APPS = [{ id: APP, slug: "shop" }];
const NOW = Date.parse("2026-11-16T12:00:00Z");
const rule = (over: Partial<Parameters<typeof incidentLinks>[1]> = {}) => ({ app_id: APP, environment: "production", metric: "server_error_rate" as const, filters: {}, ...over });
const query = (href: string) => Object.fromEntries(new URL(href, "http://x").searchParams);

describe("metricStatus", () => {
  it("maps each error metric to its status class and the rest to none", () => {
    expect(metricStatus("server_errors")).toBe("5xx");
    expect(metricStatus("server_error_rate")).toBe("5xx");
    expect(metricStatus("client_errors")).toBe("4xx");
    expect(metricStatus("client_error_rate")).toBe("4xx");
    expect(metricStatus("error_rate")).toBe("4xx,5xx");
    expect(metricStatus("p95")).toBe("");
    expect(metricStatus("traffic")).toBe("");
  });
});

describe("parseEndpoint", () => {
  it("reads a method and route, or a route for every method", () => {
    expect(parseEndpoint("post /checkout/{id}")).toEqual({ method: "POST", path: "/checkout/{id}" });
    expect(parseEndpoint("/orders")).toEqual({ method: "", path: "/orders" });
    expect(parseEndpoint("")).toBeNull();
    expect(parseEndpoint(undefined)).toBeNull();
    expect(parseEndpoint("not a route")).toBeNull();
  });
});

describe("incidentLinks", () => {
  it("opens Explore on the failing requests of the rule's scope from the incident's start", () => {
    const l = incidentLinks("shop", rule({ filters: { endpoint: "POST /checkout", consumer: "alice", group: "Acme" } }), APPS, "2026-11-16T11:20:30.500Z", NOW);
    expect(l.requests.label).toBe("See failing requests");
    expect(l.requests.href.startsWith("/shop/explore?")).toBe(true);
    const state = parseExploreQuery(query(l.requests.href));
    expect(state.range).toBe("1h");
    expect(state.from).toBe("2026-11-16T11:20:30Z");
    expect(state.filters).toMatchObject({ env: "production", app: APP, status: "5xx", method: "POST", path: "/checkout", consumer_id: "alice", consumer_group: "Acme" });
  });

  it("reads 4xx for a client error rule and no status for a latency rule", () => {
    expect(query(incidentLinks("shop", rule({ metric: "client_errors" }), APPS, undefined, NOW).requests.href).status).toBe("4xx");
    const p95 = incidentLinks("shop", rule({ metric: "p95" }), APPS, undefined, NOW).requests;
    expect(p95.label).toBe("See requests");
    expect(query(p95.href).status).toBeUndefined();
  });

  it("picks the smallest range that holds the incident's start", () => {
    const l = incidentLinks("shop", rule(), APPS, "2026-11-15T20:00:00Z", NOW);
    expect(query(l.requests.href).range).toBe("24h");
    expect(l.errors.href).toBe("/shop/errors?range=24h&env=production");
  });

  it("links the endpoint only when the rule names a method and route", () => {
    const withEp = incidentLinks("shop", rule({ filters: { endpoint: "GET /orders/{id}" } }), APPS, "2026-11-16T11:30:00Z", NOW);
    expect(withEp.endpoint?.href).toBe(`/shop/endpoints/GET/${encodeURIComponent("/orders/{id}")}?range=1h&env=production&app=${APP}`);
    expect(incidentLinks("shop", rule({ filters: { endpoint: "/orders" } }), APPS, undefined, NOW).endpoint).toBeNull();
    expect(incidentLinks("shop", rule(), APPS, undefined, NOW).endpoint).toBeNull();
  });

  it("links the app by its slug, and not at all when the app is unknown", () => {
    expect(incidentLinks("shop", rule(), APPS, undefined, NOW).app).toBe("/shop/apps/shop");
    expect(incidentLinks("shop", rule(), [], undefined, NOW).app).toBeNull();
  });
});
