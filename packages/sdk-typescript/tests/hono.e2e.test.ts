import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiLensClient } from "../src/client.js";
import {
  apiLensHono,
  honoPathToTemplate,
  instrumentHono,
  setConsumer,
  type ApiLensHonoConfig,
} from "../src/hono.js";
import { currentTraceparent } from "../src/trace.js";
import { requestSchema, validate } from "./contract.js";

type Call = { url: string; body: Record<string, any> };

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const PARENT_SPAN_ID = "00f067aa0ba902b7";

function config(calls: Call[], extra: ApiLensHonoConfig = {}): ApiLensHonoConfig {
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

/** On Node the middleware records in the background once the body is read; wait for it. */
async function flushed(calls: Call[], count = 1): Promise<Array<Record<string, any>>> {
  await vi.waitFor(async () => {
    await ApiLensClient.getInstance().flushAll();
    expect(sent(calls, "/v1/requests", "requests").length).toBeGreaterThanOrEqual(count);
  });
  return sent(calls, "/v1/requests", "requests");
}

afterEach(async () => {
  await ApiLensClient.shutdown();
});

describe("Hono E2E (Node, background flush)", () => {
  it("captures request, response, route template and consumer", async () => {
    const calls: Call[] = [];
    const app = new Hono();
    const client = instrumentHono(app, config(calls));
    app.post("/orders/:id", async (c) => {
      setConsumer(c, { id: "user_123", name: "John", group: "starter" });
      const body = await c.req.json<{ item: string }>();
      return c.json({ ok: true, item: body.item }, 201);
    });

    const response = await app.request("/orders/42?token=secret&page=2", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "sdk-test",
        "x-forwarded-for": "1.2.3.4",
      },
      body: JSON.stringify({ item: "book" }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true, item: "book" });
    expect(client).toBe(ApiLensClient.getInstance());
    expect(client.config.flushMode).toBe("background");

    const [record] = await flushed(calls);
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
    expect(record.request_payload).toBe('{"item":"book"}');
    expect(record.response_payload).toBe('{"ok":true,"item":"book"}');
    expect(record.response_size).toBe(Buffer.byteLength(record.response_payload));
    expect(JSON.parse(record.response_headers)["content-type"]).toContain("application/json");
    expect(JSON.parse(record.request_headers)["user-agent"]).toBe("sdk-test");
  });

  it("resolves regex params, mounted sub-apps and getConsumer(c)", async () => {
    const calls: Call[] = [];
    const app = new Hono<{ Variables: { user: string } }>();
    app.use(
      "*",
      apiLensHono(
        config(calls, { getConsumer: (c) => (c as { get: (k: string) => unknown }).get("user") as string }),
      ),
    );
    app.use("*", async (c, next) => {
      c.set("user", "acme");
      await next();
    });
    const users = new Hono();
    users.get("/:userId{[0-9]+}/posts/:postId", (c) => c.text("ok"));
    app.route("/v1/users", users);

    expect((await app.request("/v1/users/9/posts/3")).status).toBe(200);
    const [record] = await flushed(calls);
    expect(record).toMatchObject({
      path: "/v1/users/{userId}/posts/{postId}",
      raw_path: "/v1/users/9/posts/3",
      consumer_id: "acme",
      response_payload: "ok",
    });
  });

  it("parametrizes 404s and catch-all middleware answers; skips OPTIONS and excluded paths", async () => {
    const calls: Call[] = [];
    const app = new Hono();
    instrumentHono(app, config(calls));
    app.use("/admin/*", async (c, next) => {
      if (!c.req.header("authorization")) {
        return c.json({ error: "unauthorized" }, 401);
      }
      await next();
    });
    app.get("/admin/users/:id", (c) => c.json({}));
    app.get("/health", (c) => c.json({ ok: true }));
    app.options("/orders", (c) => c.body(null, 204));

    expect((await app.request("/orders", { method: "OPTIONS" })).status).toBe(204);
    expect((await app.request("/health")).status).toBe(200);
    expect((await app.request("/missing/123")).status).toBe(404);
    expect((await app.request("/admin/users/123")).status).toBe(401);

    const records = await flushed(calls, 2);
    expect(records).toHaveLength(2);
    expect(records.map((r) => [r.path, r.status_code])).toEqual(
      expect.arrayContaining([
        ["/missing/{id}", 404],
        ["/admin/users/{id}", 401],
      ]),
    );
  });

  it("counts the bytes of a streamed response", async () => {
    const calls: Call[] = [];
    const app = new Hono();
    instrumentHono(app, config(calls));
    app.get("/stream", (c) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("hello "));
          controller.enqueue(new TextEncoder().encode("world"));
          controller.close();
        },
      });
      return c.body(stream, 200, { "content-type": "text/plain" });
    });

    expect(await (await app.request("/stream")).text()).toBe("hello world");
    const [record] = await flushed(calls);
    expect(record.response_payload).toBe("hello world");
    expect(record.response_size).toBe(11);
  });

  it("does not read the body of an uncaptured content type", async () => {
    const calls: Call[] = [];
    const app = new Hono();
    instrumentHono(app, config(calls));
    app.post("/upload", async (c) => {
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      return c.body(bytes, 200, { "content-type": "application/octet-stream" });
    });

    const response = await app.request("/upload", {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "content-length": "4" },
      body: new Uint8Array([1, 2, 3, 4]),
    });
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
    const [record] = await flushed(calls);
    expect(record.request_payload).toBe("[application/octet-stream, 4 bytes omitted]");
    expect(record.response_payload).toBe("[application/octet-stream, 4 bytes omitted]");
  });

  describe("tracing", () => {
    beforeEach(() => {
      delete process.env.APILENS_CAPTURE_SPANS;
    });
    afterEach(() => {
      process.env.APILENS_CAPTURE_SPANS = "false";
    });

    it("continues the incoming trace into the handler", async () => {
      const calls: Call[] = [];
      const app = new Hono();
      instrumentHono(app, config(calls));
      app.get("/checkout", async (c) => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return c.json({ traceparent: currentTraceparent() });
      });

      const response = await app.request("/checkout", {
        headers: { traceparent: `00-${TRACE_ID}-${PARENT_SPAN_ID}-01` },
      });
      const body = (await response.json()) as { traceparent: string };
      const [record] = await flushed(calls);
      expect(record.trace_id).toBe(TRACE_ID);
      expect(body.traceparent).toBe(`00-${TRACE_ID}-${record.span_id}-01`);
      const [root] = sent(calls, "/v1/traces", "spans");
      expect(root).toMatchObject({
        name: "GET /checkout",
        kind: "server",
        parent_span_id: PARENT_SPAN_ID,
        span_id: record.span_id,
      });
    });

    it("sends an ERROR log with the stack of a thrown error", async () => {
      const calls: Call[] = [];
      const app = new Hono();
      instrumentHono(app, config(calls));
      app.get("/boom/:id", () => {
        throw new TypeError("card declined");
      });
      app.onError((_err, c) => c.text("failed", 500));

      expect((await app.request("/boom/7")).status).toBe(500);
      const [record] = await flushed(calls);
      await ApiLensClient.getInstance().flushAll();
      const logs = sent(calls, "/v1/logs", "logs");
      expect(record).toMatchObject({ path: "/boom/{id}", status_code: 500 });
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        level: "ERROR",
        message: "TypeError: card declined",
        endpoint_path: "/boom/{id}",
        status_code: 500,
        trace_id: record.trace_id,
      });
      expect(logs[0].payload).toContain("hono.e2e.test.ts");
    });
  });

  it("reports the app's routes in the metadata report", async () => {
    process.env.APILENS_SEND_METADATA = "true";
    try {
      const calls: Call[] = [];
      const app = new Hono();
      instrumentHono(app, config(calls, { appId: "hono-metadata-app" }));
      app.get("/orders/:id", (c) => c.json({}));
      const api = new Hono();
      api.post("/users", (c) => c.json({}));
      app.route("/v1", api);

      const reports = () => calls.filter((c) => new URL(c.url).pathname === "/v1/metadata");
      await vi.waitFor(() => expect(reports()).toHaveLength(1), { timeout: 3000 });
      const [metadata] = reports();
      expect(validate(metadata.body, requestSchema("/v1/metadata"))).toEqual([]);
      expect(metadata.body).toMatchObject({
        app_id: "hono-metadata-app",
        framework: "hono",
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

describe("honoPathToTemplate", () => {
  it("spells Hono params as {name}", () => {
    expect(honoPathToTemplate("/users/:id")).toBe("/users/{id}");
    expect(honoPathToTemplate("/posts/:id{[0-9]+}/c/:slug{.+\\.png}")).toBe("/posts/{id}/c/{slug}");
    expect(honoPathToTemplate("/api/animal/:type?")).toBe("/api/animal/{type}");
    expect(honoPathToTemplate("/files/*")).toBe("/files/{*}");
    expect(honoPathToTemplate("/")).toBe("/");
    expect(honoPathToTemplate(undefined)).toBeUndefined();
  });
});
