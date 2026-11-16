import "reflect-metadata";

import Router from "@koa/router";
import { BadRequestException, Controller, Get, Module, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import express from "express";
import Fastify from "fastify";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import Koa from "koa";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiLensClient } from "../src/client.js";
import { useApiLens } from "../src/express.js";
import { apiLensFastify } from "../src/fastify.js";
import { instrumentHono } from "../src/hono.js";
import { apiLensKoa } from "../src/koa.js";
import { ApiLensModule } from "../src/nestjs.js";
import type { ApiLensExpressConfig } from "../src/types.js";

/**
 * Errors are never sampled (M5 D1) and the exception log does not depend on
 * span capture (D2), in every framework adapter: a handler that throws is
 * kept with its log whatever `sampleRate` says, a thrown error the app maps
 * to a 4xx sends a WARN log with the stack, and `APILENS_CAPTURE_SPANS=false`
 * still sends the log.
 */

type Call = { url: string; body: Record<string, any> };

/** `fail` throws a TypeError (answered 500); `bad` throws an error the app answers 400. */
type Route = "fail" | "bad";

type Harness = {
  /** Send `GET /<route>` and return the response status. */
  hit: (route: Route) => Promise<number>;
  close: () => Promise<void>;
};

function config(calls: Call[], extra: ApiLensExpressConfig = {}): ApiLensExpressConfig {
  return {
    apiKey: "test-api-key",
    appId: "test-app",
    environment: "test",
    batchSize: 1000,
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

function badRequest(): Error {
  return Object.assign(new RangeError("quantity must be positive"), { status: 400, statusCode: 400 });
}

async function expressApp(cfg: ApiLensExpressConfig): Promise<Harness> {
  const app = express();
  useApiLens(app, cfg);
  app.get("/fail", () => {
    throw new TypeError("card declined");
  });
  app.get("/bad", () => {
    throw badRequest();
  });
  app.use((err: { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status || 500).json({ error: "failed" });
  });
  return { hit: async (route) => (await request(app).get(`/${route}`)).status, close: async () => {} };
}

async function fastifyApp(cfg: ApiLensExpressConfig): Promise<Harness> {
  const fastify = Fastify();
  await fastify.register(apiLensFastify, cfg);
  fastify.get("/fail", async () => {
    throw new TypeError("card declined");
  });
  fastify.get("/bad", async () => {
    throw badRequest();
  });
  return {
    hit: async (route) => (await fastify.inject({ method: "GET", url: `/${route}` })).statusCode,
    close: () => fastify.close(),
  };
}

async function koaApp(cfg: ApiLensExpressConfig): Promise<Harness> {
  const app = new Koa();
  app.silent = true;
  const router = new Router();
  app.use(apiLensKoa(cfg));
  router.get("/fail", () => {
    throw new TypeError("card declined");
  });
  router.get("/bad", (ctx) => {
    ctx.throw(400, badRequest());
  });
  app.use(router.routes());
  return { hit: async (route) => (await request(app.callback()).get(`/${route}`)).status, close: async () => {} };
}

async function honoApp(cfg: ApiLensExpressConfig): Promise<Harness> {
  const app = new Hono();
  instrumentHono(app, cfg);
  app.get("/fail", () => {
    throw new TypeError("card declined");
  });
  app.get("/bad", () => {
    throw new HTTPException(400, { message: "quantity must be positive", cause: badRequest() });
  });
  return { hit: async (route) => (await app.request(`/${route}`)).status, close: async () => {} };
}

@Controller()
class FailController {
  @Get("fail")
  fail(): never {
    throw new TypeError("card declined");
  }

  @Get("bad")
  bad(): never {
    throw new BadRequestException("quantity must be positive");
  }
}

async function nestApp(cfg: ApiLensExpressConfig, adapter: ExpressAdapter | FastifyAdapter): Promise<Harness> {
  @Module({ imports: [ApiLensModule.forRoot(cfg)], controllers: [FailController] })
  class AppModule {}

  const app: INestApplication = await NestFactory.create(AppModule, adapter, { logger: false });
  await app.init();
  if (adapter instanceof FastifyAdapter) {
    await adapter.getInstance().ready();
  }
  return {
    hit: async (route) => (await request(app.getHttpServer()).get(`/${route}`)).status,
    close: () => app.close(),
  };
}

const adapters: Array<{ name: string; start: (cfg: ApiLensExpressConfig) => Promise<Harness> }> = [
  { name: "express", start: expressApp },
  { name: "fastify", start: fastifyApp },
  { name: "koa", start: koaApp },
  { name: "hono", start: honoApp },
  { name: "nestjs (express)", start: (cfg) => nestApp(cfg, new ExpressAdapter()) },
  { name: "nestjs (fastify)", start: (cfg) => nestApp(cfg, new FastifyAdapter()) },
];

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
  process.env.APILENS_CAPTURE_SPANS = "false";
  await ApiLensClient.shutdown();
});

/** Wait until the request record and its log were sent (Koa and Hono record after the response). */
async function delivered(calls: Call[]): Promise<{ record: Record<string, any>; logs: Array<Record<string, any>> }> {
  await vi.waitFor(async () => {
    await ApiLensClient.getInstance().flushAll();
    expect(sent(calls, "/v1/requests", "requests")).toHaveLength(1);
    expect(sent(calls, "/v1/logs", "logs").length).toBeGreaterThanOrEqual(1);
  });
  return { record: sent(calls, "/v1/requests", "requests")[0], logs: sent(calls, "/v1/logs", "logs") };
}

describe.each(adapters)("$name: errored requests", ({ start }) => {
  it("sampleRate 0 + a thrown error: the request is kept and the ERROR log sent", async () => {
    delete process.env.APILENS_CAPTURE_SPANS;
    const calls: Call[] = [];
    harness = await start(config(calls, { sampleRate: 0 }));

    expect(await harness.hit("fail")).toBe(500);
    const { record, logs } = await delivered(calls);

    expect(record).toMatchObject({ status_code: 500, sampled: true });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      level: "ERROR",
      message: "TypeError: card declined",
      logger_name: "apilens.exception",
      status_code: 500,
      trace_id: record.trace_id,
      span_id: record.span_id,
    });
    expect(logs[0].payload).toContain("errors.test.ts");
    const [root] = sent(calls, "/v1/traces", "spans");
    expect(root).toMatchObject({ kind: "server", status: "error", span_id: record.span_id });
  });

  it("a thrown error answered with a 4xx sends a WARN log with the stack", async () => {
    delete process.env.APILENS_CAPTURE_SPANS;
    const calls: Call[] = [];
    harness = await start(config(calls, { sampleRate: 0 }));

    expect(await harness.hit("bad")).toBe(400);
    const { record, logs } = await delivered(calls);

    expect(record).toMatchObject({ status_code: 400, sampled: true });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      level: "WARN",
      logger_name: "apilens.exception",
      status_code: 400,
      trace_id: record.trace_id,
    });
    expect(logs[0].message).toContain("quantity must be positive");
    expect(logs[0].payload).toContain("errors.test.ts");
  });

  it("with span capture off the exception log is still sent", async () => {
    process.env.APILENS_CAPTURE_SPANS = "false";
    const calls: Call[] = [];
    harness = await start(config(calls, { sampleRate: 0 }));

    expect(await harness.hit("fail")).toBe(500);
    const { record, logs } = await delivered(calls);

    expect(record).toMatchObject({ status_code: 500, sampled: true, trace_id: "" });
    expect(sent(calls, "/v1/traces", "spans")).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      level: "ERROR",
      message: "TypeError: card declined",
      trace_id: "",
      span_id: "",
    });
    expect(logs[0].payload).toContain("errors.test.ts");
  });
});

describe("remote policy", () => {
  it("enabled=false still turns capture off for a failed request", async () => {
    const calls: Call[] = [];
    harness = await expressApp(config(calls));
    const client = ApiLensClient.getInstance() as unknown as { remotePolicyState: unknown };
    client.remotePolicyState = {
      enabled: false,
      sampleRate: 1,
      captureHeaders: true,
      captureRequestBody: true,
      captureResponseBody: true,
      maxPayloadBytes: null,
    };

    expect(await harness.hit("fail")).toBe(500);
    await ApiLensClient.getInstance().flushAll();
    expect(calls).toEqual([]);
  });

  it("a remote sample rate of 0 never samples out a failed request", async () => {
    const calls: Call[] = [];
    harness = await expressApp(config(calls));
    const client = ApiLensClient.getInstance() as unknown as { remotePolicyState: unknown };
    client.remotePolicyState = {
      enabled: true,
      sampleRate: 0,
      captureHeaders: true,
      captureRequestBody: true,
      captureResponseBody: true,
      maxPayloadBytes: null,
    };

    expect(await harness.hit("bad")).toBe(400);
    const { record, logs } = await delivered(calls);
    expect(record.sampled).toBe(true);
    expect(logs[0].level).toBe("WARN");
  });
});
