/**
 * App metadata: POST /v1/metadata once per process start (issue #547;
 * contract: the AppMetadata schema of api/openapi/apilens.v1.json).
 */
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiLensClient, SDK_VERSION } from "../src/client.js";
import { createApiLensMiddleware, useApiLens } from "../src/express.js";
import { MAX_METADATA_ROUTES, listExpressRoutes, packageVersion } from "../src/metadata.js";
import type { ApiLensClientConfig, Logger } from "../src/types.js";
import { hasApiKeyField, requestSchema, responseSchema, validate } from "./contract.js";

const API_KEY = "apilens_test_METADATAKEY";

type Sent = { url: string; body: Record<string, unknown> };

let counter = 0;
/** A fresh app id per test: a report is sent once per process per app. */
function uniqueApp(): string {
  counter += 1;
  return `orders-api-${counter}`;
}

function fakeIngest(...statuses: number[]) {
  const sent: Sent[] = [];
  let calls = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    if (!String(url).endsWith("/metadata")) {
      return new Response("{}", { status: 202 });
    }
    const status = statuses.length > 0 ? statuses[Math.min(calls, statuses.length - 1)] : 200;
    calls += 1;
    const body = status === 200
      ? JSON.stringify({ accepted: 1, routes: 0, routes_truncated: false })
      : '{"error":"validation_error","detail":"unknown app"}';
    return new Response(body, { status });
  }) as typeof fetch;
  return { fetchImpl, sent, reports: () => sent.filter((s) => s.url.endsWith("/metadata")) };
}

function makeClient(fetchImpl: typeof fetch, overrides: ApiLensClientConfig = {}): ApiLensClient {
  return new ApiLensClient({
    apiKey: API_KEY,
    baseUrl: "http://ingest.test/v1",
    appId: uniqueApp(),
    compress: false,
    retryBackoffBaseMs: 1,
    retryBackoffMaxMs: 2,
    fetchImpl,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    ...overrides,
  });
}

beforeEach(() => {
  process.env.APILENS_SEND_METADATA = "true";
});

afterEach(async () => {
  await ApiLensClient.shutdown();
  process.env.APILENS_SEND_METADATA = "false";
});

describe("listExpressRoutes", () => {
  it("lists an Express 5 app's routes as {name} templates", () => {
    const app = express();
    const root = express.Router();
    root.get("/status", (_req, res) => { res.end(); });
    const api = express.Router();
    api.get("/hidden", (_req, res) => { res.end(); });

    app.get("/users/:id", (_req, res) => { res.end(); });
    app.post("/orders", (_req, res) => { res.end(); });
    app.route("/items").get((_req, res) => { res.end(); }).put((_req, res) => { res.end(); });
    app.get(["/a", "/b"], (_req, res) => { res.end(); });
    app.get(/^\/regex$/, (_req, res) => { res.end(); });
    app.all("/any", (_req, res) => { res.end(); });
    app.use(root);
    app.use("/api", api);

    const routes = listExpressRoutes(app);
    expect(routes).toEqual([
      { method: "GET", path: "/users/{id}" },
      { method: "POST", path: "/orders" },
      { method: "GET", path: "/items" },
      { method: "PUT", path: "/items" },
      { method: "GET", path: "/a" },
      { method: "GET", path: "/b" },
      { method: "GET", path: "/status" },
    ]);
    // Express 5 keeps no mount path for /api: never reported under a wrong one.
    expect(routes.some((r) => r.path.endsWith("/hidden"))).toBe(false);
  });

  it("recovers Express 4 mount paths from the layer regexps", () => {
    const rootMount = Object.assign(/^\/?(?=\/|$)/i, { fast_slash: true });
    const app = {
      _router: {
        stack: [
          { name: "query", handle: () => {} },
          { route: { path: "/orders/:id(\\d+)", methods: { get: true, delete: true } } },
          {
            name: "router",
            regexp: /^\/api\/v1\/?(?=\/|$)/i,
            keys: [],
            handle: {
              stack: [
                { route: { path: "/things", methods: { post: true } } },
                {
                  name: "router",
                  regexp: /^\/users\/(?:([^\/]+?))\/?(?=\/|$)/i,
                  keys: [{ name: "userId" }],
                  handle: { stack: [{ route: { path: "/posts/:postId", methods: { get: true } } }] },
                },
              ],
            },
          },
          { name: "router", regexp: rootMount, keys: [], handle: { stack: [{ route: { path: "/ping", methods: { get: true } } }] } },
          { name: "router", regexp: /^\/v(\d+)\/?(?=\/|$)/i, keys: [], handle: { stack: [{ route: { path: "/x", methods: { get: true } } }] } },
        ],
      },
      get router() {
        throw new Error("'app.router' is deprecated!");
      },
    };

    expect(listExpressRoutes(app)).toEqual([
      { method: "GET", path: "/orders/{id}" },
      { method: "DELETE", path: "/orders/{id}" },
      { method: "POST", path: "/api/v1/things" },
      { method: "GET", path: "/api/v1/users/{userId}/posts/{postId}" },
      { method: "GET", path: "/ping" },
    ]);
  });

  it(`stops at ${MAX_METADATA_ROUTES} routes and never throws`, () => {
    const app = express();
    for (let i = 0; i < MAX_METADATA_ROUTES + 10; i += 1) {
      app.get(`/r${i}`, (_req, res) => { res.end(); });
    }
    expect(listExpressRoutes(app)).toHaveLength(MAX_METADATA_ROUTES);
    expect(listExpressRoutes(undefined)).toEqual([]);
    expect(listExpressRoutes({ _router: { stack: [null, 1, { route: {} }] } })).toEqual([]);
  });
});

describe("metadata report contract", () => {
  it("useApiLens sends one report matching the ingest AppMetadata schema", async () => {
    const ingest = fakeIngest();
    const appId = uniqueApp();
    const app = express();
    const mw = useApiLens(app, {
      apiKey: API_KEY,
      appId,
      projectSlug: "shop",
      environment: "staging",
      baseUrl: "http://ingest.test/v1",
      compress: false,
      redactBodyFields: ["^ssn$"],
      excludePaths: ["^/internal/"],
      sampleRate: 0.5,
      getConsumer: () => "c1",
      fetchImpl: ingest.fetchImpl,
      logger: { debug() {}, warn() {}, error() {} },
    });
    mw.apilensClient.stop();
    app.get("/orders/:id", (_req, res) => { res.json({}); });

    await vi.waitFor(() => expect(ingest.reports()).toHaveLength(1), { timeout: 3000 });
    const { url, body } = ingest.reports()[0];

    expect(url).toBe("http://ingest.test/v1/metadata");
    expect(validate(body, requestSchema("/v1/metadata"))).toEqual([]);
    expect(hasApiKeyField(body)).toBe(false);
    expect(JSON.stringify(body)).not.toContain(API_KEY);
    expect(body).toMatchObject({
      app_id: appId,
      project_slug: "shop",
      environment: "staging",
      framework: "express",
      framework_version: packageVersion("express"),
      node_version: process.versions.node,
      sdk_version: SDK_VERSION,
      routes: [{ method: "GET", path: "/orders/{id}" }],
    });
    expect(body.framework_version).toMatch(/^\d+\.\d+\.\d+/);
    const config = body.config as Record<string, unknown>;
    expect(config).toMatchObject({
      capture_headers: true,
      capture_request_body: true,
      capture_response_body: true,
      max_payload_bytes: 8192,
      default_exclusions: true,
      sample_rate: 0.5,
      compress: false,
      callbacks: {
        get_consumer: true,
        sample_on_request: false,
        sample_on_response: false,
        mask_request_body: false,
        mask_response_body: false,
        on_stats: false,
      },
    });
    expect(String((config.redact_body_fields as string[])[0])).toContain("ssn");
    expect(config.exclude_paths).toContain("^\\/internal\\/");
    expect(Buffer.byteLength(JSON.stringify(config))).toBeLessThanOrEqual(64 << 10);

    // The documented answer is what the edge sends back.
    expect(validate({ accepted: 1, routes: 1, routes_truncated: false }, responseSchema("/v1/metadata", "200"))).toEqual([]);
  });

  it("createApiLensMiddleware reports from the first request's app", async () => {
    const ingest = fakeIngest();
    const app = express();
    const client = makeClient(ingest.fetchImpl);
    client.stop();
    app.use(createApiLensMiddleware({ client, defaultExclusions: false }));
    app.get("/health/deep", (_req, res) => { res.json({}); });

    await request(app).get("/health/deep").expect(200);
    await vi.waitFor(() => expect(ingest.reports()).toHaveLength(1), { timeout: 3000 });
    expect(ingest.reports()[0].body.routes).toEqual([{ method: "GET", path: "/health/deep" }]);

    await request(app).get("/health/deep").expect(200);
    await new Promise((r) => setTimeout(r, 1100));
    expect(ingest.reports()).toHaveLength(1);
  });

  it("is sent once per process for an app and environment", () => {
    const client = makeClient(fakeIngest().fetchImpl);
    expect(client.reportMetadata(() => ({}))).toBe(true);
    expect(client.reportMetadata(() => ({}))).toBe(false);
    expect(client.reportMetadata(() => ({}), { environment: "canary" })).toBe(true);
  });

  it("strips any key naming an API key, at any depth", async () => {
    const ingest = fakeIngest();
    const client = makeClient(ingest.fetchImpl);
    expect(await client.sendMetadata({
      app_id: "x",
      api_key: "a",
      config: { apiKey: "b", nested: [{ "API-Key": "c", keep: 1 }] },
    })).toBe(true);
    expect(ingest.reports()[0].body).toEqual({ app_id: "x", config: { nested: [{ keep: 1 }] } });
  });

  it("retries 5xx and logs a 4xx rejection once without retrying", async () => {
    const retried = fakeIngest(503, 200);
    const client = makeClient(retried.fetchImpl);
    expect(await client.sendMetadata({ app_id: "x" })).toBe(true);
    expect(retried.reports()).toHaveLength(2);
    await ApiLensClient.shutdown();

    const warnings: unknown[][] = [];
    const logger: Logger = { debug() {}, warn: (...args) => warnings.push(args) };
    const rejected = fakeIngest(422);
    const second = makeClient(rejected.fetchImpl, { logger });
    expect(await second.sendMetadata({ app_id: "x" })).toBe(false);
    expect(await second.sendMetadata({ app_id: "x" })).toBe(false);
    expect(rejected.reports()).toHaveLength(2);
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0][1])).toContain("unknown app");
  });

  it.each([
    ["sendMetadata: false", { sendMetadata: false }, "true"],
    ["APILENS_SEND_METADATA=false", {}, "false"],
    ["a disabled client", { enabled: false }, "true"],
  ])("is off with %s", (_name, overrides, env) => {
    process.env.APILENS_SEND_METADATA = env;
    const client = makeClient(fakeIngest().fetchImpl, overrides);
    expect(client.reportMetadata(() => ({}))).toBe(false);
  });
});
