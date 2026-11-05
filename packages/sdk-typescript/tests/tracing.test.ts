import http from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ApiLensClient } from "../src/client.js";
import { useApiLens } from "../src/express.js";
import { RequestSpans, SpanRecorder, stripUrl } from "../src/spans.js";
import {
  beginRequestTrace,
  currentTraceparent,
  parseTraceparent,
  runWithTrace,
} from "../src/trace.js";
import type { ApiLensExpressConfig } from "../src/types.js";

type Call = { url: string; body: Record<string, unknown[]> };

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const PARENT_SPAN_ID = "00f067aa0ba902b7";
const HEX32 = /^[0-9a-f]{32}$/;
const HEX16 = /^[0-9a-f]{16}$/;

// The fields ingest's `spanRecord` / `logRecord` read (internal/ingest/legacy.go).
const SPAN_FIELDS = [
  "app_id", "attributes", "commit", "duration_ms", "environment", "kind", "name",
  "parent_span_id", "project_slug", "release", "service_name", "span_id", "status",
  "status_code", "timestamp", "trace_id",
];
const LOG_FIELDS = [
  "app_id", "commit", "consumer_group", "consumer_id", "consumer_name", "endpoint_method",
  "endpoint_path", "environment", "level", "logger_name", "message", "payload",
  "project_slug", "release", "span_id", "status_code", "timestamp", "trace_id",
];

const servers: http.Server[] = [];

beforeEach(() => {
  delete process.env.APILENS_CAPTURE_SPANS;
});

afterEach(async () => {
  process.env.APILENS_CAPTURE_SPANS = "false";
  await ApiLensClient.shutdown();
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

function listen(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
}

function config(calls: Call[], extra: ApiLensExpressConfig = {}): ApiLensExpressConfig {
  return {
    apiKey: "test-api-key",
    appId: "checkout",
    environment: "test",
    batchSize: 1000,
    compress: false,
    release: "1.2.3",
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), body: JSON.parse(String(options?.body || "{}")) });
      return new Response(null, { status: 202 });
    },
    ...extra,
  };
}

function sent(calls: Call[], path: string, key: string): Array<Record<string, any>> {
  return calls
    .filter((c) => new URL(c.url).pathname === path)
    .flatMap((c) => (c.body[key] || []) as Array<Record<string, any>>);
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > until) {
      throw new Error("timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function httpGet(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode || 0, body }));
      })
      .on("error", reject);
  });
}

describe("parseTraceparent", () => {
  it("parses a valid header", () => {
    expect(parseTraceparent(`00-${TRACE_ID}-${PARENT_SPAN_ID}-01`)).toEqual({
      traceId: TRACE_ID,
      parentSpanId: PARENT_SPAN_ID,
    });
    expect(parseTraceparent(` 00-${TRACE_ID.toUpperCase()}-${PARENT_SPAN_ID}-00 `)?.traceId).toBe(TRACE_ID);
  });

  it.each([
    undefined,
    "",
    "garbage",
    `ff-${TRACE_ID}-${PARENT_SPAN_ID}-01`,
    `00-${"0".repeat(32)}-${PARENT_SPAN_ID}-01`,
    `00-${TRACE_ID}-${"0".repeat(16)}-01`,
    `00-${TRACE_ID.slice(1)}-${PARENT_SPAN_ID}-01`,
  ])("ignores %j", (header) => {
    expect(parseTraceparent(header)).toBeUndefined();
  });

  it("starts a new trace without a valid header", () => {
    const ctx = beginRequestTrace("nope");
    expect(ctx.traceId).toMatch(HEX32);
    expect(ctx.spanId).toMatch(HEX16);
    expect(ctx.parentSpanId).toBe("");
  });

  it("strips query strings and credentials from span URLs", () => {
    expect(stripUrl("https://user:pw@api.example.com/v1/pay?token=secret#x")).toBe(
      "https://api.example.com/v1/pay",
    );
  });
});

describe("Express tracing (e2e)", () => {
  it("builds one trace across an Express app and the downstream service it calls", async () => {
    const calls: Call[] = [];
    const seenTraceparents: string[] = [];

    // Downstream Express service, instrumented with the same client.
    const downstream = express();
    const front = express();
    const frontMw = useApiLens(front, config(calls));
    useApiLens(downstream, { client: frontMw.apilensClient, appId: "checkout" });
    downstream.get("/charge", (req, res) => {
      seenTraceparents.push(String(req.headers.traceparent));
      res.json({ charged: true });
    });
    downstream.get("/stock", (req, res) => {
      seenTraceparents.push(String(req.headers.traceparent));
      res.json({ stock: 3 });
    });
    const downstreamUrl = await listen(downstream);

    front.post("/orders/:id/checkout", async (_req, res) => {
      const charge = await fetch(`${downstreamUrl}/charge?card=4111`);
      await charge.json();
      const stock = await httpGet(`${downstreamUrl}/stock`);
      res.status(201).json({ ok: true, stock: JSON.parse(stock.body).stock });
    });

    await request(front)
      .post("/orders/42/checkout")
      .set("traceparent", `00-${TRACE_ID}-${PARENT_SPAN_ID}-01`)
      .expect(201);

    const client = ApiLensClient.getInstance();
    await waitFor(() => client.spanQueue.length >= 5);
    await client.flushAll();

    const records = sent(calls, "/v1/requests", "requests");
    const spans = sent(calls, "/v1/traces", "spans");
    expect(sent(calls, "/v1/logs", "logs")).toEqual([]);

    // Every record and span is in the caller's trace.
    expect(records).toHaveLength(3);
    for (const item of [...records, ...spans]) {
      expect(item.trace_id).toBe(TRACE_ID);
    }

    const root = spans.find((s) => s.name === "POST /orders/{id}/checkout")!;
    expect(root).toMatchObject({
      kind: "server",
      parent_span_id: PARENT_SPAN_ID,
      status: "ok",
      status_code: 201,
      service_name: "checkout",
      app_id: "checkout",
      environment: "test",
      release: "1.2.3",
    });
    const frontRecord = records.find((r) => r.path === "/orders/{id}/checkout")!;
    expect(frontRecord.span_id).toBe(root.span_id);

    const outbound = spans.filter((s) => s.kind === "http");
    expect(outbound.map((s) => s.name).sort()).toEqual([
      `GET ${downstreamUrl}/charge`,
      `GET ${downstreamUrl}/stock`,
    ]);
    for (const child of outbound) {
      expect(child.parent_span_id).toBe(root.span_id);
      expect(child.span_id).toMatch(HEX16);
      expect(child.status_code).toBe(200);
      expect(child.attributes["http.url"]).not.toContain("card=");
    }

    // traceparent was propagated on both the fetch and the http call, and
    // the downstream request spans hang off the outbound spans.
    expect(seenTraceparents.sort()).toEqual(
      outbound.map((s) => `00-${TRACE_ID}-${s.span_id}-01`).sort(),
    );
    const downstreamSpans = spans.filter((s) => s.kind === "server" && s !== root);
    expect(downstreamSpans).toHaveLength(2);
    for (const span of downstreamSpans) {
      expect(outbound.map((s) => s.span_id)).toContain(span.parent_span_id);
    }

    // Waterfall: children start inside their parent; every parent is in the trace.
    const byId = new Map(spans.map((s) => [s.span_id, s]));
    for (const span of spans) {
      expect(Object.keys(span).sort()).toEqual(SPAN_FIELDS);
      if (span === root) {
        continue;
      }
      const parent = byId.get(span.parent_span_id)!;
      expect(parent).toBeDefined();
      expect(Date.parse(span.timestamp)).toBeGreaterThanOrEqual(Date.parse(parent.timestamp));
    }
  });

  it("starts a new trace without traceparent and propagates it", async () => {
    const calls: Call[] = [];
    const seen: string[] = [];
    const downstreamUrl = await listen((req, res) => {
      seen.push(String(req.headers.traceparent));
      res.end("ok");
    });
    const app = express();
    useApiLens(app, config(calls));
    app.get("/proxy", async (_req, res) => {
      await (await fetch(`${downstreamUrl}/x`)).text();
      res.json({ traceparent: currentTraceparent() });
    });

    const response = await request(app).get("/proxy").expect(200);
    await ApiLensClient.getInstance().flushAll();

    const [record] = sent(calls, "/v1/requests", "requests");
    expect(record.trace_id).toMatch(HEX32);
    expect(response.body.traceparent).toBe(`00-${record.trace_id}-${record.span_id}-01`);
    const spans = sent(calls, "/v1/traces", "spans");
    const root = spans.find((s) => s.kind === "server")!;
    expect(root.parent_span_id).toBe("");
    const child = spans.find((s) => s.kind === "http")!;
    expect(seen).toEqual([`00-${record.trace_id}-${child.span_id}-01`]);
  });

  it("sends an ERROR log with the stack for an unhandled error", async () => {
    const calls: Call[] = [];
    const app = express();
    useApiLens(app, config(calls));
    app.get("/boom", () => {
      throw new TypeError("card declined");
    });
    // The app's own error handler answers; the error is still recorded.
    app.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: "internal" });
    });

    await request(app).get("/boom").set("X-Consumer", "c").expect(500);
    await ApiLensClient.getInstance().flushAll();

    // The error layer added on the first request does not re-run the middleware.
    expect(sent(calls, "/v1/requests", "requests")).toHaveLength(1);
    const [record] = sent(calls, "/v1/requests", "requests");
    const [root] = sent(calls, "/v1/traces", "spans");
    const logs = sent(calls, "/v1/logs", "logs");
    expect(root).toMatchObject({ status: "error", status_code: 500, span_id: record.span_id });
    expect(logs).toHaveLength(1);
    expect(Object.keys(logs[0]).sort()).toEqual(LOG_FIELDS);
    expect(logs[0]).toMatchObject({
      level: "ERROR",
      message: "TypeError: card declined",
      logger_name: "apilens.exception",
      endpoint_method: "GET",
      endpoint_path: "/boom",
      status_code: 500,
      trace_id: record.trace_id,
      span_id: record.span_id,
      release: "1.2.3",
    });
    expect(logs[0].payload).toContain("TypeError: card declined");
    expect(logs[0].payload).toContain("tracing.test.ts");
  });

  it("records the error when Express' default handler answers", async () => {
    const calls: Call[] = [];
    const app = express();
    useApiLens(app, config(calls));
    app.get("/boom", async () => {
      throw new Error("db down");
    });

    await request(app).get("/boom").expect(500);
    await ApiLensClient.getInstance().flushAll();

    const logs = sent(calls, "/v1/logs", "logs");
    expect(logs).toHaveLength(1);
    expect(logs[0].message).toBe("Error: db down");
    expect(logs[0].payload).toContain("db down");
  });

  it("sends an ERROR log without a stack for a plain 5xx, none for 4xx", async () => {
    const calls: Call[] = [];
    const app = express();
    useApiLens(app, config(calls));
    app.get("/down", (_req, res) => {
      res.status(503).send("maintenance");
    });
    app.get("/missing", (_req, res) => {
      res.status(404).send("nope");
    });

    await request(app).get("/down").expect(503);
    await request(app).get("/missing").expect(404);
    await ApiLensClient.getInstance().flushAll();

    const logs = sent(calls, "/v1/logs", "logs");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      message: "HTTP 503 on GET /down",
      logger_name: "apilens.http",
      payload: "",
      status_code: 503,
    });
    expect(sent(calls, "/v1/traces", "spans")).toHaveLength(2);
  });

  it("keeps trace ids but sends no spans or logs for a sampled-out request", async () => {
    const calls: Call[] = [];
    const seen: string[] = [];
    const downstreamUrl = await listen((req, res) => {
      seen.push(String(req.headers.traceparent || ""));
      res.end("ok");
    });
    const app = express();
    useApiLens(app, config(calls, { sampleRate: 0 }));
    app.get("/fail", async (_req, res) => {
      await (await fetch(downstreamUrl)).text();
      res.status(500).end();
    });

    await request(app).get("/fail").expect(500);
    await ApiLensClient.getInstance().flushAll();

    const [record] = sent(calls, "/v1/requests", "requests");
    expect(record.sampled).toBe(false);
    expect(record.trace_id).toMatch(HEX32);
    expect(seen[0]).toMatch(new RegExp(`^00-${record.trace_id}-[0-9a-f]{16}-01$`));
    expect(sent(calls, "/v1/traces", "spans")).toEqual([]);
    expect(sent(calls, "/v1/logs", "logs")).toEqual([]);
  });

  it.each([
    ["captureSpans: false", { captureSpans: false }, undefined],
    ["APILENS_CAPTURE_SPANS=false", { captureSpans: true }, "false"],
  ])("%s disables trace ids, spans, propagation and the error log", async (_name, extra, env) => {
    if (env !== undefined) {
      process.env.APILENS_CAPTURE_SPANS = env;
    }
    const calls: Call[] = [];
    const seen: Array<string | undefined> = [];
    const downstreamUrl = await listen((req, res) => {
      seen.push(req.headers.traceparent as string | undefined);
      res.end("ok");
    });
    const app = express();
    useApiLens(app, config(calls, extra));
    app.get("/fail", async (_req, res) => {
      await (await fetch(downstreamUrl)).text();
      await httpGet(downstreamUrl);
      throw new Error("boom");
    });

    await request(app).get("/fail").set("traceparent", `00-${TRACE_ID}-${PARENT_SPAN_ID}-01`).expect(500);
    await ApiLensClient.getInstance().flushAll();

    const [record] = sent(calls, "/v1/requests", "requests");
    expect(record.trace_id).toBe("");
    expect(record.span_id).toBe("");
    expect(seen).toEqual([undefined, undefined]);
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/v1/requests"]);
  });

  it("leaves calls outside a request untouched", async () => {
    const seen: Array<string | undefined> = [];
    const url = await listen((req, res) => {
      seen.push(req.headers.traceparent as string | undefined);
      res.end("ok");
    });
    const app = express();
    useApiLens(app, config([]));

    await (await fetch(url)).text();
    await httpGet(url);
    expect(seen).toEqual([undefined, undefined]);
    expect(ApiLensClient.getInstance().spanQueue).toEqual([]);
  });

  it("never traces the SDK's own uploads", async () => {
    const seen: Array<string | undefined> = [];
    const ingestUrl = await listen((req, res) => {
      seen.push(req.headers.traceparent as string | undefined);
      req.resume();
      req.on("end", () => {
        res.statusCode = 202;
        res.end("{}");
      });
    });
    const client = new ApiLensClient({
      apiKey: "k",
      appId: "checkout",
      baseUrl: `${ingestUrl}/v1`,
      compress: false,
      batchSize: 1000,
    });
    const app = express();
    useApiLens(app, { client, appId: "checkout" });
    app.get("/flush", async (_req, res) => {
      client.capture({ method: "GET", path: "/x", status_code: 200, response_time_ms: 1 });
      await client.flushAll();
      res.end("ok");
    });

    await request(app).get("/flush").expect(200);
    expect(seen).toEqual([undefined]);
    // Only the request's own server span; no span for the upload.
    expect(client.spanQueue.map((s) => s.kind)).toEqual(["server"]);
  });
});

describe("span and log delivery", () => {
  it("batches spans to /v1/traces and logs to /v1/logs", async () => {
    const calls: Call[] = [];
    const client = new ApiLensClient({
      apiKey: "k",
      appId: "checkout",
      compress: false,
      batchSize: 2,
      release: "r1",
      commit: "abc",
      fetchImpl: async (url, options) => {
        calls.push({ url: String(url), body: JSON.parse(String(options?.body || "{}")) });
        return new Response(null, { status: 202 });
      },
    });
    const recorder = new SpanRecorder(client, "checkout", "prod", "svc");
    const ctx = beginRequestTrace(undefined);
    for (let i = 0; i < 3; i += 1) {
      recorder.span(ctx, {
        spanId: `00000000000000${i}1`,
        parentSpanId: "",
        name: `s${i}`,
        kind: "SERVER",
        startedAt: new Date(),
        durationMs: -1,
        status: "ok",
        statusCode: 200,
        attributes: { nested: { no: 1 }, n: 1 },
      });
    }
    recorder.errorLog(ctx, {
      message: "m",
      payload: "stack",
      loggerName: "apilens.http",
      method: "get",
      path: "/x",
      statusCode: 500,
      consumerId: "",
      consumerName: "",
      consumerGroup: "",
    });
    await client.flushAll();

    expect(calls.map((c) => new URL(c.url).pathname).sort()).toEqual([
      "/v1/logs",
      "/v1/traces",
      "/v1/traces",
    ]);
    const spans = sent(calls, "/v1/traces", "spans");
    expect(spans).toHaveLength(3);
    expect(spans[0]).toMatchObject({
      kind: "server",
      duration_ms: 0,
      release: "r1",
      commit: "abc",
      environment: "prod",
      service_name: "svc",
      attributes: { n: "1" },
    });
    const [log] = sent(calls, "/v1/logs", "logs");
    expect(log).toMatchObject({ endpoint_method: "GET", trace_id: ctx.traceId, span_id: ctx.spanId });
    expect(client.stats().sentRecords).toBe(4);
  });

  it("holds child spans until the request is sampled in, and drops them otherwise", () => {
    const captured: string[] = [];
    const recorder = { span: (_ctx: unknown, span: { name: string }) => captured.push(span.name) };
    const make = () => {
      const spans = new RequestSpans(recorder as unknown as SpanRecorder);
      const ctx = beginRequestTrace(undefined, spans);
      spans.bind(ctx);
      return { spans, ctx };
    };
    const child = (name: string) => ({
      spanId: "0000000000000001",
      name,
      kind: "http",
      startedAt: new Date(),
      durationMs: 1,
      status: "ok" as const,
      statusCode: 200,
      attributes: {},
    });

    const kept = make();
    runWithTrace(kept.ctx, () => kept.spans.childSpan(child("a")));
    expect(captured).toEqual([]);
    kept.spans.finish(true);
    kept.spans.childSpan(child("late"));
    expect(captured).toEqual(["a", "late"]);

    const dropped = make();
    dropped.spans.childSpan(child("b"));
    dropped.spans.finish(false);
    dropped.spans.childSpan(child("c"));
    expect(captured).toEqual(["a", "late"]);
  });
});
