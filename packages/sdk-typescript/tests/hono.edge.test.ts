/**
 * The Hono adapter on an edge runtime, simulated: no `process.getBuiltinModule`
 * (so no Node builtin is found by feature detection) and a Cloudflare Workers
 * `navigator.userAgent`. Records must go out through inline flush mode (no
 * timers), gzip through `CompressionStream`, and the request's end-of-work
 * through `executionCtx.waitUntil`. This file never imports `src/node.ts`.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { requestSchema, validate } from "./contract.js";

type Call = { url: string; headers: Record<string, string>; body: Record<string, any> };

const proc = process as { getBuiltinModule?: unknown };
const originalGetBuiltinModule = proc.getBuiltinModule;

beforeAll(() => {
  proc.getBuiltinModule = undefined;
  vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
});

afterAll(() => {
  proc.getBuiltinModule = originalGetBuiltinModule;
  vi.unstubAllGlobals();
});

async function load() {
  const [{ Hono }, hono, client, runtime] = await Promise.all([
    import("hono"),
    import("../src/hono.js"),
    import("../src/client.js"),
    import("../src/runtime.js"),
  ]);
  return { Hono, hono, ApiLensClient: client.ApiLensClient, runtime };
}

function config(calls: Call[]) {
  return {
    apiKey: "test-api-key",
    appId: "edge-app",
    environment: "test",
    batchSize: 100,
    fetchImpl: async (url: string | URL | Request, options?: RequestInit) => {
      const headers = Object.fromEntries(new Headers(options?.headers).entries());
      const raw = options?.body;
      const text =
        headers["content-encoding"] === "gzip"
          ? gunzipSync(raw as Uint8Array).toString("utf8")
          : String(raw || "{}");
      calls.push({ url: String(url), headers, body: JSON.parse(text) });
      return new Response(null, { status: 202 });
    },
  };
}

function sent(calls: Call[], path: string, key: string): Array<Record<string, any>> {
  return calls
    .filter((c) => new URL(c.url).pathname === path)
    .flatMap((c) => (c.body[key] || []) as Array<Record<string, any>>);
}

function executionContext() {
  const pending: Array<Promise<unknown>> = [];
  return {
    pending,
    ctx: {
      waitUntil: (promise: Promise<unknown>) => {
        pending.push(promise);
      },
      passThroughOnException: () => undefined,
      props: {},
    },
  };
}

afterEach(async () => {
  const { ApiLensClient } = await load();
  await ApiLensClient.shutdown();
});

describe("Hono on an edge runtime", () => {
  it("finds no Node builtin and uses the Web fallbacks", async () => {
    const { runtime } = await load();
    expect(runtime.builtin("zlib")).toBeUndefined();
    expect(runtime.builtin("async_hooks")).toBeUndefined();
    expect(runtime.builtin("http")).toBeUndefined();
    expect(runtime.isEdgeRuntime()).toBe(true);
    expect(runtime.runtimeName()).toBe("workerd");
    expect(runtime.randomHex(8)).toMatch(/^[0-9a-f]{16}$/);
    expect(runtime.randomUUID()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const gz = await runtime.gzipText("hello edge", 6);
    expect(gunzipSync(gz).toString("utf8")).toBe("hello edge");
    const store = runtime.createContextStore<string>();
    expect(store).toBeInstanceOf(runtime.SyncContextStore);
    expect(store.run("ctx", () => store.getStore())).toBe("ctx");
    expect(store.getStore()).toBeUndefined();
  });

  it("flushes inline through waitUntil, gzipped, without timers", async () => {
    const { Hono, hono, ApiLensClient } = await load();
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    delete process.env.APILENS_CAPTURE_SPANS;
    try {
      const calls: Call[] = [];
      const app = new Hono();
      const client = hono.instrumentHono(app, config(calls));
      expect(client.config.flushMode).toBe("inline");
      app.post("/orders/:id", async (c) => {
        const body = await c.req.json<{ item: string }>();
        return c.json({ ok: true, item: body.item }, 201);
      });

      const { pending, ctx } = executionContext();
      const response = await app.request(
        "/orders/42",
        {
          method: "POST",
          headers: { "content-type": "application/json", "cf-connecting-ip": "9.9.9.9" },
          body: JSON.stringify({ item: "book" }),
        },
        {},
        ctx,
      );
      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({ ok: true, item: "book" });
      expect(pending).toHaveLength(1);
      await Promise.all(pending);

      const [record] = sent(calls, "/v1/requests", "requests");
      expect(record).toMatchObject({
        app_id: "edge-app",
        method: "POST",
        path: "/orders/{id}",
        status_code: 201,
        ip_address: "9.9.9.9",
        request_payload: '{"item":"book"}',
        response_payload: '{"ok":true,"item":"book"}',
      });
      expect(record.trace_id).toMatch(/^[0-9a-f]{32}$/);
      // The request span went out on the same inline flush.
      expect(sent(calls, "/v1/traces", "spans")).toMatchObject([
        { name: "POST /orders/{id}", kind: "server", trace_id: record.trace_id, span_id: record.span_id },
      ]);
      const requestsCall = calls.find((c) => new URL(c.url).pathname === "/v1/requests");
      expect(requestsCall?.headers["content-encoding"]).toBe("gzip");
      expect(ApiLensClient.getInstance().stats().queuedRecords).toBe(0);
      expect(setIntervalSpy).not.toHaveBeenCalled();
    } finally {
      setIntervalSpy.mockRestore();
      process.env.APILENS_CAPTURE_SPANS = "false";
    }
  });

  it("finishes before responding when the runtime has no waitUntil", async () => {
    const { Hono, hono } = await load();
    const calls: Call[] = [];
    const app = new Hono();
    app.use("*", hono.apiLensHono(config(calls)));
    app.get("/echo", (c) => c.text("pong"));

    expect(await (await app.request("/echo")).text()).toBe("pong");
    expect(sent(calls, "/v1/requests", "requests")).toMatchObject([
      { path: "/echo", status_code: 200, response_payload: "pong" },
    ]);
  });

  it("sends the heartbeat and metadata report on the inline flush, once", async () => {
    process.env.APILENS_SEND_HEARTBEAT = "true";
    process.env.APILENS_SEND_METADATA = "true";
    const { Hono, hono } = await load();
    try {
      const calls: Call[] = [];
      const app = new Hono();
      hono.instrumentHono(app, config(calls));
      app.get("/a", (c) => c.text("a"));

      for (let i = 0; i < 2; i += 1) {
        const { pending, ctx } = executionContext();
        await app.request("/a", {}, {}, ctx);
        await Promise.all(pending);
      }

      const paths = calls.map((c) => new URL(c.url).pathname);
      expect(paths.filter((p) => p === "/v1/heartbeat")).toHaveLength(1);
      expect(paths.filter((p) => p === "/v1/metadata")).toHaveLength(1);
      expect(sent(calls, "/v1/requests", "requests")).toHaveLength(2);
      const heartbeat = calls.find((c) => new URL(c.url).pathname === "/v1/heartbeat");
      expect(heartbeat?.body).toMatchObject({ app_id: "edge-app", runtime: "workerd" });
      expect(validate(heartbeat?.body, requestSchema("/v1/heartbeat"))).toEqual([]);
      const metadata = calls.find((c) => new URL(c.url).pathname === "/v1/metadata");
      expect(validate(metadata?.body, requestSchema("/v1/metadata"))).toEqual([]);
      expect(metadata?.body).toMatchObject({
        framework: "hono",
        routes: [{ method: "GET", path: "/a" }],
      });
    } finally {
      process.env.APILENS_SEND_HEARTBEAT = "false";
      process.env.APILENS_SEND_METADATA = "false";
    }
  });
});

describe("hono entry point imports", () => {
  const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

  /** Every src module reachable from `entry` through runtime (non-type) imports. */
  function runtimeImports(entry: string): { modules: Set<string>; external: Set<string> } {
    const modules = new Set<string>();
    const external = new Set<string>();
    const queue = [entry];
    const importRe = /^\s*(?:import|export)\s+(?!type\b)(?:[^'"]*?\sfrom\s+)?["']([^"']+)["']/gm;
    while (queue.length > 0) {
      const file = queue.pop() as string;
      if (modules.has(file)) {
        continue;
      }
      modules.add(file);
      const source = readFileSync(join(srcDir, file), "utf8");
      for (const match of source.matchAll(importRe)) {
        const spec = match[1];
        if (spec.startsWith("./")) {
          queue.push(spec.slice(2).replace(/\.js$/, ".ts"));
        } else {
          external.add(spec);
        }
      }
    }
    return { modules, external };
  }

  it("reaches no node: module and not the Node registration", () => {
    const { modules, external } = runtimeImports("hono.ts");
    expect(modules.has("capture.ts")).toBe(true);
    expect(modules.has("node.ts")).toBe(false);
    expect([...external]).toEqual([]);
  });

  it("is checked by the walker (the Node adapters do import node: modules)", () => {
    expect(runtimeImports("koa.ts").modules.has("node.ts")).toBe(true);
    expect([...runtimeImports("node.ts").external]).toContain("node:zlib");
  });
});
