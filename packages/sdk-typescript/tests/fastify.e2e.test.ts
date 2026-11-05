import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiLensClient } from "../src/client.js";
import {
  apiLensFastify,
  fastifyPathToTemplate,
  instrumentFastify,
  setConsumer,
} from "../src/fastify.js";
import { currentTraceparent } from "../src/trace.js";
import type { ApiLensExpressConfig } from "../src/types.js";
import { requestSchema, validate } from "./contract.js";

type Call = { url: string; body: Record<string, any> };

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const PARENT_SPAN_ID = "00f067aa0ba902b7";

const apps: FastifyInstance[] = [];

function config(calls: Call[], extra: ApiLensExpressConfig = {}): ApiLensExpressConfig {
  return {
    apiKey: "test-api-key",
    projectSlug: "test-project",
    appId: "test-app",
    environment: "test",
    batchSize: 100,
    compress: false,
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

function app(): FastifyInstance {
  const instance = Fastify();
  apps.push(instance);
  return instance;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
  await ApiLensClient.shutdown();
});

describe("Fastify E2E", () => {
  it("captures request, response, route template and consumer", async () => {
    const calls: Call[] = [];
    const fastify = app();
    await fastify.register(apiLensFastify, config(calls));
    fastify.post("/orders/:id", async (request, reply) => {
      setConsumer(request, { id: "user_123", name: "John", group: "starter" });
      const body = request.body as { item: string };
      reply.code(201);
      return { ok: true, item: body.item };
    });

    const response = await fastify.inject({
      method: "POST",
      url: "/orders/42?token=secret&page=2",
      headers: { "user-agent": "sdk-test", "x-forwarded-for": "1.2.3.4" },
      payload: { item: "book" },
    });
    expect(response.statusCode).toBe(201);
    expect(fastify.apilensClient).toBe(ApiLensClient.getInstance());
    await ApiLensClient.getInstance().flushAll();

    const records = sent(calls, "/v1/requests", "requests");
    expect(records).toHaveLength(1);
    const record = records[0];
    expect(record).toMatchObject({
      environment: "test",
      method: "POST",
      path: "/orders/{id}",
      raw_path: "/orders/42?token=[redacted]&page=2",
      status_code: 201,
      ip_address: "1.2.3.4",
      user_agent: "sdk-test",
      consumer_id: "user_123",
      consumer_name: "John",
      consumer_group: "starter",
    });
    expect(record.request_payload).toContain('"item":"book"');
    expect(record.response_payload).toBe('{"ok":true,"item":"book"}');
    expect(record.response_size).toBe(Buffer.byteLength(record.response_payload));
    expect(JSON.parse(record.response_headers)["content-type"]).toContain("application/json");
    expect(record.response_time_ms).toBeGreaterThanOrEqual(0);
  });

  it("parametrizes unmatched paths and skips OPTIONS and excluded paths", async () => {
    const calls: Call[] = [];
    const fastify = app();
    instrumentFastify(fastify, config(calls));
    fastify.options("/orders", async (_request, reply) => reply.code(204).send());
    fastify.get("/health", async () => ({ ok: true }));

    expect((await fastify.inject({ method: "OPTIONS", url: "/orders" })).statusCode).toBe(204);
    expect((await fastify.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    expect((await fastify.inject({ method: "GET", url: "/missing/123" })).statusCode).toBe(404);
    await ApiLensClient.getInstance().flushAll();

    const records = sent(calls, "/v1/requests", "requests");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      method: "GET",
      path: "/missing/{id}",
      raw_path: "/missing/123",
      status_code: 404,
    });
  });

  describe("tracing", () => {
    beforeEach(() => {
      delete process.env.APILENS_CAPTURE_SPANS;
    });
    afterEach(() => {
      process.env.APILENS_CAPTURE_SPANS = "false";
    });

    it("continues the trace into the handler after the body is parsed", async () => {
      const calls: Call[] = [];
      const fastify = app();
      await fastify.register(apiLensFastify, config(calls));
      fastify.post("/checkout", async () => ({ traceparent: currentTraceparent() }));

      const response = await fastify.inject({
        method: "POST",
        url: "/checkout",
        headers: { traceparent: `00-${TRACE_ID}-${PARENT_SPAN_ID}-01` },
        payload: { cart: 1 },
      });
      await ApiLensClient.getInstance().flushAll();

      const [record] = sent(calls, "/v1/requests", "requests");
      expect(record.trace_id).toBe(TRACE_ID);
      expect(response.json().traceparent).toBe(`00-${TRACE_ID}-${record.span_id}-01`);
      const [root] = sent(calls, "/v1/traces", "spans");
      expect(root).toMatchObject({
        name: "POST /checkout",
        kind: "server",
        parent_span_id: PARENT_SPAN_ID,
        span_id: record.span_id,
        status: "ok",
      });
    });

    it("sends an ERROR log with the stack of a thrown error", async () => {
      const calls: Call[] = [];
      const fastify = app();
      await fastify.register(apiLensFastify, config(calls));
      fastify.get("/boom/:id", async () => {
        throw new TypeError("card declined");
      });

      expect((await fastify.inject({ method: "GET", url: "/boom/7" })).statusCode).toBe(500);
      await ApiLensClient.getInstance().flushAll();

      const [record] = sent(calls, "/v1/requests", "requests");
      const logs = sent(calls, "/v1/logs", "logs");
      expect(record).toMatchObject({ path: "/boom/{id}", status_code: 500 });
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        level: "ERROR",
        message: "TypeError: card declined",
        endpoint_method: "GET",
        endpoint_path: "/boom/{id}",
        status_code: 500,
        trace_id: record.trace_id,
        span_id: record.span_id,
      });
      expect(logs[0].payload).toContain("fastify.e2e.test.ts");
    });
  });

  it("reports the app's routes in the metadata report", async () => {
    process.env.APILENS_SEND_METADATA = "true";
    try {
      const calls: Call[] = [];
      const fastify = app();
      await fastify.register(apiLensFastify, config(calls, { appId: "fastify-metadata-app" }));
      fastify.get("/orders/:id", async () => ({}));
      fastify.register(
        async (child) => {
          child.post("/users", async () => ({}));
        },
        { prefix: "/v1" },
      );
      await fastify.ready();

      const reports = () => calls.filter((c) => new URL(c.url).pathname === "/v1/metadata");
      await vi.waitFor(() => expect(reports()).toHaveLength(1), { timeout: 3000 });

      const [metadata] = reports();
      expect(validate(metadata.body, requestSchema("/v1/metadata"))).toEqual([]);
      expect(metadata.body).toMatchObject({
        app_id: "fastify-metadata-app",
        framework: "fastify",
        routes: [
          { method: "GET", path: "/orders/{id}" },
          { method: "POST", path: "/v1/users" },
        ],
      });
      expect(metadata.body.framework_version).toMatch(/^\d+\./);
    } finally {
      process.env.APILENS_SEND_METADATA = "false";
    }
  });
});

describe("fastifyPathToTemplate", () => {
  it("spells Fastify params as {name}", () => {
    expect(fastifyPathToTemplate("/users/:id")).toBe("/users/{id}");
    expect(fastifyPathToTemplate("/users/:id(^\\d+)/posts/:postId")).toBe("/users/{id}/posts/{postId}");
    expect(fastifyPathToTemplate("/files/*")).toBe("/files/{*}");
    expect(fastifyPathToTemplate("/")).toBe("/");
    expect(fastifyPathToTemplate(undefined)).toBeUndefined();
  });
});
