import "reflect-metadata";

import {
  Body,
  Controller,
  Get,
  HttpCode,
  Module,
  Param,
  Post,
  Req,
  type INestApplication,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiLensClient } from "../src/client.js";
import { APILENS_CLIENT, ApiLensModule, setConsumer } from "../src/nestjs.js";
import type { ApiLensExpressConfig } from "../src/types.js";
import { requestSchema, validate } from "./contract.js";

type Call = { url: string; body: Record<string, any> };

const calls: Call[] = [];

function config(extra: ApiLensExpressConfig = {}): ApiLensExpressConfig {
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

function sent(path: string, key: string): Array<Record<string, any>> {
  return calls
    .filter((c) => new URL(c.url).pathname === path)
    .flatMap((c) => (c.body[key] || []) as Array<Record<string, any>>);
}

@Controller("orders")
class OrdersController {
  @Post(":id")
  @HttpCode(201)
  create(@Param("id") id: string, @Body() body: { item: string }, @Req() req: object) {
    setConsumer(req, { id: "user_123", name: "John", group: "starter" });
    return { ok: true, id, item: body.item };
  }

  @Get(":id/fail")
  fail(): never {
    throw new TypeError("card declined");
  }
}

const platforms = [
  { name: "express", adapter: () => new ExpressAdapter() },
  { name: "fastify", adapter: () => new FastifyAdapter() },
] as const;

let app: INestApplication | undefined;

async function start(
  adapter: ExpressAdapter | FastifyAdapter,
  extra: ApiLensExpressConfig = {},
): Promise<INestApplication> {
  @Module({ imports: [ApiLensModule.forRoot(config(extra))], controllers: [OrdersController] })
  class AppModule {}

  app = await NestFactory.create(AppModule, adapter, { logger: false });
  await app.init();
  if (adapter instanceof FastifyAdapter) {
    await adapter.getInstance().ready();
  }
  return app;
}

beforeEach(() => {
  calls.length = 0;
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  await ApiLensClient.shutdown();
});

describe.each(platforms)("NestJS on $name", ({ name, adapter }) => {
  it("captures request, response, route template and consumer", async () => {
    const nest = await start(adapter());
    expect(nest.get(APILENS_CLIENT)).toBe(ApiLensClient.getInstance());

    await request(nest.getHttpServer())
      .post("/orders/42?token=secret")
      .set("User-Agent", "sdk-test")
      .set("X-Forwarded-For", "1.2.3.4")
      .send({ item: "book" })
      .expect(201);
    await ApiLensClient.getInstance().flushAll();

    const records = sent("/v1/requests", "requests");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      method: "POST",
      path: "/orders/{id}",
      raw_path: "/orders/42?token=[redacted]",
      status_code: 201,
      ip_address: "1.2.3.4",
      user_agent: "sdk-test",
      consumer_id: "user_123",
      consumer_name: "John",
      consumer_group: "starter",
    });
    expect(records[0].request_payload).toContain('"item":"book"');
    expect(JSON.parse(records[0].response_payload)).toEqual({ ok: true, id: "42", item: "book" });
  });

  describe("tracing", () => {
    beforeEach(() => {
      delete process.env.APILENS_CAPTURE_SPANS;
    });
    afterEach(() => {
      process.env.APILENS_CAPTURE_SPANS = "false";
    });

    it("sends an ERROR log with the stack of a handler's error", async () => {
      const nest = await start(adapter());

      await request(nest.getHttpServer()).get("/orders/7/fail").expect(500);
      await ApiLensClient.getInstance().flushAll();

      const [record] = sent("/v1/requests", "requests");
      const logs = sent("/v1/logs", "logs");
      expect(record).toMatchObject({ path: "/orders/{id}/fail", status_code: 500 });
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        level: "ERROR",
        message: "TypeError: card declined",
        endpoint_path: "/orders/{id}/fail",
        trace_id: record.trace_id,
        span_id: record.span_id,
      });
      expect(logs[0].payload).toContain("nestjs.e2e.test.ts");
    });
  });

  it("reports framework nestjs and the controller routes", async () => {
    process.env.APILENS_SEND_METADATA = "true";
    try {
      const nest = await start(adapter(), { appId: `nest-metadata-${name}` });
      await request(nest.getHttpServer()).get("/orders/1/fail");

      const reports = () => calls.filter((c) => new URL(c.url).pathname === "/v1/metadata");
      await vi.waitFor(() => expect(reports()).toHaveLength(1), { timeout: 3000 });
      const [metadata] = reports();
      expect(validate(metadata.body, requestSchema("/v1/metadata"))).toEqual([]);
      expect(metadata.body.framework).toBe("nestjs");
      expect(metadata.body.framework_version).toMatch(/^\d+\./);
      expect(metadata.body.routes).toEqual(
        expect.arrayContaining([
          { method: "POST", path: "/orders/{id}" },
          { method: "GET", path: "/orders/{id}/fail" },
        ]),
      );
    } finally {
      process.env.APILENS_SEND_METADATA = "false";
    }
  });
});
