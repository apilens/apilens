import { bodyParser } from "@koa/bodyparser";
import Router from "@koa/router";
import Koa from "koa";
import { Readable } from "node:stream";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiLensClient } from "../src/client.js";
import {
  apiLensKoa,
  instrumentKoa,
  koaRouteTemplate,
  listKoaRoutes,
  setConsumer,
  type ApiLensKoaConfig,
} from "../src/koa.js";
import { currentTraceparent } from "../src/trace.js";
import { requestSchema, validate } from "./contract.js";

type Call = { url: string; body: Record<string, any> };

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const PARENT_SPAN_ID = "00f067aa0ba902b7";

function config(calls: Call[], extra: ApiLensKoaConfig = {}): ApiLensKoaConfig {
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

function koa(): Koa {
  const app = new Koa();
  app.silent = true;
  return app;
}

/** Records are queued on the response's `finish`; wait for them. */
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

describe("Koa E2E", () => {
  it("captures request, response, route template and consumer", async () => {
    const calls: Call[] = [];
    const app = koa();
    const router = new Router();
    const middleware = apiLensKoa(config(calls));
    app.use(middleware);
    app.use(bodyParser());
    router.post("/orders/:id", (ctx) => {
      setConsumer(ctx, { id: "user_123", name: "John", group: "starter" });
      ctx.status = 201;
      ctx.body = { ok: true, item: (ctx.request.body as { item: string }).item };
    });
    app.use(router.routes());

    const response = await request(app.callback())
      .post("/orders/42?token=secret&page=2")
      .set("user-agent", "sdk-test")
      .set("x-forwarded-for", "1.2.3.4")
      .send({ item: "book" });
    expect(response.status).toBe(201);
    expect(middleware.apilensClient).toBe(ApiLensClient.getInstance());

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
    expect(record.request_payload).toContain('"item":"book"');
    expect(record.response_payload).toBe('{"ok":true,"item":"book"}');
    expect(record.response_size).toBe(Buffer.byteLength(record.response_payload));
    expect(JSON.parse(record.response_headers)["content-type"]).toContain("application/json");
  });

  it("uses the prefixed route of a nested router and getConsumer(ctx)", async () => {
    const calls: Call[] = [];
    const app = koa();
    const users = new Router({ prefix: "/v1/users" });
    users.get("/:userId/posts/:postId", (ctx) => {
      ctx.state.user = "acme";
      ctx.body = "ok";
    });
    instrumentKoa(app, config(calls, { getConsumer: (ctx) => (ctx as Koa.Context).state.user }));
    app.use(users.routes());

    expect((await request(app.callback()).get("/v1/users/9/posts/3")).status).toBe(200);
    expect(app.context.apilensClient).toBe(ApiLensClient.getInstance());

    const [record] = await flushed(calls);
    expect(record).toMatchObject({
      path: "/v1/users/{userId}/posts/{postId}",
      raw_path: "/v1/users/9/posts/3",
      consumer_id: "acme",
      response_payload: "ok",
    });
  });

  it("parametrizes unmatched paths and skips OPTIONS and excluded paths", async () => {
    const calls: Call[] = [];
    const app = koa();
    const router = new Router();
    app.use(apiLensKoa(config(calls)));
    router.get("/health", (ctx) => {
      ctx.body = { ok: true };
    });
    app.use(router.routes());
    app.use(router.allowedMethods());

    const agent = request(app.callback());
    await agent.options("/health");
    expect((await agent.get("/health")).status).toBe(200);
    expect((await agent.get("/missing/123")).status).toBe(404);

    const records = await flushed(calls);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      method: "GET",
      path: "/missing/{id}",
      raw_path: "/missing/123",
      status_code: 404,
    });
  });

  it("captures streamed response bodies", async () => {
    const calls: Call[] = [];
    const app = koa();
    app.use(apiLensKoa(config(calls)));
    app.use((ctx) => {
      ctx.type = "text/plain";
      ctx.body = Readable.from(["hello ", "world"]);
    });

    expect((await request(app.callback()).get("/stream")).text).toBe("hello world");
    const [record] = await flushed(calls);
    expect(record.response_payload).toBe("hello world");
    expect(record.response_size).toBe(11);
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
      const app = koa();
      const router = new Router();
      app.use(apiLensKoa(config(calls)));
      router.get("/checkout", async (ctx) => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        ctx.body = { traceparent: currentTraceparent() };
      });
      app.use(router.routes());

      const response = await request(app.callback())
        .get("/checkout")
        .set("traceparent", `00-${TRACE_ID}-${PARENT_SPAN_ID}-01`);
      const [record] = await flushed(calls);
      expect(record.trace_id).toBe(TRACE_ID);
      expect(response.body.traceparent).toBe(`00-${TRACE_ID}-${record.span_id}-01`);
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
      const app = koa();
      const router = new Router();
      app.use(apiLensKoa(config(calls)));
      router.get("/boom/:id", () => {
        throw new TypeError("card declined");
      });
      app.use(router.routes());

      expect((await request(app.callback()).get("/boom/7")).status).toBe(500);
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
      expect(logs[0].payload).toContain("koa.e2e.test.ts");
    });
  });

  it("reports the routers' routes in the metadata report", async () => {
    process.env.APILENS_SEND_METADATA = "true";
    try {
      const calls: Call[] = [];
      const app = koa();
      const router = new Router();
      const api = new Router({ prefix: "/v1" });
      app.use(apiLensKoa(config(calls, { appId: "koa-metadata-app", routers: [router, api] })));
      router.get("/orders/:id", (ctx) => {
        ctx.body = {};
      });
      api.post("/users", (ctx) => {
        ctx.body = {};
      });

      const reports = () => calls.filter((c) => new URL(c.url).pathname === "/v1/metadata");
      await vi.waitFor(() => expect(reports()).toHaveLength(1), { timeout: 3000 });
      const [metadata] = reports();
      expect(validate(metadata.body, requestSchema("/v1/metadata"))).toEqual([]);
      expect(metadata.body).toMatchObject({
        app_id: "koa-metadata-app",
        framework: "koa",
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

describe("koaRouteTemplate", () => {
  it("spells @koa/router params as {name}", () => {
    expect(koaRouteTemplate("/users/:id")).toBe("/users/{id}");
    expect(koaRouteTemplate("/files/*path")).toBe("/files/{path}");
    expect(koaRouteTemplate("/a{/:b}")).toBe("/a/{b}");
    expect(koaRouteTemplate(/regex/)).toBeUndefined();
    expect(koaRouteTemplate(undefined)).toBeUndefined();
  });

  it("lists routes without the implicit HEAD of a GET", () => {
    const router = new Router();
    router.get("/a/:id", () => undefined);
    router.put("/b", () => undefined);
    expect(listKoaRoutes([router])).toEqual([
      { method: "GET", path: "/a/{id}" },
      { method: "PUT", path: "/b" },
    ]);
  });
});
